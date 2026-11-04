import { network, sleep, type EventName, type Logger } from "@builderos/shared";
import {
  EVENTS_CHANNEL,
  agents,
  approvalCards,
  bountiesCache,
  companies,
  deadLetters,
  departments,
  events,
  getDb,
  indexerState,
  membersCache,
  railFloats,
  receipts,
  sql,
  type DB,
} from "@builderos/db";
import { blockAt, chunk, finalBlock, parseEventLog, txStatus } from "@builderos/near";
import { buildReceipt, scopeOf } from "./receipts.js";

export * from "./receipts.js";

export type IndexedEvent = {
  id: number;
  event: EventName;
  data: Record<string, any>;
  contract: string;
  companyId: string | null;
  departmentId: string | null;
  signer: string | null;
  nearTx: string;
  blockHeight: number;
  receiptRowId?: string;
};

export type IndexerOptions = { log: Logger; onEvent?: (e: IndexedEvent) => Promise<void>; batch?: number; idleMs?: number };

const isOurs = (account: string) => {
  const n = network();
  return account === n.factory || account.endsWith(`.${n.factory}`) || account === n.registry;
};

/**
 * Follows NEAR blocks by RPC polling, keeps only receipts from BuilderOS accounts, turns NEP-297 events
 * into rows + receipts + SSE messages. Stores the last processed height and replays from it after restart.
 */
export async function runIndexer(opts: IndexerOptions, signal?: AbortSignal) {
  const { log } = opts;
  const db = getDb();
  let last = await lastHeight(db);
  log.info({ from: last }, "indexer starting");

  while (!signal?.aborted) {
    try {
      const head = (await finalBlock()).header.height as number;
      if (last >= head) {
        await sleep(opts.idleMs ?? 1000);
        continue;
      }
      const to = Math.min(head, last + (opts.batch ?? 10));
      for (let h = last + 1; h <= to; h++) {
        await processBlock(h, opts);
        last = h;
      }
      await db
        .insert(indexerState)
        .values({ id: "near", lastBlockHeight: last })
        .onConflictDoUpdate({ target: indexerState.id, set: { lastBlockHeight: last, updatedAt: new Date() } });
      if (head - last > 50) log.warn({ lag: head - last }, "indexer behind");
    } catch (e: any) {
      log.error({ err: e?.message }, "indexer loop error");
      await sleep(3000);
    }
  }
}

async function lastHeight(db: DB) {
  const [row] = await db.select().from(indexerState).where(sql`${indexerState.id} = 'near'`);
  if (row) return row.lastBlockHeight;
  const start = Number(process.env.INDEXER_START_BLOCK ?? 0);
  if (start > 0) return start - 1;
  return ((await finalBlock()).header.height as number) - 1;
}

export async function processBlock(height: number, opts: IndexerOptions) {
  let block: any;
  try {
    block = await blockAt(height);
  } catch (e: any) {
    if (String(e?.message).includes("UNKNOWN_BLOCK")) return; // skipped height
    throw e;
  }
  for (const c of block.chunks as any[]) {
    if (c.height_included !== height) continue;
    const ch = await chunk(c.chunk_hash);
    const ours = (ch.transactions as any[]).filter((t) => isOurs(t.receiver_id) || isOurs(t.signer_id));
    for (const t of ours) {
      const status = await txStatus(t.hash, t.signer_id);
      await processTx(t.hash, t.signer_id, height, status, opts);
    }
  }
}

/** Parse all logs of one transaction and persist. Idempotent on (receipt_id, log_index). */
export async function processTx(txHash: string, signer: string, height: number, status: any, opts: IndexerOptions) {
  const db = getDb();
  const factory = network().factory;
  const outcomes: any[] = status.receipts_outcome ?? [];
  for (const o of outcomes) {
    const contract: string = o.outcome.executor_id;
    if (!isOurs(contract)) continue;
    const logs: string[] = o.outcome.logs ?? [];
    for (let i = 0; i < logs.length; i++) {
      const parsed = parseEventLog(logs[i]);
      if (!parsed) continue;
      if (!parsed.ok) {
        await db.insert(deadLetters).values({ contract, raw: parsed.raw, error: parsed.error, blockHeight: height, nearTx: txHash });
        opts.log.warn({ contract, err: parsed.error }, "dead-lettered event");
        continue;
      }
      const ev = parsed.value;
      for (let j = 0; j < ev.data.length; j++) {
        const data = ev.data[j] as Record<string, any>;
        const scope = scopeOf(contract, factory);
        const companyId = (data.company_id as string) ?? scope.companyId;
        const departmentId = (data.department_id as string) ?? scope.departmentId;
        const indexed = await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(events)
            .values({
              event: ev.event,
              standard: ev.standard,
              version: ev.version,
              contract,
              companyId,
              departmentId,
              data,
              receiptId: o.id,
              logIndex: i * 100 + j,
              blockHeight: height,
              nearTx: txHash,
            })
            .onConflictDoNothing()
            .returning({ id: events.id });
          if (!row) return null; // already indexed (replay)
          await applyToCaches(tx as unknown as DB, ev.event, data, { contract, companyId, departmentId, height, txHash, signer });
          const draft = buildReceipt(ev.event, data, signer);
          let receiptRowId: string | undefined;
          if (draft) {
            const [r] = await tx
              .insert(receipts)
              .values({ ...draft, companyId, departmentId, eventId: row.id, blockHeight: height, nearTx: txHash })
              .returning({ id: receipts.id });
            receiptRowId = r.id;
          }
          await tx.execute(sql`select pg_notify(${EVENTS_CHANNEL}, ${String(row.id)})`);
          return { id: row.id, receiptRowId };
        });
        if (indexed && opts.onEvent) {
          await opts
            .onEvent({ id: indexed.id, event: ev.event, data, contract, companyId, departmentId, signer, nearTx: txHash, blockHeight: height, receiptRowId: indexed.receiptRowId })
            .catch((e) => opts.log.error({ err: e?.message, event: ev.event }, "onEvent handler failed"));
        }
      }
    }
  }
}

type Ctx = { contract: string; companyId: string | null; departmentId: string | null; height: number; txHash: string; signer: string };

/** Update the read caches. Postgres is a cache: money and permissions are always re-read from NEAR before acting. */
async function applyToCaches(db: DB, event: EventName, d: Record<string, any>, c: Ctx) {
  const chain = { blockHeight: c.height, nearTx: c.txHash };
  switch (event) {
    case "company_created":
      await db
        .insert(companies)
        .values({ id: d.company_id, accountId: d.company_id, name: d.name, preset: d.preset, network: network().id, founderAccount: d.founder, ...chain })
        .onConflictDoNothing();
      break;
    case "department_created":
      await db
        .insert(departments)
        .values({ id: d.department_id, companyId: d.company_id, accountId: d.department_id, name: d.name, contractHash: d.contract_hash, baseAddress: d.base_address ?? null, ...chain })
        .onConflictDoNothing();
      break;
    case "agent_registered":
      await db
        .insert(agents)
        .values({ publicKey: d.public_key, accountId: d.account_id ?? null, departmentId: d.department_id, role: d.role, maxTier: d.max_tier, ...chain })
        .onConflictDoUpdate({ target: agents.publicKey, set: { role: d.role, maxTier: d.max_tier, status: "active" } });
      break;
    case "grant_set":
      await db
        .insert(membersCache)
        .values({
          accountId: d.account_id,
          departmentId: d.department_id,
          companyId: c.companyId,
          scopes: d.scopes,
          limit: d.limit ?? null,
          expiresAt: d.expires_at ? new Date(Number(d.expires_at)) : null,
          revoked: false,
          ...chain,
        })
        .onConflictDoUpdate({
          target: [membersCache.accountId, membersCache.departmentId],
          set: { scopes: d.scopes, limit: d.limit ?? null, expiresAt: d.expires_at ? new Date(Number(d.expires_at)) : null, revoked: false, ...chain },
        });
      break;
    case "grant_revoked":
      await db.execute(
        sql`update members_cache set revoked = true, block_height = ${c.height}, near_tx = ${c.txHash}
            where account_id = ${d.account_id} and (${d.department_id ?? null}::text is null or department_id = ${d.department_id ?? null})`,
      );
      break;
    case "view_key_registered":
      await db.execute(sql`update members_cache set view_key = ${d.x25519_public_key} where account_id = ${d.account_id}`);
      break;
    case "code_key_rotated":
      await db.execute(sql`update companies set code_key_version = ${d.version} where id = ${d.company_id}`);
      break;
    case "frozen":
    case "unfrozen": {
      const v = event === "frozen";
      if (c.departmentId) await db.execute(sql`update departments set frozen = ${v} where id = ${c.departmentId}`);
      else if (c.companyId) await db.execute(sql`update companies set frozen = ${v} where id = ${c.companyId}`);
      break;
    }
    case "float_set":
      await db
        .insert(railFloats)
        .values({ departmentId: d.department_id, rail: d.rail, target: d.target ?? null, enabled: d.enabled ?? true })
        .onConflictDoUpdate({ target: [railFloats.departmentId, railFloats.rail], set: { target: d.target ?? null, enabled: d.enabled ?? true, updatedAt: new Date() } });
      break;
    case "bounty_created":
    case "agent_hired":
      await db
        .insert(bountiesCache)
        .values({
          taskId: d.task_id,
          bountyId: d.bounty_id ?? null,
          payee: d.payee ?? null,
          amount: d.amount ?? null,
          currency: d.currency ?? d.token ?? null,
          rail: d.rail ?? null,
          agentId: d.agent_id ?? null,
          status: "reserved",
          ...chain,
        })
        .onConflictDoUpdate({
          target: bountiesCache.taskId,
          set: {
            bountyId: d.bounty_id ?? null,
            payee: d.payee ?? null,
            amount: d.amount ?? null,
            currency: d.currency ?? d.token ?? null,
            rail: d.rail ?? null,
            agentId: d.agent_id ?? null,
            status: "reserved",
            ...chain,
          },
        });
      break;
    case "bounty_released":
    case "bounty_voided":
      await db
        .insert(bountiesCache)
        .values({
          taskId: d.task_id,
          bountyId: d.bounty_id ?? null,
          payee: d.payee ?? null,
          amount: d.amount ?? null,
          currency: d.currency ?? d.token ?? null,
          rail: d.rail ?? null,
          agentId: d.agent_id ?? null,
          status: event === "bounty_released" ? "released" : "voided",
          verdict: d.verdict,
          logHash: d.log_hash,
          ...chain,
        })
        .onConflictDoUpdate({
          target: bountiesCache.taskId,
          set: {
            status: event === "bounty_released" ? "released" : "voided",
            verdict: d.verdict,
            logHash: d.log_hash,
            amount: d.amount ?? null,
            currency: d.currency ?? d.token ?? null,
          },
        });
      break;
    case "purchase_yielded": {
      if (!c.companyId) break;
      if (d.reason === "daily_cap") {
        // One daily-cap card per company per day; new requests join it.
        const day = new Date().toISOString().slice(0, 10);
        await db.execute(sql`
          insert into approval_cards (company_id, kind, day, request_ids, amount, status)
          values (${c.companyId}, 'daily-cap', ${day}, ${JSON.stringify([d.request_id])}::jsonb, ${d.amount ?? 0}, 'pending')
          on conflict (company_id, kind, day) do update
            set request_ids = approval_cards.request_ids || ${JSON.stringify([d.request_id])}::jsonb,
                amount = coalesce(approval_cards.amount, 0) + ${d.amount ?? 0}`);
      } else {
        await db.insert(approvalCards).values({
          companyId: c.companyId,
          kind: d.reason === "seller_choice" ? "seller" : "single",
          requestIds: [d.request_id],
          amount: d.amount ?? null,
          payload: d,
        });
      }
      break;
    }
    case "purchase_approved":
    case "purchase_rejected":
      await db.execute(
        sql`update approval_cards set status = ${event === "purchase_approved" ? "approved" : "rejected"}, decided_by = ${c.signer}
            where request_ids @> ${JSON.stringify([d.request_id])}::jsonb and status = 'pending'`,
      );
      break;
    case "topup_recorded":
      break;
    default:
      break;
  }
}

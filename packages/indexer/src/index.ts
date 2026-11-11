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
import { blockAt, chunk, finalBlock, parseEventLog, txStatus, views } from "@builderos/near";
import { buildReceipt, scopeOf } from "./receipts.js";

export * from "./receipts.js";
export * from "./deposits.js";
export * from "./backfill.js";
import { collectBuilderOsTxs, txIndexUrl } from "./backfill.js";

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
  // The block archive answers one request per block, so it can go much wider than raw RPC.
  // Gentle by default: the free archive throttles shared IPs (Heroku). Steady state needs ~2 blocks/s.
  const batch = opts.batch ?? Number(process.env.INDEXER_BATCH ?? (neardataUrl() ? 30 : 40));
  const concurrency = Number(process.env.INDEXER_CONCURRENCY ?? 2);
  let throttled = 0; // consecutive loops that failed with HTTP 429
  log.info({ from: last, batch, concurrency, source: neardataUrl() ?? "rpc" }, "indexer starting");
  const failures = new Map<string, number>();

  while (!signal?.aborted) {
    try {
      // Never read past what the archive has: a height it doesn't have yet is not an empty block.
      // The archive reports its own final head, so steady-state indexing makes no RPC calls at all
      // (public RPCs answer 429 to shared Heroku IPs). RPC is only the fallback.
      const archiveHead = neardataUrl() ? await archiveFinalHeight().catch(() => null) : null;
      const head = archiveHead ?? ((await finalBlock()).header.height as number);
      // Far behind: catch up from the transaction index (only BuilderOS accounts), then jump to the head.
      const threshold = Number(process.env.INDEXER_BACKFILL_THRESHOLD ?? 2_000);
      // Also when the archive keeps throttling us: the tx index covers the gap for BuilderOS accounts only.
      if (txIndexUrl() && head > last && (head - last > threshold || throttled >= 2)) {
        try {
          // Start a little earlier so callbacks of transactions sent just before `last` are covered (replays are no-ops).
          const txs = await collectBuilderOsTxs(Math.max(0, last - 120), head, log);
          for (const t of txs) await processTx(t.hash, t.signer, t.height, t.status, opts);
          log.info({ from: last, to: head, txs: txs.length, reason: throttled >= 2 ? "archive_throttled" : "far_behind" }, "tx-index backfill done");
          if (throttled >= 2) await sleep(5_000); // poll the tx index gently while the archive cools down
          throttled = Math.max(0, throttled - 1);
          // Safety margin: the tx index trails the chain by a few seconds, so a very recent transaction may
          // not be listed yet. Keep the cursor `margin` blocks behind the head; the next round re-reads from
          // `last - 120`, so every block is read again once it is at least `margin` blocks old. Events still
          // reach the app as soon as the index lists them (replays are no-ops).
          const margin = Number(process.env.INDEXER_TXINDEX_MARGIN ?? 60);
          last = Math.max(last, head - margin);
          await db
            .insert(indexerState)
            .values({ id: "near", lastBlockHeight: last })
            .onConflictDoUpdate({ target: indexerState.id, set: { lastBlockHeight: last, updatedAt: new Date() } });
          continue;
        } catch (e: any) {
          log.error({ err: e?.message }, "tx-index backfill failed; scanning blocks instead");
        }
      }
      if (last >= head) {
        await sleep(opts.idleMs ?? 1000);
        continue;
      }
      const to = Math.min(head, last + batch);
      const heights = Array.from({ length: to - last }, (_, i) => last + 1 + i);
      // Fetch (RPC-bound) in parallel, then write strictly in block order so replay stays deterministic.
      const fetched = await mapLimit(heights, concurrency, fetchBlock);
      for (let i = 0; i < heights.length; i++) {
        for (const t of fetched[i]) {
          try {
            await processTx(t.hash, t.signer, heights[i], t.status, opts);
            failures.delete(t.hash);
          } catch (e: any) {
            // One bad transaction must never stall the indexer: after 5 tries, dead-letter it and move on.
            const n = (failures.get(t.hash) ?? 0) + 1;
            failures.set(t.hash, n);
            if (n < 5) throw e;
            failures.delete(t.hash);
            log.error({ tx: t.hash, height: heights[i], err: e?.message }, "skipping transaction after 5 failures");
            await db.insert(deadLetters).values({ contract: "indexer", raw: JSON.stringify({ tx: t.hash, height: heights[i] }), error: String(e?.message ?? e).slice(0, 2000), blockHeight: heights[i], nearTx: t.hash });
          }
        }
        last = heights[i];
      }
      await db
        .insert(indexerState)
        .values({ id: "near", lastBlockHeight: last })
        .onConflictDoUpdate({ target: indexerState.id, set: { lastBlockHeight: last, updatedAt: new Date() } });
      throttled = 0;
      if (head - last > 50) log.warn({ lag: head - last }, "indexer behind");
    } catch (e: any) {
      if (String(e?.message).includes("429")) throttled++;
      else throttled = 0;
      log.error({ err: e?.message, throttled }, "indexer loop error");
      await sleep(3000);
    }
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

async function lastHeight(db: DB) {
  const [row] = await db.select().from(indexerState).where(sql`${indexerState.id} = 'near'`);
  if (row) return row.lastBlockHeight;
  const start = Number(process.env.INDEXER_START_BLOCK ?? 0);
  if (start > 0) return start - 1;
  return ((await finalBlock()).header.height as number) - 1;
}

type BlockTx = { hash: string; signer: string; status: any };

/**
 * FastNEAR block archive (neardata): one request returns the block with every receipt outcome and its
 * logs, so catching up costs 1 request per block instead of block + chunks + tx_status per transaction.
 * NEARDATA_URL="" turns it off (RPC only).
 */
export function neardataUrl(): string | null {
  const v = process.env.NEARDATA_URL ?? (network().id === "mainnet" ? "https://mainnet.neardata.xyz" : "https://testnet.neardata.xyz");
  return v ? v.replace(/\/$/, "") : null;
}

/** Receipts executed on BuilderOS accounts in this block, grouped per transaction (same shape processTx reads). */
export async function fetchBlockNeardata(height: number, base: string): Promise<BlockTx[]> {
  const key = process.env.NEARDATA_API_KEY; // optional FastNEAR key for higher rate limits
  const res = await fetch(`${base}/v0/block/${height}${key ? `?apiKey=${encodeURIComponent(key)}` : ""}`, { signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return []; // skipped height
  if (!res.ok) throw new Error(`neardata ${res.status} at ${height}`);
  const body: any = await res.json();
  if (!body) return []; // skipped height (null body)
  const byTx = new Map<string, BlockTx>();
  for (const shard of body.shards ?? [])
    for (const ro of shard.receipt_execution_outcomes ?? []) {
      const o = ro.execution_outcome;
      if (!isOurs(o?.outcome?.executor_id ?? "")) continue;
      const hash: string = ro.tx_hash ?? o.id;
      const signer: string = ro.receipt?.receipt?.Action?.signer_id ?? ro.receipt?.predecessor_id ?? "";
      const t = byTx.get(hash) ?? { hash, signer, status: { receipts_outcome: [] as any[] } };
      t.status.receipts_outcome.push({ id: o.id, outcome: o.outcome });
      byTx.set(hash, t);
    }
  return [...byTx.values()];
}

/** Latest final height the archive serves. */
export async function archiveFinalHeight(): Promise<number | null> {
  const base = neardataUrl();
  if (!base) return null;
  const res = await fetch(`${base}/v0/last_block/final`, { signal: AbortSignal.timeout(10_000), redirect: "follow" });
  if (!res.ok) return null;
  const b: any = await res.json();
  const h = Number(b?.block?.header?.height);
  return Number.isFinite(h) ? h : null;
}

/** Archive first, raw RPC as fallback. */
export async function fetchBlock(height: number): Promise<BlockTx[]> {
  const base = neardataUrl();
  if (!base) return fetchBlockTxs(height);
  // No per-block RPC fallback: the RPC path finds only transactions *submitted* in this block, so it would
  // miss callbacks of earlier ones. Retry the archive; if it keeps failing the batch is retried later.
  let err: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return await fetchBlockNeardata(height, base);
    } catch (e: any) {
      err = e;
      const limited = String(e?.message).includes(" 429 ");
      await sleep((limited ? 1500 : 400) * 2 ** i * (0.75 + Math.random() / 2)); // back off, with jitter
    }
  }
  throw err;
}

/** Transactions in this block that touch BuilderOS accounts, with their final outcomes. */
export async function fetchBlockTxs(height: number): Promise<BlockTx[]> {
  let block: any;
  try {
    block = await blockAt(height);
  } catch (e: any) {
    if (String(e?.message).includes("UNKNOWN_BLOCK")) return []; // skipped height
    throw e;
  }
  const chunks = (block.chunks as any[]).filter((c) => c.height_included === height && c.tx_root !== "11111111111111111111111111111111");
  const lists = await Promise.all(chunks.map((c) => chunk(c.chunk_hash)));
  const ours = lists.flatMap((ch) => (ch.transactions as any[]).filter((t) => isOurs(t.receiver_id) || isOurs(t.signer_id)));
  return Promise.all(ours.map(async (t) => ({ hash: t.hash as string, signer: t.signer_id as string, status: await txStatus(t.hash, t.signer_id) })));
}

export async function processBlock(height: number, opts: IndexerOptions) {
  for (const t of await fetchBlock(height)) await processTx(t.hash, t.signer, height, t.status, opts);
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
    case "department_created": {
      // The company row normally comes from company_created; if that event was missed (e.g. a create whose
      // factory callback failed), read the company from chain so the team row's foreign key holds.
      const has = await db.execute(sql`select 1 from companies where id = ${d.company_id}`);
      if (!has.rows.length) {
        const co = await views.getCompany(d.company_id).catch(() => null);
        await db
          .insert(companies)
          .values({ id: d.company_id, accountId: d.company_id, name: co?.name ?? null, network: network().id, founderAccount: co?.founder ?? "unknown", ...chain })
          .onConflictDoNothing();
      }
      await db
        .insert(departments)
        .values({ id: d.department_id, companyId: d.company_id, accountId: d.department_id, name: d.name, contractHash: d.contract_hash, baseAddress: d.base_address ?? null, ...chain })
        .onConflictDoNothing();
      break;
    }
    case "agent_registered":
      await db
        .insert(agents)
        .values({ publicKey: d.public_key, accountId: d.account_id ?? null, departmentId: d.department_id, role: d.role, maxTier: d.max_tier, ...chain })
        .onConflictDoUpdate({ target: agents.publicKey, set: { role: d.role, maxTier: d.max_tier, status: "active" } });
      break;
    case "agent_fired":
      await db.execute(sql`update agents set status = 'fired' where public_key = ${d.public_key}`);
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
      // Emitted by the company contract; the founder has no members_cache row, so keep keys in view_keys.
      if (c.companyId)
        await db.execute(sql`insert into view_keys (account_id, company_id, x25519_public_key, near_tx, block_height, updated_at)
          values (${d.account_id}, ${c.companyId}, ${d.x25519_public_key}, ${c.txHash}, ${c.height}, now())
          on conflict (account_id, company_id) do update set x25519_public_key = excluded.x25519_public_key,
            near_tx = excluded.near_tx, block_height = excluded.block_height, updated_at = now()
          where view_keys.block_height is null or view_keys.block_height <= excluded.block_height`);
      await db.execute(sql`update members_cache set view_key = ${d.x25519_public_key} where account_id = ${d.account_id} and company_id = ${c.companyId}`);
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
          kind: d.reason === "seller_choice" || d.reason === "new_seller" ? "seller" : "single",
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

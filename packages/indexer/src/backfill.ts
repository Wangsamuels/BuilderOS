import { network, sleep, type Logger } from "@builderos/shared";
import { getDb, sql } from "@builderos/db";
import { parseEventLog } from "@builderos/near";

/**
 * Fast catch-up when the indexer is far behind: instead of reading every block, ask FastNEAR's
 * transaction index for the transactions of BuilderOS accounts only (factory, registry, every company
 * and team — new ones are discovered from company_created / department_created logs), with full receipts.
 * The caller processes them in block order with the normal processTx, then continues block by block.
 */
export function txIndexUrl(): string | null {
  const v = process.env.FASTNEAR_TX_URL ?? (network().id === "mainnet" ? "https://tx.main.fastnear.com" : "https://tx.test.fastnear.com");
  return v ? v.replace(/\/$/, "") : null;
}

type IndexedTx = { hash: string; signer: string; height: number; status: { receipts_outcome: Array<{ id: string; outcome: any }> } };

async function post(path: string, body: unknown) {
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${txIndexUrl()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return res.json() as Promise<any>;
    if (res.status !== 429 && res.status < 500) throw new Error(`tx index ${path} ${res.status}`);
    await sleep(1000 * 2 ** i);
  }
  throw new Error(`tx index ${path} kept failing`);
}

/** Transaction hashes touching one account with from < height ≤ to (newest first, paginated). */
async function accountTxs(account: string, from: number, to: number) {
  const out = new Map<string, number>();
  let max: number | null = to;
  const seen = new Set<string>();
  for (let page = 0; page < 200 && max !== null; page++) {
    const j = await post("/v0/account", { account_id: account, max_block_height: max });
    const rows: Array<{ transaction_hash: string; tx_block_height: number }> = j.account_txs ?? [];
    let fresh = 0;
    for (const r of rows) {
      if (seen.has(r.transaction_hash)) continue;
      seen.add(r.transaction_hash);
      fresh++;
      if (r.tx_block_height > from && r.tx_block_height <= to) out.set(r.transaction_hash, r.tx_block_height);
    }
    // The index may return the whole history at once (ignoring max_block_height): stop when a page adds
    // nothing new, when everything is listed, or when we've gone below `from`.
    const lowest = rows.length ? Math.min(...rows.map((r) => r.tx_block_height)) : null;
    const total = Number(j.txs_count ?? 0);
    max = fresh > 0 && seen.size < total && lowest !== null && lowest > from ? lowest - 1 : null;
  }
  return out;
}

export async function collectBuilderOsTxs(from: number, to: number, log: Logger): Promise<IndexedTx[]> {
  const n = network();
  const known = await getDb()
    .execute<{ id: string }>(sql`select id from companies union select id from departments`)
    .then((r) => r.rows.map((x) => x.id))
    .catch(() => [] as string[]);
  const queue = [n.factory, n.registry, ...known];
  const seen = new Set<string>();
  const txs = new Map<string, IndexedTx>();
  while (queue.length) {
    const account = queue.shift()!;
    if (seen.has(account)) continue;
    seen.add(account);
    const hashes = [...(await accountTxs(account, from, to)).keys()].filter((h) => !txs.has(h));
    for (let i = 0; i < hashes.length; i += 20) {
      const j = await post("/v0/transactions", { tx_hashes: hashes.slice(i, i + 20) });
      for (const t of j.transactions ?? []) {
        const receipts: any[] = t.receipts ?? [];
        const tx: IndexedTx = {
          hash: t.transaction.hash,
          signer: t.transaction.signer_id,
          height: Math.min(...receipts.map((r) => Number(r.execution_outcome.block_height)).filter(Number.isFinite)),
          status: { receipts_outcome: receipts.map((r) => ({ id: r.execution_outcome.id, outcome: r.execution_outcome.outcome })) },
        };
        txs.set(tx.hash, tx);
        // Discover companies and teams created in this window.
        for (const r of receipts)
          for (const l of r.execution_outcome.outcome.logs ?? []) {
            const p = parseEventLog(l);
            if (!p?.ok) continue;
            for (const d of p.value.data as any[]) {
              if (p.value.event === "company_created" && d.company_id) queue.push(d.company_id);
              if (p.value.event === "department_created" && d.department_id) queue.push(d.department_id);
            }
          }
      }
    }
  }
  log.info({ from, to, accounts: seen.size, txs: txs.size }, "tx-index backfill collected");
  return [...txs.values()].sort((a, b) => a.height - b.height);
}

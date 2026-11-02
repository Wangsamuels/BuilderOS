import { createPublicClient, http, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";
import { env, network, type Logger } from "@builderos/shared";
import { eq, getDb, receipts, sql } from "@builderos/db";
import { callAs, serviceAccount, serviceCalls } from "@builderos/near";

/**
 * NEAR can't verify a foreign tx itself, so a purchase receipt is a signed claim the verifier checks
 * on the Base or Tempo explorer RPC. A failed check flags the receipt in the Ledger.
 */

function clientFor(chainId: string | null, rail: string | null) {
  const n = network();
  if (rail?.startsWith("mpp-tempo") || chainId === "tempo") {
    if (!n.tempo.rpcUrl) return null;
    return createPublicClient({ transport: http(n.tempo.rpcUrl) });
  }
  return createPublicClient({ chain: env().NETWORK === "testnet" ? baseSepolia : base, transport: http(n.base.rpcUrl) });
}

export async function verifyReceipt(receiptId: string, log: Logger) {
  const db = getDb();
  const [r] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
  if (!r || !r.foreignTx || r.verifiedOnChain !== null) return;
  if (env().USE_SELLER_MESH && r.foreignTx.startsWith("0xmock")) {
    await db.update(receipts).set({ verifiedOnChain: true }).where(eq(receipts.id, receiptId));
    return;
  }
  // The settled receipt carries the tx; the signed receipt (same request) carries rail + chain.
  const sibling = r.requestId
    ? (await db.execute<{ rail: string | null; chain_id: string | null }>(sql`select rail, chain_id from receipts where request_id = ${r.requestId} and rail is not null limit 1`)).rows[0]
    : undefined;
  const client = clientFor(r.chainId ?? sibling?.chain_id ?? null, r.rail ?? sibling?.rail ?? null);
  if (!client) return;
  try {
    const rc = await client.getTransactionReceipt({ hash: r.foreignTx as Hex });
    const ok = rc.status === "success";
    await db.update(receipts).set({ verifiedOnChain: ok, verifyError: ok ? null : "reverted" }).where(eq(receipts.id, receiptId));
  } catch (e: any) {
    const notFound = /could not be found|not found/i.test(e?.message ?? "");
    if (!notFound) throw e; // RPC flake: job retries
    await db.update(receipts).set({ verifiedOnChain: false, verifyError: "tx not found" }).where(eq(receipts.id, receiptId));
    log.warn({ receipt: receiptId }, "foreign tx not found; receipt flagged");
  }
}

/** The verifier key can only submit_verdict (it can't pay). Releases or voids the task bounty. */
export async function submitVerdict(p: { departmentId: string; taskId: string; verdict: "pass" | "fail"; logHash: string }) {
  const e = env();
  if (!e.VERIFIER_ACCOUNT_ID || !e.VERIFIER_PRIVATE_KEY) throw new Error("verifier key not configured");
  const acc = await serviceAccount(e.VERIFIER_ACCOUNT_ID, e.VERIFIER_PRIVATE_KEY);
  return callAs(acc, serviceCalls.submitVerdict(p.departmentId, p));
}

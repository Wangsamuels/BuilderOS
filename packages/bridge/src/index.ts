import { randomUUID } from "node:crypto";
import { env, network, relayBaseUrl, toBig, type Logger } from "@builderos/shared";
import { and, bridgeTransfers, departments, eq, getDb, railFloats, sql, withdrawals } from "@builderos/db";
import { callAs, serviceAccount, serviceCalls } from "@builderos/near";

/**
 * Bridge worker: keeps each department's Tempo pocket topped up and executes withdrawals.
 * Holds a record-only worker key: request_rail_topup / record_* — it can't pay.
 *
 * Tempo MPP path (services outside x402): Intents USDC → Base (1Click) → Tempo USDC.e (Relay).
 * Models stay on Base USDC x402 and do not use this bridge.
 */

export const MIN_TOPUP = 10_000_000n; // $10 (USDC 6dp)
export const MAX_FEE_BPS = 100n; // 1%
export const MAX_TOPUPS_PER_DAY = 2;

export type Quote = { quoteId: string; amountIn: string; amountOut: string; depositAddress: string; fees: string; deadline?: string | null; steps?: unknown };

/** Chains a founder can withdraw to, and 1Click's name for each. */
export const WITHDRAWAL_CHAINS = { near: "near", base: "base", ethereum: "eth", arbitrum: "arb", solana: "sol" } as const;
export type WithdrawalChain = keyof typeof WITHDRAWAL_CHAINS;
/**
 * USDC per chain as a 1Click asset id. The live list (GET /v0/tokens) is the source of truth; these are the
 * known ids, used when that list can't be read.
 */
const USDC_ASSET_FALLBACK: Record<WithdrawalChain, string> = {
  near: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  base: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  ethereum: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
  arbitrum: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  solana: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
};
let tokenCache: { at: number; byChain: Map<string, string> } | null = null;
const oneClickHeaders = (): Record<string, string> => {
  const jwt = env().ONECLICK_JWT;
  return { "content-type": "application/json", ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) };
};
export type SwapStatus = { state: "pending" | "success" | "refunded" | "failed"; raw: string; amountOut: string | null; destTx: string | null };

function relayHeaders(): Record<string, string> {
  const key = env().RELAY_API_KEY;
  return { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) };
}

/** Map Relay intent status → our bridge row status. */
export function mapRelayStatus(raw: string | undefined): "pending" | "success" | "failure" | "refund" {
  const s = (raw ?? "pending").toLowerCase();
  if (s === "success") return "success";
  if (s === "failure" || s === "failed") return "failure";
  if (s === "refund" || s === "refunded") return "refund";
  // waiting | depositing | pending | submitted | delayed → keep polling
  return "pending";
}

/** 1Click (NEAR Intents) + Relay clients. Mesh mock when USE_SELLER_MESH / BRIDGE_MOCK; live Relay when TEMPO_ENABLED. */
export const bridgeClients = {
  /** USDC on `chain` as a 1Click asset id, read from the live token list (cached for an hour). */
  async usdcAsset(chain: WithdrawalChain): Promise<string> {
    if (!tokenCache || Date.now() - tokenCache.at > 3_600_000) {
      try {
        const res = await fetch(`${env().ONECLICK_BASE_URL}/v0/tokens`, { headers: oneClickHeaders(), signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`1click tokens ${res.status}`);
        const list = (await res.json()) as Array<{ assetId?: string; blockchain?: string; symbol?: string }>;
        const byChain = new Map<string, string>();
        for (const t of list) if (t.symbol === "USDC" && t.assetId && t.blockchain && !byChain.has(t.blockchain)) byChain.set(t.blockchain, t.assetId);
        tokenCache = { at: Date.now(), byChain };
      } catch {
        tokenCache = { at: Date.now() - 3_300_000, byChain: new Map() }; // try the live list again in five minutes
      }
    }
    return tokenCache.byChain.get(WITHDRAWAL_CHAINS[chain]) ?? USDC_ASSET_FALLBACK[chain];
  },

  /** Tell 1Click about the funding transaction so it starts sooner (optional in their flow). */
  async oneClickSubmitDeposit(p: { depositAddress: string; txHash: string }): Promise<void> {
    await fetch(`${env().ONECLICK_BASE_URL}/v0/deposit/submit`, { method: "POST", headers: oneClickHeaders(), body: JSON.stringify(p), signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  },

  /** Where a swap stands. Terminal: success, refunded (funds returned to the refund account), failed. */
  async oneClickStatus(depositAddress: string): Promise<SwapStatus> {
    const res = await fetch(`${env().ONECLICK_BASE_URL}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, { headers: oneClickHeaders(), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`1click status ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as any;
    const raw = String(j.status ?? "PENDING_DEPOSIT").toUpperCase();
    const d = j.swapDetails ?? {};
    const state = raw === "SUCCESS" ? "success" : raw === "REFUNDED" ? "refunded" : raw === "FAILED" ? "failed" : "pending";
    return { state, raw, amountOut: d.amountOut != null ? String(d.amountOut) : null, destTx: d.destinationChainTxHashes?.[0]?.hash ?? null };
  },

  async oneClickQuote(p: { amount: string; recipient: string; refundTo: string; originAsset: string; destinationAsset: string; dry?: boolean; deadlineMinutes?: number }): Promise<Quote> {
    const e = env();
    const body = {
      dry: p.dry ?? network().oneClickDry,
      swapType: "EXACT_INPUT",
      slippageTolerance: 50,
      originAsset: p.originAsset,
      depositType: "INTENTS",
      destinationAsset: p.destinationAsset,
      amount: p.amount,
      refundTo: p.refundTo,
      refundType: "INTENTS",
      recipient: p.recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + (p.deadlineMinutes ?? 30) * 60_000).toISOString(),
    };
    const res = await fetch(`${e.ONECLICK_BASE_URL}/v0/quote`, {
      method: "POST",
      headers: oneClickHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`1click quote ${res.status}: ${await res.text()}`);
    const j = (await res.json()) as any;
    const q = j.quote ?? j;
    return {
      quoteId: j.quoteRequest?.correlationId ?? j.correlationId ?? randomUUID(),
      amountIn: String(q.amountIn ?? p.amount),
      amountOut: String(q.amountOut ?? q.minAmountOut ?? p.amount),
      depositAddress: q.depositAddress ?? "",
      fees: (toBig(q.amountIn ?? p.amount) - toBig(q.amountOut ?? p.amount)).toString(),
      deadline: q.deadline ?? body.deadline,
    };
  },

  /**
   * Relay quote/v2: Base USDC → Tempo USDC.e (chain 4217).
   * @see https://tempo.xyz/developers/docs/guide/bridge-relay
   */
  async relayQuote(p: { amount: string; user: string; recipient: string }): Promise<Quote> {
    const n = network();
    const base = relayBaseUrl();
    const mock = base.includes("4100") || base.includes("/bridge");
    const body = {
      user: p.user,
      recipient: p.recipient,
      originChainId: mock ? n.base.chainId : n.tempo.relayOriginChainId,
      destinationChainId: n.tempo.chainId,
      originCurrency: mock ? n.base.usdc : n.tempo.relayOriginUsdc,
      destinationCurrency: n.tempo.usdc,
      amount: p.amount,
      tradeType: "EXACT_INPUT" as const,
      useExternalLiquidity: true,
    };
    const res = await fetch(`${base}/quote/v2`, {
      method: "POST",
      headers: relayHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`relay quote/v2 ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const j = (await res.json()) as any;
    const step0 = j.steps?.[0];
    const item0 = step0?.items?.[0];
    const requestId = step0?.requestId ?? j.requestId ?? randomUUID();
    const amountIn = String(j.details?.currencyIn?.amount ?? p.amount);
    const amountOut = String(j.details?.currencyOut?.amount ?? p.amount);
    const fees = String(j.fees?.relayer?.amount ?? j.fees?.gas?.amount ?? "0");
    // Deposit address when present; otherwise the first tx `to` (Relay depository).
    const depositAddress = String(j.depositAddress ?? item0?.data?.to ?? step0?.depositAddress ?? "");
    return { quoteId: requestId, amountIn, amountOut, depositAddress, fees, steps: j.steps };
  },

  async relayStatus(requestId: string): Promise<{ status: "pending" | "success" | "failure" | "refund"; destTx?: string; originTx?: string }> {
    const base = relayBaseUrl();
    const url = `${base}/intents/status/v3?requestId=${encodeURIComponent(requestId)}`;
    let res = await fetch(url, { headers: relayHeaders(), signal: AbortSignal.timeout(15_000) });
    // Legacy mock path
    if (res.status === 404) {
      res = await fetch(`${base}/requests/v3?id=${encodeURIComponent(requestId)}`, { signal: AbortSignal.timeout(15_000) });
    }
    if (!res.ok) return { status: "pending" };
    const j = (await res.json()) as any;
    const r = j.requests?.[0] ?? j;
    const status = mapRelayStatus(r.status);
    const txHashes: string[] = r.txHashes ?? r.data?.txHashes ?? [];
    const inTx = r.data?.inTxs?.[0]?.hash ?? r.originTx ?? txHashes[0];
    const outTx = r.data?.outTxs?.[0]?.hash ?? r.destTx ?? txHashes[1] ?? txHashes[0];
    return { status, destTx: outTx, originTx: inTx };
  },
};

export const feeOk = (amountIn: bigint, fees: bigint) => fees * 10_000n <= amountIn * MAX_FEE_BPS;

/** Top-up amount: bring the pocket to 50% of target, at least $10. */
export function topupAmount(target: bigint, balance: bigint) {
  const want = target / 2n - balance;
  return want > MIN_TOPUP ? want : MIN_TOPUP;
}

/** Should this pocket be topped up? Below 25% of target, or a pending purchase is larger than the pocket. */
export function needsTopup(target: bigint, balance: bigint, largestPending: bigint) {
  return balance * 4n < target || largestPending > balance;
}

async function worker() {
  const e = env();
  if (!e.WORKER_ACCOUNT_ID || !e.WORKER_PRIVATE_KEY) throw new Error("WORKER_ACCOUNT_ID / WORKER_PRIVATE_KEY not set");
  return serviceAccount(e.WORKER_ACCOUNT_ID, e.WORKER_PRIVATE_KEY);
}

/**
 * Runs every minute: queue Tempo pocket top-ups only when Tempo/MPP is enabled.
 * Model spend uses Base USDC via x402 — do not bridge to Tempo for inference.
 */
export async function scanFloats(log: Logger, enqueue: (departmentId: string, amount: bigint) => Promise<void>) {
  if (!network().tempo.enabled) {
    log.debug("Tempo disabled — skipping float top-ups (models pay x402 on Base USDC)");
    return [];
  }
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db.select().from(railFloats).where(and(eq(railFloats.rail, "tempo"), eq(railFloats.enabled, true), eq(railFloats.paused, false)));
  const queued: string[] = [];
  for (const f of rows) {
    const count = f.topupsDay === today ? f.topupsToday : 0;
    if (count >= MAX_TOPUPS_PER_DAY) continue;
    const pending = await db.execute<{ max: string | null }>(
      sql`select max(amount)::text as max from receipts where department_id = ${f.departmentId} and kind = 'purchase' and rail like 'mpp-tempo%' and verified_on_chain is null and created_at > now() - interval '1 hour'`,
    );
    const largest = toBig(pending.rows[0]?.max);
    const target = toBig(f.target);
    const balance = toBig(f.balance) - toBig(f.reserved);
    if (!needsTopup(target, balance, largest)) continue;
    await enqueue(f.departmentId, topupAmount(target, balance));
    queued.push(f.departmentId);
    log.info({ department: f.departmentId }, "top-up queued");
  }
  return queued;
}

/** One top-up job. Idempotent on jobId (stored on chain via request_rail_topup / record_topup). */
export async function runTopup(p: { jobId: string; departmentId: string; amount: string }, log: Logger) {
  if (!network().tempo.enabled) {
    log.warn({ job: p.jobId }, "Tempo disabled — refusing top-up (models use Base USDC x402)");
    return { status: "aborted" as const };
  }
  const db = getDb();
  const [existing] = await db.select().from(bridgeTransfers).where(eq(bridgeTransfers.jobId, p.jobId));
  if (existing && ["done", "failed", "aborted"].includes(existing.status)) return existing;

  const [dept] = await db.select().from(departments).where(eq(departments.id, p.departmentId));
  if (!dept?.baseAddress) throw new Error(`department ${p.departmentId} has no Base address yet`);
  const acc = await worker();

  if (!existing) {
    await db.insert(bridgeTransfers).values({ jobId: p.jobId, departmentId: p.departmentId, direction: "topup", amountIn: p.amount, status: "requested" }).onConflictDoNothing();
    // Contract checks the float policy and moves Intents USDC for this job.
    await callAs(acc, serviceCalls.requestRailTopup(p.departmentId, { jobId: p.jobId, amount: p.amount, rail: "tempo" }));
  }

  // 1) Intents USDC -> department Base address (1Click)
  const oneClick = await bridgeClients.oneClickQuote({
    amount: p.amount,
    recipient: dept.baseAddress,
    refundTo: p.departmentId,
    originAsset: network().intents.usdcTokenId,
    destinationAsset: `nep141:base-${network().base.usdc.toLowerCase()}.omft.near`,
  });
  // 2) Base -> Tempo pocket (Relay deposit address)
  const relay = await bridgeClients.relayQuote({ amount: oneClick.amountOut, user: dept.baseAddress, recipient: dept.baseAddress });
  const totalFees = toBig(oneClick.fees) + toBig(relay.fees);
  if (!feeOk(toBig(p.amount), totalFees)) {
    await db.update(bridgeTransfers).set({ status: "aborted", error: `fee ${totalFees} > 1%`, updatedAt: new Date() }).where(eq(bridgeTransfers.jobId, p.jobId));
    log.warn({ job: p.jobId, fees: totalFees.toString() }, "top-up aborted: fee guard");
    await callAs(acc, serviceCalls.recordTopup(p.departmentId, { job_id: p.jobId, status: "aborted", reason: "fee_guard" }));
    return { status: "aborted" };
  }
  await db
    .update(bridgeTransfers)
    .set({ status: "bridging", quoteId: oneClick.quoteId, relayRequestId: relay.quoteId, depositAddress: relay.depositAddress, fees: totalFees.toString(), updatedAt: new Date() })
    .where(eq(bridgeTransfers.jobId, p.jobId));

  // 3) Track /requests/v3 until settled (the job re-runs on crash; status lives in the row).
  for (let i = 0; i < 60; i++) {
    const s = await bridgeClients.relayStatus(relay.quoteId);
    if (s.status === "success" || s.status === "failure" || s.status === "refund") {
      const ok = s.status === "success";
      const amountOut = ok ? relay.amountOut : "0";
      await db
        .update(bridgeTransfers)
        .set({ status: ok ? "done" : "failed", amountOut, originTx: s.originTx, destTx: s.destTx, error: ok ? null : `relay ${s.status}`, updatedAt: new Date() })
        .where(eq(bridgeTransfers.jobId, p.jobId));
      await callAs(
        acc,
        serviceCalls.recordTopup(p.departmentId, {
          job_id: p.jobId,
          status: ok ? "done" : "failed",
          amount_in: p.amount,
          amount_out: amountOut,
          fees: totalFees.toString(),
          quote_id: oneClick.quoteId,
          origin_tx: s.originTx ?? null,
          dest_tx: s.destTx ?? null,
        }),
      );
      if (ok) {
        const today = new Date().toISOString().slice(0, 10);
        await db.execute(sql`update rail_floats set balance = balance + ${amountOut}::numeric,
            topups_today = case when topups_day = ${today} then topups_today + 1 else 1 end, topups_day = ${today}, updated_at = now()
            where department_id = ${p.departmentId} and rail = 'tempo'`);
      }
      return { status: ok ? "done" : "failed" };
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error("relay still pending; job will retry");
}

/* ---------------------------------------------------------------------------------------------------
 * Withdrawals from NEAR Intents
 *
 * The founder's own transaction moves the money: `request_withdrawal` on the company contract transfers the
 * funds inside Intents and emits `withdrawal_requested` only once that worked. The API plans it (balance,
 * route, quote); this worker never pays. It follows the swap to the end and records how it turned out.
 * ------------------------------------------------------------------------------------------------- */

/** The company's USDC in NEAR Intents (0 where Intents isn't deployed, i.e. on testnet). */
export async function intentsUsdcBalance(companyId: string): Promise<bigint> {
  const { view } = await import("@builderos/near");
  const n = network().intents;
  const bal = await view<string>(n.contract, "mt_balance_of", { account_id: companyId, token_id: n.usdcTokenId }).catch(() => "0");
  return toBig(bal);
}

export type WithdrawalRoute = {
  /** "near": straight to a NEAR account. "swap": through a 1Click quote to another chain. */
  route: "near" | "swap";
  /** Intents id of the token that leaves the company. */
  tokenId: string;
  destinationAsset: string;
  amountOut: string;
  fees: string;
  depositAddress: string | null;
  quoteId: string | null;
  /** The founder must sign before this (ISO time); null when there is no quote to expire. */
  deadline: string | null;
};

/** How this withdrawal will travel, with a committed 1Click quote when it leaves NEAR. */
export async function planWithdrawalRoute(p: { companyId: string; amount: string; to: string; chain: WithdrawalChain }): Promise<WithdrawalRoute> {
  const tokenId = network().intents.usdcTokenId;
  if (p.chain === "near") return { route: "near", tokenId, destinationAsset: tokenId, amountOut: p.amount, fees: "0", depositAddress: null, quoteId: null, deadline: null };
  const destinationAsset = await bridgeClients.usdcAsset(p.chain);
  // dry:false commits the quote and returns the one-time Intents account to fund
  const q = await bridgeClients.oneClickQuote({ amount: p.amount, recipient: p.to, refundTo: p.companyId, originAsset: tokenId, destinationAsset, dry: false, deadlineMinutes: 20 });
  if (!q.depositAddress) throw new Error("1Click returned a quote without a deposit address");
  return { route: "swap", tokenId, destinationAsset, amountOut: q.amountOut, fees: q.fees, depositAddress: q.depositAddress, quoteId: q.quoteId, deadline: q.deadline ?? null };
}

type ChainCaller = (c: ReturnType<typeof serviceCalls.recordWithdrawal>) => Promise<unknown>;
let chainCaller: ChainCaller | null = null;
/** Test hook: how the worker's record-only call reaches the chain. Production signs with the worker key. */
export const setChainCaller = (f: ChainCaller | null) => (chainCaller = f);
const recordOnChain: ChainCaller = async (c) => (chainCaller ? chainCaller(c) : callAs(await worker(), c));

export type WithdrawalJob = { withdrawalId: string; companyId: string; amount: string; token: string; to: string; chain?: string | null; route?: string | null; depositAddress?: string | null; quoteId?: string | null; nearTx?: string | null };

/**
 * Runs after `withdrawal_requested`, i.e. after the funds have left the company inside Intents. Follows a
 * swap until 1Click reports a final state, then writes that outcome on chain (`record_withdrawal`) so the
 * ledger shows what really happened: delivered, refunded to the company, or failed.
 */
export async function runWithdrawal(p: WithdrawalJob, log: Logger, opts: { pollMs?: number; tries?: number } = {}) {
  const db = getDb();
  const [w] = await db.select().from(withdrawals).where(eq(withdrawals.id, p.withdrawalId));
  if (w && ["done", "refunded", "failed"].includes(w.status)) return { status: w.status };
  const sources = [{ from: "intents", amount: p.amount }];
  await db
    .insert(withdrawals)
    .values({ id: p.withdrawalId, companyId: p.companyId, amount: p.amount, token: p.token, to: p.to, chain: p.chain ?? null, status: "running", sources })
    .onConflictDoUpdate({ target: withdrawals.id, set: { status: "running", sources } });

  const record = async (status: "done" | "refunded" | "failed", out: { amountOut: string; fees: string; destTx: string | null }) => {
    await recordOnChain(
      serviceCalls.recordWithdrawal(p.companyId, { withdrawal_id: p.withdrawalId, status, sources, token: p.token, to: p.to, chain: p.chain ?? null, amount_in: p.amount, amount_out: out.amountOut, fees: out.fees, quote_id: p.quoteId ?? null, deposit_address: p.depositAddress ?? null, origin_tx: p.nearTx ?? null, dest_tx: out.destTx }),
    );
    await db.update(withdrawals).set({ status }).where(eq(withdrawals.id, p.withdrawalId));
    log.info({ withdrawal: p.withdrawalId, status }, "withdrawal recorded");
    return { status };
  };

  // Straight to a NEAR account: the contract's own transfer delivered it; there is no swap to follow.
  if (p.route === "near") return record("done", { amountOut: p.amount, fees: "0", destTx: p.nearTx ?? null });

  if (!p.depositAddress) throw new Error(`withdrawal ${p.withdrawalId} has no deposit address to follow`);
  if (p.nearTx) await bridgeClients.oneClickSubmitDeposit({ depositAddress: p.depositAddress, txHash: p.nearTx });
  const tries = opts.tries ?? 60;
  for (let i = 0; i < tries; i++) {
    const st = await bridgeClients.oneClickStatus(p.depositAddress);
    if (st.state === "success") {
      const out = st.amountOut ?? p.amount;
      const fee = toBig(p.amount) - toBig(out);
      return record("done", { amountOut: out, fees: (fee > 0n ? fee : 0n).toString(), destTx: st.destTx });
    }
    // refunded: 1Click returned the funds to the company's Intents balance. failed: it could not; shown as such.
    if (st.state === "refunded" || st.state === "failed") return record(st.state, { amountOut: "0", fees: "0", destTx: null });
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 5_000));
  }
  throw new Error("withdrawal swap still processing; the job will retry");
}

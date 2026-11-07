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

export type Quote = { quoteId: string; amountIn: string; amountOut: string; depositAddress: string; fees: string; steps?: unknown };

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
  async oneClickQuote(p: { amount: string; recipient: string; refundTo: string; originAsset: string; destinationAsset: string }): Promise<Quote> {
    const e = env();
    const body = {
      dry: network().oneClickDry,
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
      deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
    const res = await fetch(`${e.ONECLICK_BASE_URL}/v0/quote`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(e.ONECLICK_JWT ? { authorization: `Bearer ${e.ONECLICK_JWT}` } : {}) },
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
    originAsset: "nep141:usdc.near",
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

/** Withdrawal: pause top-ups, pay from Intents USDC first, pull the gap back from Tempo (never reserved funds). */
export async function runWithdrawal(p: { withdrawalId: string; companyId: string; amount: string; token: string; to: string; chain?: string }, log: Logger) {
  const db = getDb();
  const [w] = await db.select().from(withdrawals).where(eq(withdrawals.id, p.withdrawalId));
  if (w && ["done", "failed"].includes(w.status)) return w;
  if (!w) await db.insert(withdrawals).values({ id: p.withdrawalId, companyId: p.companyId, amount: p.amount, token: p.token, to: p.to, chain: p.chain, status: "running" }).onConflictDoNothing();

  const depts = await db.select().from(departments).where(eq(departments.companyId, p.companyId));
  const ids = depts.map((d) => d.id);
  if (ids.length) await db.execute(sql`update rail_floats set paused = true where department_id = any(${ids})`);

  try {
    const intents = await intentsUsdcBalance(p.companyId);
    let gap = toBig(p.amount) - intents;
    const sources: Array<{ from: string; amount: string }> = [{ from: "intents", amount: (gap > 0n ? intents : toBig(p.amount)).toString() }];
    if (gap > 0n) {
      for (const d of depts) {
        if (gap <= 0n) break;
        const [f] = await db.select().from(railFloats).where(and(eq(railFloats.departmentId, d.id), eq(railFloats.rail, "tempo")));
        const free = toBig(f?.balance) - toBig(f?.reserved); // never touch reserved (open sessions / pending purchases)
        if (free <= 0n) continue;
        const pull = free < gap ? free : gap;
        sources.push({ from: `tempo:${d.id}`, amount: pull.toString() });
        gap -= pull;
      }
      if (gap > 0n) throw new Error(`insufficient unreserved funds; short by ${gap}`);
    }
    // Swap/send via 1Click to the founder's chosen token/chain.
    const quote = await bridgeClients.oneClickQuote({
      amount: p.amount,
      recipient: p.to,
      refundTo: p.companyId,
      originAsset: "nep141:usdc.near",
      destinationAsset: p.token.includes(":") ? p.token : `nep141:${p.token}.near`,
    });
    const acc = await worker();
    await callAs(
      acc,
      serviceCalls.recordWithdrawal(p.companyId, {
        withdrawal_id: p.withdrawalId,
        status: "done",
        sources,
        amount_out: quote.amountOut,
        fees: quote.fees,
        quote_id: quote.quoteId,
        deposit_address: quote.depositAddress,
      }),
    );
    await db.update(withdrawals).set({ status: "done", sources }).where(eq(withdrawals.id, p.withdrawalId));
    log.info({ withdrawal: p.withdrawalId }, "withdrawal recorded");
    return { status: "done", sources };
  } catch (e: any) {
    await db.update(withdrawals).set({ status: "failed" }).where(eq(withdrawals.id, p.withdrawalId));
    throw e;
  } finally {
    // Recompute 50% targets on the new balance and resume top-ups.
    if (ids.length) await db.execute(sql`update rail_floats set paused = false, updated_at = now() where department_id = any(${ids})`);
  }
}

async function intentsUsdcBalance(companyId: string): Promise<bigint> {
  const { view } = await import("@builderos/near");
  const token = env().NETWORK === "testnet" ? "nep141:usdc.fakes.testnet" : "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
  const intents = env().NETWORK === "testnet" ? "intents.testnet" : "intents.near";
  const bal = await view<string>(intents, "mt_balance_of", { account_id: companyId, token_id: token }).catch(() => "0");
  return toBig(bal);
}

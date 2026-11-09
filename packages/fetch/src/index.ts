import { createHash } from "node:crypto";
import { HttpError, sleep } from "@builderos/shared";
import { callAs, serviceAccount, serviceCalls, views } from "@builderos/near";
import {
  buildPaymentHeaders,
  challengeAmount,
  challengeHash,
  parseChallenges,
  settlementTx,
  type Challenge,
  type Rail,
  type SignedPurchase,
} from "@builderos/rails";

/**
 * Spend firewall SDK: a drop-in `fetch` for agents. Every 402 becomes a policy-checked
 * `request_purchase` on the department contract. The SDK never supplies the payee or a
 * hash to sign; a compromised agent can only overbuy from allow-listed sellers within caps.
 */

export type PurchaseContext = {
  departmentId: string;
  taskId: string;
  sellerId: string; // registry id of the seller behind this URL
  model?: string | null;
  tier?: string;
};

export type BuilderFetchOptions = {
  agent: { accountId: string; privateKey: string };
  preferRail?: Rail[];
  sellerTimeoutMs?: number; // 30s
  approvalTimeoutMs?: number; // 10 min, then the task parks
  pollMs?: number;
  /** Optional faster path: resolve when the indexer sees payment_signed for this request. */
  waitForSignature?: (requestId: string, timeoutMs: number) => Promise<SignedPurchase | null>;
  onEvent?: (e: { type: string; [k: string]: unknown }) => void;
  /** A request approved while this task was parked: reused (signed) instead of asking again. */
  resumeRequestId?: string;
};

export class PurchasePending extends Error {
  constructor(public requestId: string, public reason: string) {
    super(`purchase ${requestId} waiting: ${reason}`);
  }
}
export class PurchaseRejected extends Error {
  constructor(public requestId: string, public reason: string) {
    super(`purchase ${requestId} rejected: ${reason}`);
  }
}

/** What request_purchase / sign_approved return (the department contract's PurchaseResult). */
type RequestResult = {
  status: "signed" | "pending" | "approved" | "rejected" | "checking";
  request_id: string;
  rail?: string | null;
  authorization?: any;
  signature?: any;
  reason?: string | null;
};

function toSigned(r: { request_id: string; authorization?: any; signature?: any }): SignedPurchase {
  const parse = (v: any) => (typeof v === "string" ? JSON.parse(v) : v);
  return { rail: "x402-evm", request_id: r.request_id, authorization: parse(r.authorization), signature: parse(r.signature) } as SignedPurchase;
}

/** Prefer Base USDC x402 (models / most services). Tempo MPP only when that is all that is offered. */
export function pickChallenge(chs: Challenge[], prefer: Rail[] = ["x402-evm", "x402-near", "mpp-tempo-charge", "mpp-tempo-session"]) {
  const ranked = [...chs].sort((a, b) => {
    const pa = prefer.indexOf(a.rail);
    const pb = prefer.indexOf(b.rail);
    if (pa !== pb) return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb);
    return Number(BigInt(challengeAmount(a)) - BigInt(challengeAmount(b)));
  });
  return ranked[0];
}

export function createBuilderFetch(opts: BuilderFetchOptions) {
  const sellerTimeout = opts.sellerTimeoutMs ?? 30_000;
  const approvalTimeout = opts.approvalTimeoutMs ?? 10 * 60_000;
  const pollMs = opts.pollMs ?? 4_000;

  /** Ask the team contract for the Chain Signatures signature of an approved request. */
  async function signApproved(departmentId: string, requestId: string): Promise<SignedPurchase> {
    const account = await serviceAccount(opts.agent.accountId, opts.agent.privateKey);
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await callAs(account, serviceCalls.signApproved(departmentId, requestId))
        .then((x) => x.value as RequestResult)
        .catch(() => null);
      if (r?.status === "signed") return toSigned(r);
      // RPC timeouts can hide a successful signature; read the request from chain.
      const onChain = await views.getRequest(departmentId, requestId).catch(() => null);
      if (onChain?.status === "signed") return toSigned(onChain);
      await sleep(pollMs);
    }
    throw new PurchasePending(requestId, "signing failed, will retry");
  }

  /** Wait for an approval card to be decided, then sign. Throws PurchasePending on timeout (task parks). */
  async function waitSigned(departmentId: string, requestId: string): Promise<SignedPurchase> {
    if (opts.waitForSignature) {
      const s = await opts.waitForSignature(requestId, approvalTimeout);
      if (s) return s;
    }
    const deadline = Date.now() + approvalTimeout;
    while (Date.now() < deadline) {
      const r = await views.getRequest(departmentId, requestId).catch(() => null);
      if (r?.status === "signed") return toSigned(r);
      if (r?.status === "approved") return signApproved(departmentId, requestId);
      if (r?.status === "rejected" || r?.status === "cancelled") throw new PurchaseRejected(requestId, r.reason ?? r.status);
      await sleep(pollMs);
    }
    throw new PurchasePending(requestId, "approval timeout");
  }

  /** Reuse a request approved while the task was parked, if it still fits this challenge. */
  async function resumeApproved(departmentId: string, challenge: Challenge, ctx: PurchaseContext): Promise<SignedPurchase | null> {
    const id = opts.resumeRequestId;
    if (!id || challenge.rail !== "x402-evm") return null;
    opts.resumeRequestId = undefined; // one shot
    const r = await views.getRequest(departmentId, id).catch(() => null);
    if (!r) return null;
    const fits =
      r.seller_id === ctx.sellerId &&
      BigInt(r.amount) >= BigInt(challengeAmount(challenge)) &&
      r.pay_to.toLowerCase() === (challenge as any).requirement.payTo.toLowerCase();
    if (fits && r.status === "approved") return signApproved(departmentId, id);
    if (fits && r.status === "signed") return toSigned(r);
    if (r.status === "pending" || r.status === "approved") {
      const account = await serviceAccount(opts.agent.accountId, opts.agent.privateKey);
      await callAs(account, serviceCalls.cancelRequest(departmentId, id)).catch(() => {});
    }
    return null;
  }

  return async function builderFetch(input: string | URL, init: RequestInit = {}, ctx: PurchaseContext): Promise<Response> {
    const first = await fetch(input, { ...init, signal: AbortSignal.timeout(sellerTimeout) });
    if (first.status !== 402) return first;

    const challenges = await parseChallenges(first);
    if (!challenges.length) throw new HttpError(402, "no payable challenge offered");
    const challenge = pickChallenge(challenges, opts.preferRail);
    const hash = challengeHash(challenge);
    opts.onEvent?.({ type: "challenge", rail: challenge.rail, hash });

    const resumed = await resumeApproved(ctx.departmentId, challenge, ctx);
    const account = await serviceAccount(opts.agent.accountId, opts.agent.privateKey);
    const value = resumed
      ? ({ status: "signed", ...resumed } as unknown as RequestResult)
      : await callAs(
      account,
      serviceCalls.requestPurchase(ctx.departmentId, {
        sellerId: ctx.sellerId,
        rail: challenge.rail,
        amount: challengeAmount(challenge),
        challengeHash: hash,
        taskId: ctx.taskId,
        model: ctx.model,
        // The challenge itself goes to the contract so it can check payTo against the registry.
        payload: challenge.rail.startsWith("mpp") ? (challenge as any).mpp : (challenge as any).requirement,
      }),
    )
          .then((x) => x.value as RequestResult)
          // The tx can outlive the RPC call (company check + Chain Signatures take a few blocks): find it by challenge.
          .catch(async (err) => {
            for (let i = 0; i < 10; i++) {
              await sleep(pollMs);
              const r = await views.getRequestByChallenge(ctx.departmentId, hash).catch(() => null);
              if (r && r.status !== "checking") return { ...r, request_id: r.request_id } as unknown as RequestResult;
            }
            throw err;
          });
    const result = value as RequestResult;
    if (!result) throw new Error("request_purchase returned nothing");
    if (result.status === "rejected") throw new PurchaseRejected(result.request_id, result.reason ?? "rejected");

    const signed: SignedPurchase =
      result.status === "signed"
        ? resumed ?? toSigned(result)
        : result.status === "approved"
          ? await signApproved(ctx.departmentId, result.request_id)
          : await waitSigned(ctx.departmentId, result.request_id);
    opts.onEvent?.({ type: "signed", requestId: signed.request_id, reason: result.reason ?? null });
    const requestId = signed.request_id;
    const headers = new Headers(init.headers);
    for (const [k, v] of Object.entries(buildPaymentHeaders(challenge, signed))) headers.set(k, v);

    let res: Response;
    let outcome = "ok";
    try {
      res = await fetch(input, { ...init, headers, signal: AbortSignal.timeout(sellerTimeout) });
      if (!res.ok) outcome = `http_${res.status}`;
    } catch (e) {
      outcome = "seller_error";
      await record(ctx.departmentId, requestId, "", null, outcome).catch(() => {});
      throw e;
    }
    const buf = Buffer.from(await res.clone().arrayBuffer());
    const responseHash = createHash("sha256").update(buf).digest("hex");
    await record(ctx.departmentId, requestId, responseHash, settlementTx(res), outcome);
    opts.onEvent?.({ type: "paid", requestId, outcome });
    return res;
  };

  async function record(departmentId: string, requestId: string, responseHash: string, foreignTx: string | null, outcome: string) {
    const account = await serviceAccount(opts.agent.accountId, opts.agent.privateKey);
    await callAs(account, serviceCalls.recordResponse(departmentId, { requestId, responseHash, foreignTx, outcome }));
  }
}

export type BuilderFetch = ReturnType<typeof createBuilderFetch>;

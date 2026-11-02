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

type RequestResult =
  | ({ status: "signed" } & SignedPurchase)
  | { status: "pending"; request_id: string; reason: string }
  | { status: "rejected"; request_id: string; reason: string };

export function pickChallenge(chs: Challenge[], prefer: Rail[] = ["x402-evm", "mpp-tempo-charge", "mpp-tempo-session", "x402-near"]) {
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

  async function waitSigned(departmentId: string, requestId: string): Promise<SignedPurchase> {
    if (opts.waitForSignature) {
      const s = await opts.waitForSignature(requestId, approvalTimeout);
      if (s) return s;
      throw new PurchasePending(requestId, "approval timeout");
    }
    const deadline = Date.now() + approvalTimeout;
    while (Date.now() < deadline) {
      const r = await views.getRequest(departmentId, requestId).catch(() => null);
      if (r?.status === "signed" && r.signed) return r.signed as SignedPurchase;
      if (r?.status === "rejected" || r?.status === "expired") throw new PurchaseRejected(requestId, r.status);
      await sleep(pollMs);
    }
    throw new PurchasePending(requestId, "approval timeout");
  }

  return async function builderFetch(input: string | URL, init: RequestInit = {}, ctx: PurchaseContext): Promise<Response> {
    const first = await fetch(input, { ...init, signal: AbortSignal.timeout(sellerTimeout) });
    if (first.status !== 402) return first;

    const challenges = await parseChallenges(first);
    if (!challenges.length) throw new HttpError(402, "no payable challenge offered");
    const challenge = pickChallenge(challenges, opts.preferRail);
    const hash = challengeHash(challenge);
    opts.onEvent?.({ type: "challenge", rail: challenge.rail, hash });

    const account = await serviceAccount(opts.agent.accountId, opts.agent.privateKey);
    const { value } = await callAs(
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
    );
    const result = value as RequestResult;
    if (!result) throw new Error("request_purchase returned nothing");
    if (result.status === "rejected") throw new PurchaseRejected(result.request_id, result.reason);

    const signed: SignedPurchase = result.status === "signed" ? result : await waitSigned(ctx.departmentId, result.request_id);
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

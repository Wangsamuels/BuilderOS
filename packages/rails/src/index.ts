import { createHash } from "node:crypto";
import { getAddress, serializeSignature, type Hex } from "viem";
import { network } from "@builderos/shared";

/**
 * Rail adapters turn a 402 challenge into a NEAR purchase request, and a contract-built
 * Chain Signatures signature into the payment header. They never pick the payee.
 */

export type Rail = "x402-evm" | "mpp-tempo-charge" | "mpp-tempo-session" | "x402-near";

export type X402Requirement = {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description?: string;
  mimeType?: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: { name?: string; version?: string };
};

export type MppChallenge = {
  id: string;
  method: string; // "tempo"
  intent: "charge" | "session" | string;
  request: Record<string, any>; // decoded request param: amount, currency, recipient, ...
  realm?: string;
};

export type Challenge =
  | { rail: "x402-evm"; requirement: X402Requirement; raw: unknown }
  | { rail: "x402-near"; requirement: X402Requirement; raw: unknown }
  | { rail: "mpp-tempo-charge" | "mpp-tempo-session"; mpp: MppChallenge; raw: unknown };

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(v as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as any)[k])}`)
    .join(",")}}`;
}
export const challengeHash = (c: Challenge) =>
  createHash("sha256").update(canonicalJson(c.rail.startsWith("mpp") ? (c as any).mpp : (c as any).requirement)).digest("hex");

export function challengeAmount(c: Challenge): string {
  if (c.rail === "x402-evm" || c.rail === "x402-near") return c.requirement.maxAmountRequired;
  return String(c.mpp.request.amount ?? c.mpp.request.deposit ?? "0");
}
export function challengePayee(c: Challenge): string {
  if (c.rail === "x402-evm" || c.rail === "x402-near") return c.requirement.payTo;
  return String(c.mpp.request.recipient ?? c.mpp.request.payee ?? "");
}

/** Parse `WWW-Authenticate: Payment id="..", method="tempo", intent="charge", request="<b64url json>"`. */
export function parseMppHeader(h: string): MppChallenge | null {
  if (!/^Payment\s/i.test(h)) return null;
  const params: Record<string, string> = {};
  for (const m of h.slice(8).matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) params[m[1]] = m[2];
  if (!params.id || !params.method) return null;
  let request: Record<string, any> = {};
  try {
    request = params.request ? JSON.parse(Buffer.from(params.request, "base64url").toString("utf8")) : {};
  } catch {
    return null;
  }
  return { id: params.id, method: params.method, intent: params.intent ?? "charge", request, realm: params.realm };
}

/** Read a 402 response and pick the challenge we can pay. Prefers the given rail if several are offered. */
export async function parseChallenges(res: Response): Promise<Challenge[]> {
  const out: Challenge[] = [];
  const www = res.headers.get("www-authenticate");
  if (www) {
    for (const part of www.split(/,\s*(?=Payment\s)/i)) {
      const mpp = parseMppHeader(part.trim());
      if (mpp && mpp.method === "tempo") out.push({ rail: mpp.intent === "session" ? "mpp-tempo-session" : "mpp-tempo-charge", mpp, raw: part });
    }
  }
  const body: any = await res
    .clone()
    .json()
    .catch(() => null);
  if (body && Array.isArray(body.accepts)) {
    for (const r of body.accepts as X402Requirement[]) {
      if (r.scheme !== "exact") continue;
      if (r.network === "near" || r.network === "near-testnet") out.push({ rail: "x402-near", requirement: r, raw: body });
      else if (r.network === network().base.x402Network) out.push({ rail: "x402-evm", requirement: r, raw: body });
    }
  }
  return out;
}

// ---------------- signatures coming back from the contract (v1.signer) ----------------

/** Chain Signatures secp256k1 output. */
export type MpcSignature = { big_r: { affine_point: string }; s: { scalar: string }; recovery_id: number };

export function mpcToHex(sig: MpcSignature): Hex {
  const r = `0x${sig.big_r.affine_point.slice(2)}` as Hex; // drop 02/03 prefix => x coord
  const s = `0x${sig.s.scalar}` as Hex;
  return serializeSignature({ r, s, yParity: sig.recovery_id });
}

/** What `request_purchase` returns once the contract approves and v1.signer signs. */
export type SignedPurchase =
  | {
      rail: "x402-evm";
      request_id: string;
      authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };
      signature: MpcSignature;
    }
  | { rail: "mpp-tempo-charge" | "mpp-tempo-session"; request_id: string; signed_tx: string; source: string }
  | { rail: "x402-near"; request_id: string; signed_delegate: string };

export class PayeeMismatch extends Error {}

/** Build the retry headers. Refuses if what the contract authorised differs from what the seller asked. */
export function buildPaymentHeaders(challenge: Challenge, signed: SignedPurchase): Record<string, string> {
  if (challenge.rail === "x402-evm" && signed.rail === "x402-evm") {
    const req = challenge.requirement;
    if (getAddress(signed.authorization.to) !== getAddress(req.payTo)) throw new PayeeMismatch("payTo differs from contract authorization");
    if (BigInt(signed.authorization.value) > BigInt(req.maxAmountRequired)) throw new PayeeMismatch("value above challenge");
    const payment = {
      x402Version: 1,
      scheme: "exact",
      network: req.network,
      payload: { signature: mpcToHex(signed.signature), authorization: signed.authorization },
    };
    return { "X-PAYMENT": Buffer.from(JSON.stringify(payment)).toString("base64") };
  }
  if ((challenge.rail === "mpp-tempo-charge" || challenge.rail === "mpp-tempo-session") && (signed.rail === "mpp-tempo-charge" || signed.rail === "mpp-tempo-session")) {
    if (!network().tempo.enabled && !process.env.USE_SELLER_MESH) throw new Error("Tempo rail disabled (TEMPO_ENABLED=false)");
    const credential = { challenge: { id: challenge.mpp.id, method: challenge.mpp.method, intent: challenge.mpp.intent }, source: signed.source, payload: { type: "transaction", signature: signed.signed_tx } };
    return { Authorization: `Payment ${Buffer.from(JSON.stringify(credential)).toString("base64url")}` };
  }
  if (challenge.rail === "x402-near" && signed.rail === "x402-near") {
    const payment = { x402Version: 1, scheme: "exact", network: challenge.requirement.network, payload: { signedDelegateAction: signed.signed_delegate } };
    return { "X-PAYMENT": Buffer.from(JSON.stringify(payment)).toString("base64") };
  }
  throw new Error(`rail mismatch: challenge ${challenge.rail} vs signed ${signed.rail}`);
}

/** Pull the settlement tx from the seller's response, if any (x402: X-PAYMENT-RESPONSE; MPP: Payment-Receipt). */
export function settlementTx(res: Response): string | null {
  const x = res.headers.get("x-payment-response");
  if (x) {
    try {
      return JSON.parse(Buffer.from(x, "base64").toString("utf8")).transaction ?? null;
    } catch {
      /* ignore */
    }
  }
  const m = res.headers.get("payment-receipt");
  if (m) {
    try {
      return JSON.parse(Buffer.from(m, "base64url").toString("utf8")).reference ?? null;
    } catch {
      /* ignore */
    }
  }
  return null;
}

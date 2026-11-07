import { createHash } from "node:crypto";
import { getAddress, serializeSignature, type Hex } from "viem";
import { env, network } from "@builderos/shared";

/**
 * Rail adapters turn a 402 challenge into a NEAR purchase request, and a contract-built
 * Chain Signatures signature into the payment header. They never pick the payee.
 */

export type Rail = "x402-evm" | "mpp-tempo-charge" | "mpp-tempo-session" | "x402-near";

export type X402Requirement = {
  scheme: "exact";
  network: string;
  /** Atomic amount (v1 name). v2 uses `amount` on the wire — normalized here. */
  maxAmountRequired: string;
  resource: string;
  description?: string;
  mimeType?: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: { name?: string; version?: string; [k: string]: unknown };
  /** 1 = body `accepts` / X-PAYMENT; 2 = PAYMENT-REQUIRED / PAYMENT-SIGNATURE (PingPay, Coinbase). */
  x402Version?: 1 | 2;
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

function b64Json(h: string): any | null {
  const raw = h.trim();
  if (!raw) return null;
  for (const enc of ["base64", "base64url"] as const) {
    try {
      const json = Buffer.from(raw, enc).toString("utf8");
      if (json.startsWith("{") || json.startsWith("[")) return JSON.parse(json);
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Map v1 or v2 payment requirement into our internal shape. */
export function normalizeX402Requirement(r: any, version: 1 | 2, resourceFallback = ""): X402Requirement | null {
  if (!r || r.scheme !== "exact") return null;
  const amount = String(r.maxAmountRequired ?? r.amount ?? "");
  if (!/^\d+$/.test(amount)) return null;
  const resource =
    typeof r.resource === "string"
      ? r.resource
      : String(r.resource?.url ?? resourceFallback ?? "");
  return {
    scheme: "exact",
    network: String(r.network),
    maxAmountRequired: amount,
    resource,
    description: r.description ?? r.resource?.description,
    mimeType: r.mimeType ?? r.resource?.mimeType,
    payTo: String(r.payTo),
    maxTimeoutSeconds: Number(r.maxTimeoutSeconds ?? 60),
    asset: String(r.asset),
    extra: r.extra,
    x402Version: version,
  };
}

/** True if this requirement is payable on our configured Base (legacy name or CAIP-2). */
export function isBaseX402Network(net: string): boolean {
  const n = network().base;
  if (net === n.x402Network) return true;
  if (net === `eip155:${n.chainId}`) return true;
  // PingPay / mainnet Near AI x402 gateways advertise Base mainnet even while we develop on testnet.
  if (net === "base" || net === "eip155:8453") return true;
  if (net === "base-sepolia" || net === "eip155:84532") return true;
  return /^eip155:\d+$/.test(net);
}

function pushX402Accepts(out: Challenge[], accepts: any[], version: 1 | 2, raw: unknown, resourceFallback = "") {
  for (const rawReq of accepts) {
    const requirement = normalizeX402Requirement(rawReq, version, resourceFallback);
    if (!requirement) continue;
    if (requirement.network === "near" || requirement.network === "near-testnet" || requirement.network.startsWith("near:")) {
      out.push({ rail: "x402-near", requirement, raw });
    } else if (isBaseX402Network(requirement.network)) {
      out.push({ rail: "x402-evm", requirement, raw });
    }
  }
}

/**
 * Decode x402 v2 `PAYMENT-REQUIRED` (or `payment-required`) header.
 * Wire: Base64 JSON `{ x402Version: 2, accepts: [...], resource?: { url } }`.
 */
export function parsePaymentRequiredHeader(header: string): Challenge[] {
  const decoded = b64Json(header);
  if (!decoded || !Array.isArray(decoded.accepts)) return [];
  const version: 1 | 2 = decoded.x402Version === 2 ? 2 : 1;
  const out: Challenge[] = [];
  const resourceUrl = typeof decoded.resource === "string" ? decoded.resource : String(decoded.resource?.url ?? "");
  pushX402Accepts(out, decoded.accepts, version, decoded, resourceUrl);
  return out;
}

/** Read a 402 response and pick the challenge we can pay (x402 v1 body, v2 PAYMENT-REQUIRED, Tempo MPP). */
export async function parseChallenges(res: Response): Promise<Challenge[]> {
  const out: Challenge[] = [];
  const www = res.headers.get("www-authenticate");
  if (www) {
    for (const part of www.split(/,\s*(?=Payment\s)/i)) {
      const mpp = parseMppHeader(part.trim());
      if (mpp && mpp.method === "tempo") out.push({ rail: mpp.intent === "session" ? "mpp-tempo-session" : "mpp-tempo-charge", mpp, raw: part });
    }
  }

  // x402 v2 (PingPay / Coinbase): PAYMENT-REQUIRED header
  const pr = res.headers.get("payment-required") ?? res.headers.get("PAYMENT-REQUIRED");
  if (pr) out.push(...parsePaymentRequiredHeader(pr));

  const body: any = await res
    .clone()
    .json()
    .catch(() => null);
  // x402 v1: JSON body with accepts[]
  if (body && Array.isArray(body.accepts)) {
    const version: 1 | 2 = body.x402Version === 2 ? 2 : 1;
    pushX402Accepts(out, body.accepts, version, body, typeof body.resource === "string" ? body.resource : "");
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
    const version = req.x402Version === 2 ? 2 : 1;
    const payment = {
      x402Version: version,
      scheme: "exact",
      network: req.network,
      payload: { signature: mpcToHex(signed.signature), authorization: signed.authorization },
    };
    const encoded = Buffer.from(JSON.stringify(payment)).toString("base64");
    // v2 (PingPay): PAYMENT-SIGNATURE. v1: X-PAYMENT. Send both for mixed gateways.
    if (version === 2) return { "PAYMENT-SIGNATURE": encoded, "X-PAYMENT": encoded };
    return { "X-PAYMENT": encoded };
  }
  if ((challenge.rail === "mpp-tempo-charge" || challenge.rail === "mpp-tempo-session") && (signed.rail === "mpp-tempo-charge" || signed.rail === "mpp-tempo-session")) {
    // Allow when Tempo is on, or offline seller-mesh (mock MPP sellers).
    if (!network().tempo.enabled && !env().USE_SELLER_MESH) {
      throw new Error("Tempo rail disabled (TEMPO_ENABLED=false) — set TEMPO_ENABLED to pay MPP services outside x402");
    }
    const credential = { challenge: { id: challenge.mpp.id, method: challenge.mpp.method, intent: challenge.mpp.intent }, source: signed.source, payload: { type: "transaction", signature: signed.signed_tx } };
    return { Authorization: `Payment ${Buffer.from(JSON.stringify(credential)).toString("base64url")}` };
  }
  if (challenge.rail === "x402-near" && signed.rail === "x402-near") {
    const version = challenge.requirement.x402Version === 2 ? 2 : 1;
    const payment = { x402Version: version, scheme: "exact", network: challenge.requirement.network, payload: { signedDelegateAction: signed.signed_delegate } };
    const encoded = Buffer.from(JSON.stringify(payment)).toString("base64");
    if (version === 2) return { "PAYMENT-SIGNATURE": encoded, "X-PAYMENT": encoded };
    return { "X-PAYMENT": encoded };
  }
  throw new Error(`rail mismatch: challenge ${challenge.rail} vs signed ${signed.rail}`);
}

/** Pull the settlement tx from the seller's response (x402 v1/v2 + MPP). */
export function settlementTx(res: Response): string | null {
  for (const name of ["payment-response", "PAYMENT-RESPONSE", "x-payment-response"]) {
    const x = res.headers.get(name);
    if (!x) continue;
    const j = b64Json(x);
    if (j?.transaction) return String(j.transaction);
    if (j?.txHash) return String(j.txHash);
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

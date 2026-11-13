import { createPublicKey, verify as verifySig, type KeyObject } from "node:crypto";
import { env, HttpError } from "@builderos/shared";

/**
 * Privy identity tokens (ES256 JWTs) carry the person's linked accounts (email, Google, wallets).
 * We use one only to learn a verified email for the account that signed in — never for identity or
 * access, which always come from the NEP-413 signature and the chain.
 *
 * Checks: signature (Privy verification key, or Privy's JWKS), iss = privy.io, aud = PRIVY_APP_ID, not expired,
 * and that one of the token's linked wallets is the account (or key) that signed in.
 */

export type PrivyIdentity = { userId: string; email: string | null; wallets: string[] };

let jwksCache: { at: number; keys: Map<string, KeyObject> } | null = null;

async function jwksKeys(): Promise<Map<string, KeyObject>> {
  if (jwksCache && Date.now() - jwksCache.at < 3_600_000) return jwksCache.keys;
  const e = env();
  const url = e.PRIVY_JWKS_URL ?? `https://auth.privy.io/api/v1/apps/${e.PRIVY_APP_ID}/jwks.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`privy jwks ${res.status}`);
  const body = (await res.json()) as { keys?: Array<Record<string, any>> };
  const keys = new Map<string, KeyObject>();
  for (const k of body.keys ?? []) if (k.kid && k.kty === "EC") keys.set(k.kid, createPublicKey({ key: k as any, format: "jwk" }));
  jwksCache = { at: Date.now(), keys };
  return keys;
}

const b64urlJson = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

/** Test hook: inject a verification key without env / network. */
let testKey: KeyObject | null = null;
export function setPrivyTestKey(k: KeyObject | null) {
  testKey = k;
}

export async function verifyPrivyIdentityToken(token: string): Promise<PrivyIdentity> {
  const e = env();
  if (!e.PRIVY_APP_ID && !testKey) throw new HttpError(503, "Privy isn't configured on this server (PRIVY_APP_ID).", "privy_unavailable");
  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(400, "not a Privy identity token", "invalid_request");
  let header: any, claims: any;
  try {
    header = b64urlJson(parts[0]);
    claims = b64urlJson(parts[1]);
  } catch {
    throw new HttpError(400, "not a Privy identity token", "invalid_request");
  }
  if (header.alg !== "ES256") throw new HttpError(401, "unexpected token algorithm", "bad_privy_token");

  let key: KeyObject | undefined = testKey ?? undefined;
  if (!key && e.PRIVY_VERIFICATION_KEY) key = createPublicKey(e.PRIVY_VERIFICATION_KEY.replace(/\\n/g, "\n"));
  if (!key) key = (await jwksKeys().catch(() => new Map<string, KeyObject>())).get(header.kid);
  if (!key) throw new HttpError(503, "Couldn't load Privy's verification key. Try again.", "privy_unavailable");

  const ok = verifySig("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(parts[2], "base64url"));
  if (!ok) throw new HttpError(401, "Privy token signature is invalid", "bad_privy_token");
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== "privy.io") throw new HttpError(401, "Privy token issuer mismatch", "bad_privy_token");
  const appId = e.PRIVY_APP_ID ?? claims.aud;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(appId)) throw new HttpError(401, "Privy token is for another app", "bad_privy_token");
  if (typeof claims.exp !== "number" || claims.exp < now - 30) throw new HttpError(401, "Privy token expired — sign in again", "bad_privy_token");

  // linked_accounts is a JSON string in identity tokens (an array in some SDK versions).
  let linked: any[] = [];
  try {
    linked = typeof claims.linked_accounts === "string" ? JSON.parse(claims.linked_accounts) : Array.isArray(claims.linked_accounts) ? claims.linked_accounts : [];
  } catch {
    linked = [];
  }
  const emailAcct =
    linked.find((a) => a?.type === "email" && a.address) ??
    linked.find((a) => /_oauth$/.test(String(a?.type ?? "")) && a.email);
  const email = emailAcct ? String(emailAcct.address ?? emailAcct.email).trim().toLowerCase() : null;
  const wallets = linked
    .filter((a) => a?.type === "wallet" || a?.type === "smart_wallet")
    .flatMap((a) => [a.address, a.public_key, a.publicKey].filter(Boolean).map((x: unknown) => String(x).toLowerCase()));
  return { userId: String(claims.sub ?? ""), email, wallets };
}

/** True when one of the token's wallets is this account or this ed25519 key (hex, base58, with or without prefix). */
export function privyWalletMatches(id: PrivyIdentity, account: string, publicKey: string | null, publicKeyHex: string | null) {
  const want = new Set(
    [account, publicKey, publicKey?.replace(/^ed25519:/, ""), publicKeyHex, publicKeyHex ? `0x${publicKeyHex}` : null]
      .filter((x): x is string => Boolean(x))
      .map((x) => x.toLowerCase()),
  );
  return id.wallets.some((w) => want.has(w));
}

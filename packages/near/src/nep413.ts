import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import bs58 from "bs58";
import { accessKeys } from "./rpc.js";

/**
 * NEP-413 signMessage verification — what wallet-selector's `wallet.signMessage()` produces.
 * Payload = borsh({ tag: u32 = 2^31 + 413, message: string, nonce: [u8;32], recipient: string, callbackUrl: Option<string> })
 */
const TAG = 2 ** 31 + 413;

function borshString(s: string) {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
}

export function nep413Payload(p: { message: string; nonce: Uint8Array; recipient: string; callbackUrl?: string }) {
  if (p.nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(TAG);
  const cb = p.callbackUrl ? Buffer.concat([Buffer.from([1]), borshString(p.callbackUrl)]) : Buffer.from([0]);
  return Buffer.concat([tag, borshString(p.message), Buffer.from(p.nonce), borshString(p.recipient), cb]);
}

export function parsePublicKey(pk: string): Uint8Array {
  const [curve, data] = pk.split(":");
  if (curve !== "ed25519" || !data) throw new Error("only ed25519 keys are supported");
  return bs58.decode(data);
}

export function verifyNep413(p: {
  publicKey: string;
  signature: string; // base64
  message: string;
  nonce: Uint8Array;
  recipient: string;
  callbackUrl?: string;
}): boolean {
  const hash = sha256(nep413Payload(p));
  const sig = Buffer.from(p.signature, "base64");
  try {
    return ed25519.verify(sig, hash, parsePublicKey(p.publicKey));
  } catch {
    return false;
  }
}

/** NEAR-implicit account id = lowercase hex of the 32-byte ed25519 public key (Privy / email wallets). */
export function publicKeyToImplicitAccountId(publicKey: string): string {
  return Buffer.from(parsePublicKey(publicKey)).toString("hex");
}

export function isImplicitAccountId(accountId: string): boolean {
  return /^[0-9a-f]{64}$/.test(accountId);
}

/** True when accountId is the implicit address controlled by this ed25519 key (even before first on-chain tx). */
export function matchesImplicitAccount(accountId: string, publicKey: string): boolean {
  if (!isImplicitAccountId(accountId)) return false;
  try {
    return publicKeyToImplicitAccountId(publicKey) === accountId;
  } catch {
    return false;
  }
}

/**
 * Person login key check.
 * - Named / funded accounts: key must be FullAccess on-chain (FC keys cannot log humans in).
 * - Privy / unfunded implicit accounts: account may not exist on RPC yet; accept when accountId === hex(pubkey)
 *   after NEP-413 already proved key ownership.
 */
export async function isFullAccessKey(accountId: string, publicKey: string) {
  try {
    const keys = await accessKeys(accountId);
    return keys.some((k) => k.public_key === publicKey && k.access_key.permission === "FullAccess");
  } catch {
    return matchesImplicitAccount(accountId, publicKey);
  }
}

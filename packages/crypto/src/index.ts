import { createRequire } from "node:module";
// libsodium-wrappers 0.7.x ships a broken ESM entry; load the CJS build.
const sodiumMod: any = createRequire(import.meta.url)("libsodium-wrappers");
import { createHash, createHmac, randomBytes } from "node:crypto";

/**
 * Private by default: plans, build logs, invoices and agent reasoning are sealed with
 * XChaCha20-Poly1305 before they touch Postgres or object storage. Only hashes go on chain.
 */
let ready: Promise<any> | undefined;
export async function sodium() {
  ready ??= sodiumMod.ready.then(() => sodiumMod);
  return ready;
}

export type Sealed = { v: 1; keyVersion: number; nonce: string; ct: string };

/** Symmetric seal with a 32-byte key (code key / log key). Output is JSON-serialisable. */
export async function seal(plaintext: string | Uint8Array, key: Uint8Array, keyVersion: number, aad = ""): Promise<Sealed> {
  const s = await sodium();
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const msg = typeof plaintext === "string" ? s.from_string(plaintext) : plaintext;
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(msg, aad || null, null, nonce, key);
  return { v: 1, keyVersion, nonce: s.to_base64(nonce), ct: s.to_base64(ct) };
}

export async function open(sealed: Sealed, key: Uint8Array, aad = ""): Promise<Uint8Array> {
  const s = await sodium();
  return s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, s.from_base64(sealed.ct), aad || null, s.from_base64(sealed.nonce), key);
}

export async function openString(sealed: Sealed, key: Uint8Array, aad = "") {
  const s = await sodium();
  return s.to_string(await open(sealed, key, aad));
}

export const serialize = (s: Sealed) => Buffer.from(JSON.stringify(s)).toString("base64");
export const deserialize = (b64: string): Sealed => JSON.parse(Buffer.from(b64, "base64").toString("utf8"));

/** Wrap a symmetric key to a member's x25519 view key (sealed box; only the member can open). */
export async function wrapKey(key: Uint8Array, recipientX25519Pub: Uint8Array) {
  const s = await sodium();
  return s.to_base64(s.crypto_box_seal(key, recipientX25519Pub));
}
export async function unwrapKey(wrapped: string, pub: Uint8Array, secret: Uint8Array) {
  const s = await sodium();
  return s.crypto_box_seal_open(s.from_base64(wrapped), pub, secret);
}

export async function x25519Keypair() {
  const s = await sodium();
  const kp = s.crypto_box_keypair();
  return { publicKey: s.to_base64(kp.publicKey), secretKey: s.to_base64(kp.privateKey) };
}
export async function fromB64(b64: string) {
  return (await sodium()).from_base64(b64);
}

export const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
export const hmacHex = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** Process-level data key for server-held private data (emails, plan text before a company code key exists). */
export function serverKey(secret: string): Uint8Array {
  return createHash("sha256").update(`builderos:server-key:${secret}`).digest();
}

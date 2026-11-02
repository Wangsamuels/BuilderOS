import fs from "node:fs";
import { scryptSync, randomBytes } from "node:crypto";
import { env } from "@builderos/shared";
import { deserialize, openString, seal, serialize } from "@builderos/crypto";

/**
 * Encrypted agent keystore. Each agent holds a request-only NEAR function-call key.
 * Loaded once at start, never logged. On Heroku (no disk) the blob comes from AGENT_KEYSTORE_JSON.
 */
export type AgentKey = { accountId: string; privateKey: string; publicKey: string; role: string; departmentId: string; maxTier?: string };
type File = { v: 1; salt: string; sealed: string };

function derive(pass: string, salt: Buffer) {
  return new Uint8Array(scryptSync(pass, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
}

export async function encryptKeystore(keys: AgentKey[], passphrase: string): Promise<string> {
  const salt = randomBytes(16);
  const sealed = await seal(JSON.stringify(keys), derive(passphrase, salt), 1, "agent-keystore");
  return JSON.stringify({ v: 1, salt: salt.toString("base64"), sealed: serialize(sealed) } satisfies File);
}

let loaded: AgentKey[] | undefined;
export async function loadKeystore(): Promise<AgentKey[]> {
  if (loaded) return loaded;
  const e = env();
  const raw = e.AGENT_KEYSTORE_JSON ?? (fs.existsSync(e.AGENT_KEYSTORE_PATH) ? fs.readFileSync(e.AGENT_KEYSTORE_PATH, "utf8") : null);
  if (!raw) return (loaded = []);
  if (!e.AGENT_KEYSTORE_PASSPHRASE) throw new Error("AGENT_KEYSTORE_PASSPHRASE not set");
  const f = JSON.parse(raw) as File;
  const json = await openString(deserialize(f.sealed), derive(e.AGENT_KEYSTORE_PASSPHRASE, Buffer.from(f.salt, "base64")), "agent-keystore");
  loaded = JSON.parse(json) as AgentKey[];
  return loaded;
}

/** "Fire" deletes the key from the in-memory store (the contract-side key deletion is the founder's tx). */
export function forgetAgent(publicKey: string) {
  loaded = loaded?.filter((k) => k.publicKey !== publicKey);
}

export async function agentFor(departmentId: string, role: string): Promise<AgentKey | undefined> {
  const keys = await loadKeystore();
  return keys.find((k) => k.departmentId === departmentId && k.role === role) ?? keys.find((k) => k.departmentId === departmentId);
}

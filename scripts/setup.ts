/**
 * `pnpm run setup` (note: plain `pnpm setup` is a pnpm built-in).
 *  - writes .env from .env.example with a fresh SESSION_SECRET (if .env is missing)
 *  - generates VAPID keys for web push
 *  - generates one request-only ed25519 key per agent role per department and writes the
 *    encrypted keystore (keystore/agents.json). Add each public key on chain as a function-call
 *    key limited to request_purchase/record_response (the founder signs that).
 * Testnet keys are created here and never pushed (keystore/*.json is git-ignored).
 */
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { KeyPair } from "near-api-js";
import webpush from "web-push";
import { encryptKeystore, type AgentKey } from "../packages/orchestrator/src/keystore.js";

const ROLES = ["frontend", "backend", "contracts", "security", "devops", "designer", "writer", "qa", "scout", "buyer", "controller", "ops", "growth", "support"];

async function main() {
  if (!fs.existsSync(".env")) {
    let text = fs.readFileSync(".env.example", "utf8");
    text = text.replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${randomBytes(32).toString("base64url")}`);
    const vapid = webpush.generateVAPIDKeys();
    text = text.replace(/^VAPID_PUBLIC_KEY=.*$/m, `VAPID_PUBLIC_KEY=${vapid.publicKey}`).replace(/^VAPID_PRIVATE_KEY=.*$/m, `VAPID_PRIVATE_KEY=${vapid.privateKey}`);
    const pass = randomBytes(24).toString("base64url");
    text = text.replace(/^AGENT_KEYSTORE_PASSPHRASE=.*$/m, `AGENT_KEYSTORE_PASSPHRASE=${pass}`);
    fs.writeFileSync(".env", text);
    console.log("wrote .env");
  }
  const env = Object.fromEntries(
    fs
      .readFileSync(".env", "utf8")
      .split("\n")
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  const departments = (process.env.SETUP_DEPARTMENTS ?? `build.demo.${env.FACTORY_CONTRACT ?? "builderos.testnet"},ops.demo.${env.FACTORY_CONTRACT ?? "builderos.testnet"},growth.demo.${env.FACTORY_CONTRACT ?? "builderos.testnet"}`).split(",");
  const keys: AgentKey[] = [];
  for (const dept of departments)
    for (const role of ROLES) {
      const kp = KeyPair.fromRandom("ed25519");
      keys.push({ accountId: dept, departmentId: dept, role, privateKey: kp.toString(), publicKey: kp.getPublicKey().toString() });
    }
  fs.mkdirSync("keystore", { recursive: true });
  const path = env.AGENT_KEYSTORE_PATH ?? "./keystore/agents.json";
  fs.writeFileSync(path, await encryptKeystore(keys, env.AGENT_KEYSTORE_PASSPHRASE));
  fs.writeFileSync("keystore/agents.public.json", JSON.stringify(keys.map(({ privateKey: _p, ...k }) => k), null, 2));
  console.log(`wrote ${path} (${keys.length} agent keys, encrypted) and keystore/agents.public.json`);
  console.log("Heroku: heroku config:set AGENT_KEYSTORE_JSON=\"$(cat keystore/agents.json)\" AGENT_KEYSTORE_PASSPHRASE=...");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

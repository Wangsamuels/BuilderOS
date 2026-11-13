/**
 * Authenticated end-to-end run against a BuilderOS API + NEAR testnet.
 *
 *   API=http://localhost:8787 FOUNDER_KEY=/path/key.json INVITEE_KEY=/path/key.json npx tsx tests/e2e/live.mts
 *
 * Key files: {"sk":"<hex seed>","pk":"ed25519:…","implicit":"<64 hex>"} — the implicit accounts must hold
 * testnet NEAR (founder ≥ 13, invitee ≥ 0.1). Every transaction the API returns is signed and sent, and
 * checked on chain. Evidence is printed with tokens and keys redacted.
 * Optional: SESSION_SECRET (same as the API's) lets the run read the invite code it created (local API only).
 */
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";

process.env.NETWORK ??= "testnet";
process.env.FACTORY_CONTRACT ??= "builderos-wang.testnet";
process.env.DATABASE_URL ??= "postgres://unused@127.0.0.1/unused";
process.env.SESSION_SECRET ??= "e2e-placeholder-".repeat(3);

const { nep413Payload } = await import("../../packages/near/src/nep413.ts");
const { serviceAccount } = await import("../../packages/near/src/signer.ts");
const { transactions: nearTx } = await import("near-api-js");
const { createHash } = await import("node:crypto");

const API = (process.env.API ?? "http://localhost:8787").replace(/\/$/, "");
const ORIGIN = process.env.ORIGIN ?? "https://builder-os-mu.vercel.app";
const FACTORY = process.env.FACTORY_CONTRACT!;
type Key = { sk: string; pk: string; implicit: string };
const founderKey: Key = JSON.parse(fs.readFileSync(process.env.FOUNDER_KEY!, "utf8"));
const inviteeKey: Key | null = process.env.INVITEE_KEY ? JSON.parse(fs.readFileSync(process.env.INVITEE_KEY, "utf8")) : null;

type Ev = { step: string; req: string; status: number | string; ok: boolean; note?: string; sample?: unknown };
const evidence: Ev[] = [];
const redact = (v: unknown): unknown =>
  JSON.parse(
    JSON.stringify(v ?? null)
      .replace(/"token":"[^"]+"/g, '"token":"<redacted>"')
      .replace(/st_[A-Za-z0-9_-]{20,}/g, "st_<redacted>")
      .replace(/token=[^"&]+/g, "token=<redacted>"),
  );
function record(step: string, req: string, status: number | string, ok: boolean, note?: string, sample?: unknown) {
  evidence.push({ step, req, status, ok, note, sample: sample === undefined ? undefined : redact(sample) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step.padEnd(46)} ${req.padEnd(58)} ${String(status).padEnd(4)} ${note ?? ""}`);
  fs.writeFileSync(process.env.EVIDENCE ?? "e2e-evidence.json", JSON.stringify({ api: API, companyId, founder: founderKey.implicit, evidence }, null, 2));
}

async function login(k: Key, claimed = k.implicit) {
  const h = { origin: ORIGIN };
  const ch: any = await (await fetch(`${API}/v1/auth/challenge?accountId=${claimed}`, { headers: h })).json();
  const payload = nep413Payload({ message: ch.message, nonce: Buffer.from(ch.nonce, "base64"), recipient: ch.recipient });
  const sig = ed25519.sign(createHash("sha256").update(payload).digest(), Buffer.from(k.sk, "hex"));
  const r = await fetch(`${API}/v1/auth/verify`, {
    method: "POST",
    headers: { ...h, "content-type": "application/json" },
    body: JSON.stringify({ accountId: claimed, publicKey: k.pk, signature: Buffer.from(sig).toString("base64"), message: ch.message, nonce: ch.nonce }),
  });
  const v: any = await r.json();
  if (!v.token) throw new Error(`login failed: ${JSON.stringify(v)}`);
  return v as { token: string; accountId: string };
}

function client(token: string) {
  return async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { origin: ORIGIN, authorization: `Bearer ${token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") headers["idempotency-key"] = crypto.randomUUID();
    const r = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: r.status, json, acao: r.headers.get("access-control-allow-origin") };
  };
}

async function signer(k: Key) {
  const seed = Buffer.from(k.sk, "hex");
  return serviceAccount(k.implicit, "ed25519:" + bs58.encode(Buffer.concat([seed, ed25519.getPublicKey(seed)])));
}

/** Sign and send wallet-selector shaped txs in order; returns tx hashes; throws on any on-chain failure. */
async function signAll(account: any, txs: any[]) {
  const hashes: string[] = [];
  for (const t of txs) {
    const actions = t.actions.map((a: any) =>
      nearTx.functionCall(a.params.methodName, a.params.args, BigInt(a.params.gas), BigInt(a.params.deposit)),
    );
    const out: any = await account.signAndSendTransaction({ receiverId: t.receiverId, actions });
    const failed = [out.status, ...out.receipts_outcome.map((o: any) => o.outcome.status)].find((s: any) => s && s.Failure);
    if (failed) throw new Error(`tx ${out.transaction.hash} failed: ${JSON.stringify(failed.Failure).slice(0, 300)}`);
    hashes.push(out.transaction.hash);
  }
  return hashes;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const expect = (step: string, req: string, r: { status: number; json: any }, want: number | number[], check?: (j: any) => string | null, sample?: (j: any) => unknown) => {
  const wants = Array.isArray(want) ? want : [want];
  let ok = wants.includes(r.status);
  let note = ok ? undefined : `want ${wants.join("/")}: ${JSON.stringify(r.json).slice(0, 160)}`;
  if (ok && check) {
    const bad = check(r.json);
    if (bad) {
      ok = false;
      note = bad;
    }
  }
  let smp: unknown;
  try {
    smp = sample ? sample(r.json) : undefined;
  } catch {
    smp = r.json;
  }
  record(step, req, r.status, ok, note, smp);
  return ok;
};

/** dept_call rule: receiver = company, 1..12 inner calls, deposit = number of calls (yocto). */
function checkDeptCall(txs: any[], companyId: string): string | null {
  for (const t of txs) {
    const a = t.actions[0].params;
    if (a.methodName !== "dept_call") continue;
    if (t.receiverId !== companyId) return `dept_call receiver ${t.receiverId}`;
    const n = a.args.calls.length;
    if (n < 1 || n > 12) return `dept_call with ${n} calls`;
    if (a.deposit !== String(n)) return `dept_call deposit ${a.deposit} for ${n} calls`;
  }
  return null;
}

// ======================================================================================
const slug = process.env.SLUG ?? `e2e${Date.now().toString(36)}`;
const companyId = `${slug}.${FACTORY}`;
console.log(`API ${API}\ncompany ${companyId}\nfounder ${founderKey.implicit}\n`);

// ---- 0. CORS + health
{
  const r = await fetch(`${API}/v1/companies`, { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type,idempotency-key,last-event-id" } });
  record("CORS preflight (auth + idempotency headers)", "OPTIONS /v1/companies", r.status, r.status === 204 && r.headers.get("access-control-allow-origin") === ORIGIN && /idempotency-key/.test(r.headers.get("access-control-allow-headers") ?? ""));
  const u = await fetch(`${API}/v1/companies/demo`, { headers: { origin: ORIGIN } });
  record("unauthenticated → 401 unauthenticated", "GET /v1/companies/demo", u.status, u.status === 401 && (await u.json()).code === "unauthenticated");
}

// ---- 1. outsider
const outsiderKey: Key = (() => {
  const sk = ed25519.utils.randomPrivateKey();
  const pk = ed25519.getPublicKey(sk);
  return { sk: Buffer.from(sk).toString("hex"), pk: "ed25519:" + bs58.encode(pk), implicit: Buffer.from(pk).toString("hex") };
})();
const out = client((await login(outsiderKey)).token);
expect("outsider: /auth/me lists no companies", "GET /v1/auth/me", await out("GET", "/v1/auth/me"), 200, (j) => (Array.isArray(j.companies) && j.companies.length === 0 ? null : "companies not empty"));
for (const id of ["demo", `demo.${FACTORY}`]) expect(`outsider denied (${id.includes(".") ? "full id" : "slug"})`, `GET /v1/companies/${id}`, await out("GET", `/v1/companies/${id}`), 403, (j) => (j.code === "forbidden" ? null : "code != forbidden"), (j) => j);
expect("outsider denied stream for demo", "GET /v1/stream?companyId=demo", await out("GET", "/v1/stream?companyId=demo"), 403);
expect("outsider denied deposit for demo", "GET /v1/deposit?companyId=demo", await out("GET", "/v1/deposit?companyId=demo"), 403);
expect("outsider denied founder-only freeze", "POST /v1/freeze", await out("POST", "/v1/freeze", { companyId: "demo" }), 403);
expect("unsupported feature → 501 not_implemented", "GET /v1/leaderboard?companyId=demo", await out("GET", "/v1/leaderboard?companyId=demo"), 501, (j) => (j.code === "not_implemented" && j.details?.feature ? null : "bad 501 shape"), (j) => j);
expect("validation error → 400 invalid_request", "POST /v1/companies (bad slug)", await out("POST", "/v1/companies", { name: "x", slug: "Bad Slug!" }), 400, (j) => (j.code === "invalid_request" ? null : "code"));

// ---- 2. founder creates a company (fresh user)
const founderSession = await login(founderKey);
record("founder session resolves to implicit account", "POST /v1/auth/verify", 200, founderSession.accountId === founderKey.implicit, founderSession.accountId);
let fo = client(founderSession.token);
const founderAcct = await signer(founderKey);

// Founders need a verified email before creating a company (API 2026-11-13). Production emails the code:
// first run sends it (FOUNDER_EMAIL) and stops; run again with EMAIL_CODE=<code>. Verification is per account,
// so a founder key that's already verified skips this.
{
  const acct = await fo("GET", "/v1/account");
  if (!acct.json?.email?.verified) {
    if (process.env.EMAIL_CODE) {
      const v = await fo("POST", "/v1/account/email/verify", { code: process.env.EMAIL_CODE });
      expect("founder verifies email with the emailed code", "POST /v1/account/email/verify", v, 200);
    } else {
      if (!process.env.FOUNDER_EMAIL) throw new Error("this founder has no verified email: set FOUNDER_EMAIL (we send a code), then re-run with EMAIL_CODE");
      const sent = await fo("POST", "/v1/account/email", { email: process.env.FOUNDER_EMAIL });
      if (sent.json?.devCode) {
        expect("founder verifies email (dev echo)", "POST /v1/account/email/verify", await fo("POST", "/v1/account/email/verify", { code: sent.json.devCode }), 200);
      } else {
        console.log(`Code sent to ${sent.json?.sentTo ?? process.env.FOUNDER_EMAIL} (${sent.status}). Re-run with EMAIL_CODE=<code> within 10 minutes.`);
        process.exit(2);
      }
    }
  }
}

const create = await fo("POST", "/v1/companies", { name: `E2E ${slug}`, slug: companyId /* full id on purpose: must normalise */, preset: "starter", dailyCap: "2000000", teams: [{ team: "eng", monthlyCap: "5000000" }] });
expect(process.env.SLUG ? "create on existing slug → resume/complete" : "create returns unsigned bundle", "POST /v1/companies", create, 200, (j) => (j.companyId === companyId && (process.env.SLUG ? j.resumed === true : j.transactions.length >= 2) ? null : "bundle shape"), (j) => ({ companyId: j.companyId, resumed: j.resumed, complete: j.complete, txs: j.transactions.map((t: any) => `${t.receiverId}:${t.actions[0].params.methodName}`), requiredYocto: j.requiredYocto }));
if (create.json.transactions?.length) {
  const createHashes = await signAll(founderAcct, create.json.transactions);
  record("create bundle signed + executed on chain", "NEAR txs", "ok", true, `${createHashes.length} txs`, createHashes);
}

let done = false;
for (let i = 0; i < 30 && !done; i++) {
  const c = await fo("GET", `/v1/companies/creation/${slug}`);
  done = c.json.companyExists && c.json.departments?.length === 1;
  if (done) expect("creation status confirms company + team", `GET /v1/companies/creation/${slug}`, c, 200, null as any, (j) => j);
  else await sleep(2000);
}
if (!done) record("creation status confirms company + team", `GET /v1/companies/creation/${slug}`, "timeout", false);

const checkMe = (label: string) => async () =>
  expect(label, "GET /v1/auth/me", await fo("GET", "/v1/auth/me"), 200, (j) => {
    const m = j.companies.find((c: any) => c.companyId === companyId);
    return m && m.isFounder === true && m.slug === slug ? null : "company missing or isFounder != true";
  }, (j) => ({ accountId: j.accountId, companies: j.companies }));
await checkMe("/auth/me lists the new company, isFounder")();
expect("/auth/setup lists it too", "GET /v1/auth/setup", await fo("GET", "/v1/auth/setup"), 200, (j) => (j.companyIds.includes(companyId) ? null : "missing"));
for (const id of [slug, companyId])
  expect(`founder reads company (${id.includes(".") ? "full id" : "slug"})`, `GET /v1/companies/${id}`, await fo("GET", `/v1/companies/${id}`), 200, (j) => (j.access.founder === true && j.companyId === companyId ? null : "access.founder != true"), (j) => ({ companyId: j.companyId, slug: j.slug, access: j.access, departments: j.departments.map((d: any) => d.id) }));

// sign out and back in
expect("logout", "POST /v1/auth/logout", await fo("POST", "/v1/auth/logout", {}), 200);
expect("old token rejected after logout", "GET /v1/auth/me", await fo("GET", "/v1/auth/me"), 401);
fo = client((await login(founderKey)).token);
await checkMe("after sign-in again: still founder")();

// ---- 3. teams / deposit / payments
expect("teams: budgets + agents (micro-USDC)", `GET /v1/teams?companyId=${slug}`, await fo("GET", `/v1/teams?companyId=${slug}`), 200, (j) => (process.env.SLUG ? (/^\d+$/.test(j.teams[0]?.budget) ? null : "budget not an integer string") : j.teams[0]?.budget === "5000000" ? null : `budget ${j.teams[0]?.budget}`), (j) => j.teams.map((t: any) => ({ name: t.name, budget: t.budget, spent: t.spent, available: t.available, perTxLimit: t.perTxLimit, paymentAddress: t.paymentAddress })));
expect("deposit: honest testnet answer + team balances", `GET /v1/deposit?companyId=${slug}`, await fo("GET", `/v1/deposit?companyId=${slug}`), 200, (j) => (j.supported === false && j.teams.length === 1 && j.teams[0].address ? null : "shape"), (j) => j);
expect("team payment addresses", `GET /v1/companies/${slug}/payments`, await fo("GET", `/v1/companies/${slug}/payments`), 200, (j) => (j.teams[0]?.configured ? null : "not configured"), (j) => j.teams);

// ---- 4. plan → edit → approve → sign
const plan = await fo("POST", "/v1/plans", { companyId: slug, description: "Build an API endpoint for signups and a landing page with a waitlist form.", tier: "economy" });
expect("create plan", "POST /v1/plans", plan, 200, (j) => (j.plan?.features?.length ? null : "no features"), (j) => ({ id: j.plan.id, features: j.plan.features.map((f: any) => f.key), estimate: { p50: j.plan.estimate.p50, cap: j.plan.estimate.cap } }));
const planId = plan.json.plan.id;
if (plan.json.plan.features.length > 1) {
  const drop = plan.json.plan.features[plan.json.plan.features.length - 1].key;
  expect("edit draft plan (remove a step)", `PATCH /v1/plans/${planId}`, await fo("PATCH", `/v1/plans/${planId}`, { removeKeys: [drop] }), 200, (j) => (j.plan.features.some((f: any) => f.key === drop) ? "step still there" : null), (j) => ({ features: j.plan.features.map((f: any) => f.key), cap: j.plan.estimate.cap }));
}
const approve = await fo("POST", `/v1/plans/${planId}/approve`, {});
expect("approve plan → dept_call txs (company, ≤12 calls, deposit = calls)", `POST /v1/plans/${planId}/approve`, approve, 200, (j) => checkDeptCall(j.transactions, companyId), (j) => j.transactions.map((t: any) => ({ receiverId: t.receiverId, method: t.actions[0].params.methodName, calls: t.actions[0].params.args.calls.length, deposit: t.actions[0].params.deposit, signerId: t.signerId })));
const retry = await fo("POST", `/v1/plans/${planId}/approve`, {});
expect("approve again before signing → same txs (resumed)", `POST /v1/plans/${planId}/approve`, retry, 200, (j) => (j.resumed === true ? null : "not resumed"));
const approveHashes = await signAll(founderAcct, approve.json.transactions);
record("plan approval signed + executed on chain", "NEAR txs", "ok", true, `${approveHashes.length} tx`, approveHashes);
const editAfter = await fo("PATCH", `/v1/plans/${planId}`, { tier: "standard" });
expect("edit approved plan → 409 plan_already_approved", `PATCH /v1/plans/${planId}`, editAfter, 409, (j) => (j.code === "plan_already_approved" ? null : j.code));

const taskList = await fo("GET", `/v1/tasks?companyId=${slug}&planId=${planId}`);
expect("task list", "GET /v1/tasks", taskList, 200, (j) => (j.tasks.length ? null : "empty"));
const taskId = taskList.json.tasks[0].id;
expect("task details", `GET /v1/tasks/${taskId}`, await fo("GET", `/v1/tasks/${taskId}`), 200, (j) => (j.task.id === taskId ? null : "id"), (j) => ({ id: j.task.id, tier: j.task.tier, cap: j.task.cap, status: j.task.status }));
expect("task estimate (tiers)", "POST /v1/estimate", await fo("POST", "/v1/estimate", { taskId }), 200, (j) => (j.tiers.length === 4 ? null : "tiers"), (j) => ({ estimate: j.estimate, units: j.units }));
const tierTx = await fo("PATCH", `/v1/tasks/${taskId}`, { tier: "standard" });
expect("change task tier → dept_call set_task_tier", `PATCH /v1/tasks/${taskId}`, tierTx, 200, (j) => checkDeptCall(j.transactions, companyId) ?? (j.transactions.length === 1 ? null : "transactions[]"));
record("tier change signed + executed on chain", "NEAR tx", "ok", true, undefined, await signAll(founderAcct, tierTx.json.transactions));

// ---- 5. pause / resume / caps / policy / refund
const fz = await fo("POST", "/v1/freeze", { companyId: slug });
expect("pause all → company.freeze (1 yocto)", "POST /v1/freeze", fz, 200, (j) => (j.transactions[0].receiverId === companyId && j.transactions[0].actions[0].params.methodName === "freeze" ? null : "shape"));
record("pause signed + executed on chain", "NEAR tx", "ok", true, undefined, await signAll(founderAcct, fz.json.transactions));
const uf = await fo("POST", "/v1/unfreeze", { companyId: slug });
expect("resume → company.unfreeze (founder)", "POST /v1/unfreeze", uf, 200, (j) => (j.transactions[0].actions[0].params.methodName === "unfreeze" ? null : "shape"));
record("resume signed + executed on chain", "NEAR tx", "ok", true, undefined, await signAll(founderAcct, uf.json.transactions));
const cap = await fo("POST", "/v1/policy", { companyId: slug, dailyCap: "3000000" });
expect("policy: daily cap → set_caps", "POST /v1/policy", cap, 200, (j) => (j.transactions[0].actions[0].params.methodName === "set_caps" ? null : "shape"));
record("daily cap signed + executed on chain", "NEAR tx", "ok", true, undefined, await signAll(founderAcct, cap.json.transactions));
const bud = await fo("POST", "/v1/policy", { companyId: slug, team: "eng", budgetIncrease: "1000000" });
expect("policy: raise team budget (needs contract v3)", "POST /v1/policy", bud, [200, 409], (j) => (j.code === "contract_upgrade_required" || j.transactions ? null : "shape"), (j) => (j.code ? { code: j.code, details: j.details } : { methods: j.transactions.map((t: any) => t.actions[0].params.args.calls?.map((c: any) => c.method)) }));
if (bud.status === 200) record("budget raise signed + executed on chain", "NEAR tx", "ok", true, undefined, await signAll(founderAcct, bud.json.transactions));
expect("policy: per-purchase limit → 501", "POST /v1/policy", await fo("POST", "/v1/policy", { companyId: slug, team: "eng", perTxLimit: "1" }), 501, (j) => (j.code === "not_implemented" ? null : j.code));
expect("refund claim with nothing owed → 404", "POST /v1/companies/claim-refund", await fo("POST", "/v1/companies/claim-refund", {}), 404);
expect("approvals inbox", `GET /v1/approvals?companyId=${slug}`, await fo("GET", `/v1/approvals?companyId=${slug}`), 200);
expect("ledger (micro-USDC receipts)", `GET /v1/ledger?companyId=${slug}`, await fo("GET", `/v1/ledger?companyId=${slug}`), 200);
expect("audit (founder)", `GET /v1/audit?companyId=${slug}`, await fo("GET", `/v1/audit?companyId=${slug}`), 200);
expect("tempo floats", `GET /v1/floats/tempo?companyId=${slug}`, await fo("GET", `/v1/floats/tempo?companyId=${slug}`), 200, (j) => (Array.isArray(j.floats) ? null : "floats[]"), (j) => j.floats);
expect("withdrawal plan (testnet: no treasury → 409)", "POST /v1/withdrawals", await fo("POST", "/v1/withdrawals", { companyId: slug, amount: "1000000", token: "usdc", to: founderKey.implicit }), [200, 409], (j) => (j.plan || j.code === "insufficient_funds" ? null : "shape"), (j) => j.code ?? j.plan);

// ---- 6. device keys + rotation
const x25519 = Buffer.from(randomBytes(32)).toString("base64");
const vk = await fo("POST", "/v1/keys/view", { companyId: slug, x25519PublicKey: x25519 });
expect("register view key → tx", "POST /v1/keys/view", vk, 200, (j) => (j.transactions[0].actions[0].params.methodName === "register_view_key" ? null : "shape"));
const [vkHash] = await signAll(founderAcct, vk.json.transactions);
let conf: any;
for (let i = 0; i < 6; i++) {
  conf = await fo("POST", "/v1/keys/view/confirm", { companyId: slug, txHash: vkHash });
  if (conf.status === 200) break;
  await sleep(2000);
}
expect("confirm view key from tx (no indexer wait)", "POST /v1/keys/view/confirm", conf, 200, (j) => (j.x25519PublicKey === x25519 ? null : "key mismatch"));
expect("devices: founder's public key listed", `GET /v1/keys/devices?companyId=${slug}`, await fo("GET", `/v1/keys/devices?companyId=${slug}&kind=code`), 200, (j) => (j.devices.some((d: any) => d.accountId === founderKey.implicit && d.x25519PublicKey === x25519) ? null : "missing"), (j) => ({ codeKeyVersion: j.codeKeyVersion, devices: j.devices.map((d: any) => ({ accountId: d.accountId, founder: d.founder, x25519PublicKey: "<public>" })) }));
const rot = await fo("POST", "/v1/keys/code/rotate", { companyId: slug });
expect("rotate code key → tx + next steps", "POST /v1/keys/code/rotate", rot, 200, (j) => (j.newVersion === j.currentVersion + 1 ? null : "versions"), (j) => ({ currentVersion: j.currentVersion, newVersion: j.newVersion, next: j.next }));
const early = await fo("POST", "/v1/keys/wrapped", { companyId: slug, kind: "code", version: rot.json.newVersion, keys: [{ memberAccount: founderKey.implicit, ciphertext: "dGVzdA==" }] });
expect("upload before rotate lands → 409", "POST /v1/keys/wrapped", early, 409);
await signAll(founderAcct, rot.json.transactions);
const up = await fo("POST", "/v1/keys/wrapped", { companyId: slug, kind: "code", version: rot.json.newVersion, keys: [{ memberAccount: founderKey.implicit, ciphertext: "d3JhcHBlZC1mb3ItdGVzdA==" }] });
expect("upload wrapped keys after rotate", "POST /v1/keys/wrapped", up, 200, (j) => (j.stored === 1 ? null : "stored"));
expect("fetch my wrapped key (versioned)", `GET /v1/keys/wrapped?companyId=${slug}&kind=code`, await fo("GET", `/v1/keys/wrapped?companyId=${slug}&kind=code`), 200, (j) => (j.version === rot.json.newVersion ? null : "version"), (j) => ({ version: j.version, ciphertext: "<opaque>" }));
expect("private ciphertext → 501 planned", "GET /v1/private", await fo("GET", `/v1/private?companyId=${slug}`), 501, (j) => (j.details?.status === "planned" ? null : "shape"), (j) => j);

// ---- 7. stream
const st = await fo("POST", "/v1/stream/token", {});
expect("stream token", "POST /v1/stream/token", st, 200, (j) => (j.token?.startsWith("st_") ? null : "token"), (j) => j);
{
  const ctl = new AbortController();
  const r = await fetch(`${API}/v1/stream?companyId=${slug}&token=${encodeURIComponent(st.json.token)}&lastEventId=0`, { headers: { origin: ORIGIN }, signal: ctl.signal });
  let text = "";
  const reader = r.body!.getReader();
  const until = Date.now() + 6000;
  while (Date.now() < until && !text.includes("event: ready")) {
    const { value, done } = await Promise.race([reader.read(), sleep(6000).then(() => ({ value: undefined, done: true }))]);
    if (done) break;
    text += Buffer.from(value!).toString();
  }
  ctl.abort();
  record("SSE connects with stream token (?token=)", `GET /v1/stream?companyId=${slug}&token=…`, r.status, r.status === 200 && text.includes("event: ready") && r.headers.get("access-control-allow-origin") === ORIGIN, undefined, text.split("\n").filter((l) => l.startsWith("event:") || l.startsWith("data:")).slice(0, 4));
  const bad = await fetch(`${API}/v1/companies/${slug}?token=${encodeURIComponent(st.json.token)}`, { headers: { origin: ORIGIN, authorization: `Bearer ${st.json.token}` } });
  record("stream token refused on other routes", `GET /v1/companies/${slug} (stream token)`, bad.status, bad.status === 401);
}

// ---- 8. invitee: viewer on team eng
if (inviteeKey) {
  const inv = await fo("POST", "/v1/members/invite", { companyId: slug, email: "e2e-invitee@example.com", departments: ["eng"], template: "viewer", expiresInDays: 2 });
  expect("invite viewer → invite tx", "POST /v1/members/invite", inv, 200, (j) => (j.transactions[0].actions[0].params.methodName === "invite" ? null : "shape"));
  await signAll(founderAcct, inv.json.transactions);
  // The code is only emailed. The local run can read it back with the API's SESSION_SECRET.
  let code: string | null = process.env.INVITE_CODE ?? null;
  if (!code && process.env.API_SESSION_SECRET && process.env.API_DATABASE_URL) {
    const pg = (await import("pg")).default;
    const { deserialize, openString, serverKey } = await import("../../packages/crypto/src/index.ts");
    const c = new pg.Client({ connectionString: process.env.API_DATABASE_URL });
    await c.connect();
    const row = (await c.query("select email_ciphertext from invites where id = $1", [inv.json.inviteId])).rows[0];
    await c.end();
    code = JSON.parse(await openString(deserialize(row.email_ciphertext), serverKey(process.env.API_SESSION_SECRET), "invite")).code;
  }
  const mem = client((await login(inviteeKey)).token);
  if (code) {
    expect("invite preview (no email exposed)", "GET /v1/invites/:code", await mem("GET", `/v1/invites/${encodeURIComponent(code)}`), 200, (j) => (j.companyId === companyId && !("email" in j) ? null : "shape"), (j) => j);
    const acc = await mem("POST", "/v1/invites/accept", { code });
    expect("accept invite → accept_invite tx", "POST /v1/invites/accept", acc, 200, (j) => (j.transactions[0].actions[0].params.methodName === "accept_invite" ? null : "shape"));
    await signAll(await signer(inviteeKey), acc.json.transactions);
    let mc = await mem("GET", `/v1/companies/${slug}`);
    for (let i = 0; i < 8 && mc.status !== 200; i++) {
      await sleep(2000); // the grant becomes final a few blocks after accept_invite executes
      mc = await mem("GET", `/v1/companies/${slug}`);
    }
    expect("member reads company: viewer, team eng only", `GET /v1/companies/${slug}`, mc, 200, (j) => (j.access.founder === false && j.access.scopes.includes("view") && j.access.departmentId === `eng.${companyId}` ? null : "access"), (j) => ({ access: j.access, departments: j.departments.map((d: any) => d.id) }));
    expect("member /auth/me lists company, isFounder false", "GET /v1/auth/me", await mem("GET", "/v1/auth/me"), 200, (j) => (j.companies.some((c: any) => c.companyId === companyId && c.isFounder === false) ? null : "missing"), (j) => j.companies);
    expect("viewer denied approvals (needs approve)", `GET /v1/approvals?companyId=${slug}`, await mem("GET", `/v1/approvals?companyId=${slug}`), 403);
    expect("viewer denied audit (admin)", `GET /v1/audit?companyId=${slug}`, await mem("GET", `/v1/audit?companyId=${slug}`), 403);
    expect("viewer denied pause (admin)", "POST /v1/freeze", await mem("POST", "/v1/freeze", { companyId: slug }), 403);
    expect("viewer denied plans (builder)", "POST /v1/plans", await mem("POST", "/v1/plans", { companyId: slug, description: "should not be allowed at all here" }), 403);
    expect("viewer sees own team only", `GET /v1/teams?companyId=${slug}`, await mem("GET", `/v1/teams?companyId=${slug}`), 200, (j) => (j.teams.every((t: any) => t.departmentId === `eng.${companyId}`) ? null : "other teams"));
    expect("viewer members list: only self", `GET /v1/members?companyId=${slug}`, await mem("GET", `/v1/members?companyId=${slug}`), 200, (j) => (j.canManage === false ? null : "canManage"));
    expect("viewer denied devices list", `GET /v1/keys/devices?companyId=${slug}`, await mem("GET", `/v1/keys/devices?companyId=${slug}`), 403);
    // revoke
    const rv = await fo("DELETE", `/v1/members/${inviteeKey.implicit}?companyId=${slug}`);
    expect("founder revokes member → revoke tx", "DELETE /v1/members/:accountId", rv, 200, (j) => (j.transactions[0].actions[0].params.methodName === "revoke" ? null : "shape"));
    await signAll(founderAcct, rv.json.transactions);
    let rd = await mem("GET", `/v1/companies/${slug}`);
    for (let i = 0; i < 8 && rd.status !== 403; i++) {
      await sleep(2000);
      rd = await mem("GET", `/v1/companies/${slug}`);
    }
    expect("revoked member denied", `GET /v1/companies/${slug}`, rd, 403);
  } else record("invitee flow", "-", "skipped", true, "invite code only reachable on a local API (set API_SESSION_SECRET) or INVITE_CODE");
}

const failed = evidence.filter((e) => !e.ok);
console.log(`\n${evidence.length - failed.length}/${evidence.length} passed`);
fs.writeFileSync(process.env.EVIDENCE ?? "e2e-evidence.json", JSON.stringify({ api: API, at: new Date().toISOString(), companyId, founder: founderKey.implicit, evidence }, null, 2));
process.exit(failed.length ? 1 : 0);

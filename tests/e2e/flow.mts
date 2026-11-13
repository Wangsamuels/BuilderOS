/**
 * Full backend flow, end to end over HTTP: sign-in (NEAR wallet + Privy), home with no company, drafts,
 * email, launch from a draft, multiple companies, agent activity, analytics, team reports, inbox, invites,
 * permissions, revoke, preferences, pause/resume and the public demo.
 *
 *   DATABASE_URL=postgres://…/postgres npx tsx tests/e2e/flow.mts
 *
 * Runs the real API (buildApp), the real indexer (processTx) and the real worker event router (handleEvent)
 * against Postgres and `tests/sim/near-sim.ts`, a NEAR testnet stand-in that enforces the contracts' rules and
 * signatures. Use `tests/e2e/live.mts` against real testnet when it's reachable.
 */
import { createHash, generateKeyPairSync, randomBytes, sign as signEs256 } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import pg from "pg";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { NearSim } from "../sim/near-sim.ts";

const FACTORY = "builderos-wang.testnet";
const ORIGIN = "http://localhost:3000";
const sim = new NearSim(FACTORY);
const simSrv = await sim.listen();

// ---------- fresh database ----------
const adminUrl = process.env.DATABASE_URL ?? "postgres://builderos:builderos@localhost:5432/builderos";
const dbName = `bos_e2e_${Date.now().toString(36)}`;
{
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  await c.query(`create database ${dbName}`);
  await c.end();
}
const dbUrl = adminUrl.replace(/\/[^/]+$/, `/${dbName}`);

Object.assign(process.env, {
  NODE_ENV: "development",
  NETWORK: "testnet",
  DATABASE_URL: dbUrl,
  NEAR_RPC_URL: simSrv.url,
  NEAR_RPC_FALLBACK_URL: simSrv.url,
  BASE_RPC_URL: simSrv.url,
  FACTORY_CONTRACT: FACTORY,
  REGISTRY_CONTRACT: `registry.${FACTORY}`,
  WEB_ORIGIN: ORIGIN,
  SESSION_SECRET: "e2e-session-secret-0123456789abcdef-xyz",
  EMAIL_DEV_ECHO: "1",
  PRIVY_APP_ID: "e2e-privy-app",
  LOG_LEVEL: "warn",
  NEARDATA_URL: "",
});
execFileSync("npx", ["tsx", "packages/db/src/migrate.ts"], { env: process.env, stdio: "inherit" });

const { createLogger } = await import("../../packages/shared/src/index.ts");
const { buildApp } = await import("../../apps/api/src/app.ts");
const { SseHub } = await import("../../apps/api/src/sse.ts");
const { setPrivyTestKey } = await import("../../apps/api/src/privy.ts");
const { processTx } = await import("../../packages/indexer/src/index.ts");
const { handleEvent } = await import("../../apps/workers/src/events.ts");
const { recordTaskReport, finalizeTaskReport } = await import("../../packages/orchestrator/src/report.ts");
const { notify } = await import("../../packages/notify/src/index.ts");
const { nep413Payload } = await import("../../packages/near/src/nep413.ts");
const db = await import("../../packages/db/src/index.ts");
const { deserialize, openString, serverKey } = await import("../../packages/crypto/src/index.ts");

const log = createLogger("e2e");
const hub = new SseHub(log);
await hub.start();
const app = await buildApp({ log, hub });
await app.listen({ port: 0, host: "127.0.0.1" });
const API = `http://127.0.0.1:${(app.server.address() as any).port}`;

// Privy test issuer (ES256), injected as the verification key.
const privyKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
setPrivyTestKey(privyKeys.publicKey);
function privyToken(claims: Record<string, unknown>) {
  const h = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "e2e" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const p = Buffer.from(JSON.stringify({ iss: "privy.io", aud: "e2e-privy-app", iat: now, exp: now + 3600, sub: "did:privy:e2e", ...claims })).toString("base64url");
  const sig = signEs256("sha256", Buffer.from(`${h}.${p}`), { key: privyKeys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${h}.${p}.${sig}`;
}

// ---------- evidence ----------
type Ev = { section: string; step: string; status: number | string; ok: boolean; note?: string };
const evidence: Ev[] = [];
let section = "";
const fails: string[] = [];
function rec(step: string, status: number | string, ok: boolean, note?: string) {
  evidence.push({ section, step, status, ok, note });
  if (!ok) fails.push(`${section} › ${step}: ${note ?? ""}`);
  console.log(`${ok ? "PASS" : "FAIL"}  ${section.padEnd(14)} ${step.padEnd(70)} ${String(status).padEnd(4)} ${ok ? "" : (note ?? "")}`);
}
function check(step: string, r: { status: number; json: any }, want: number | number[], test?: (j: any) => string | null | false | undefined) {
  const wants = Array.isArray(want) ? want : [want];
  let ok = wants.includes(r.status);
  let note = ok ? undefined : `want ${wants.join("/")}: ${JSON.stringify(r.json).slice(0, 220)}`;
  if (ok && test) {
    try {
      const bad = test(r.json);
      if (bad) {
        ok = false;
        note = bad;
      }
    } catch (e: any) {
      ok = false;
      note = `check threw: ${e?.message}`;
    }
  }
  rec(step, r.status, ok, note);
  return ok;
}
const truth = (step: string, cond: boolean, note?: string) => rec(step, cond ? "ok" : "x", cond, cond ? undefined : note);

// ---------- people ----------
type Key = { seed: Uint8Array; pk: string; implicit: string };
function newKey(): Key {
  const seed = randomBytes(32);
  const pub = ed25519.getPublicKey(seed);
  return { seed, pk: `ed25519:${bs58.encode(pub)}`, implicit: Buffer.from(pub).toString("hex") };
}

async function login(k: Key, o: { claimed?: string; method?: "privy" | "wallet"; privy?: string; prefetch?: boolean } = {}) {
  const claimed = o.claimed ?? k.implicit;
  const ch: any = await (await fetch(`${API}/v1/auth/challenge${o.prefetch ? "" : `?accountId=${claimed}`}`, { headers: { origin: ORIGIN } })).json();
  const payload = nep413Payload({ message: ch.message, nonce: Buffer.from(ch.nonce, "base64"), recipient: ch.recipient });
  const sig = ed25519.sign(createHash("sha256").update(payload).digest(), k.seed);
  const body = { accountId: claimed, publicKey: k.pk, signature: Buffer.from(sig).toString("base64"), message: ch.message, nonce: ch.nonce, loginMethod: o.method, privyIdentityToken: o.privy };
  const r = await fetch(`${API}/v1/auth/verify`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any, ch, body };
}

type Client = (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>;
function client(token: string | null): Client {
  return async (method, path, body) => {
    const headers: Record<string, string> = { origin: ORIGIN };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") headers["idempotency-key"] = randomBytes(8).toString("hex");
    const r = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return { status: r.status, json };
  };
}

const workerSend = async (queue: string, data: any) => {
  if (queue === "notify.send") await notify(data.alert, log).catch(() => {});
};
async function index(t: { hash: string; height: number; status: any }, signer: string) {
  await processTx(t.hash, signer, t.height, t.status, { log, onEvent: (e: any) => handleEvent(e, { send: workerSend, log }) });
}

/** Sign every tx in order with this key (wallet), send to the chain, index it. Throws on a failed tx. */
async function signAll(k: Key, signer: string, txs: any[]) {
  const out: string[] = [];
  for (const t of txs) {
    const { signerId: _s, ...txOnly } = t;
    const msg = createHash("sha256").update(JSON.stringify({ signerId: signer, tx: txOnly })).digest();
    const signature = Buffer.from(ed25519.sign(msg, k.seed)).toString("base64");
    const res = sim.send(signer, k.pk, signature, txOnly);
    await index(res, signer);
    if (res.failure) throw new Error(`tx ${txOnly.actions[0].params.methodName} failed: ${res.failure}`);
    out.push(res.hash);
  }
  return out;
}
async function trySign(k: Key, signer: string, txs: any[]) {
  try {
    await signAll(k, signer, txs);
    return null;
  } catch (e: any) {
    return String(e.message);
  }
}

const sum = (xs: Array<string | number | bigint>) => xs.reduce<bigint>((a, x) => a + BigInt(x), 0n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// =====================================================================================================
section = "health";
{
  const r = await client(null)("GET", "/health");
  check("GET /health → API contract 2026-11-13", r, 200, (j) => j.contract !== "2026-11-13" && `contract ${j.contract}`);
}

// ---------- demo ----------
section = "demo";
{
  const pub = client(null);
  const r = await pub("GET", "/v1/demo");
  check("GET /v1/demo works signed out, read-only, invented data", r, 200, (j) => (!j.demo || !j.readOnly || !j.notice) && "not flagged demo");
  check("demo has 4 teams with budgets and agents", r, 200, (j) => (j.teams.length !== 4 || j.teams.some((t: any) => !t.agents.length || BigInt(t.budget) <= 0n)) && "teams wrong");
  check("demo reports are grouped by team (main view)", r, 200, (j) =>
    (j.reports.groupBy !== "team" || j.reports.teams.map((t: any) => t.team).join() !== "build,ops,growth,support" || !j.reports.teams.every((t: any) => t.reports.every((x: any) => x.team === t.team))) && "grouping wrong",
  );
  check("demo analytics: 30 days, totals add up across days and teams", r, 200, (j) => {
    const m = j.analytics.money;
    if (m.byDay.length !== 30) return `byDay ${m.byDay.length}`;
    const byDay = sum(m.byDay.map((d: any) => d.total));
    const byTeam = sum(m.byTeam.map((t: any) => t.spentInRange));
    const byModel = sum(m.byModel.map((t: any) => t.amount));
    if (byDay !== BigInt(m.total) || byTeam !== BigInt(m.total) || byModel !== BigInt(m.total)) return `total ${m.total} day ${byDay} team ${byTeam} model ${byModel}`;
    for (const d of m.byDay) if (sum(Object.values(d.byTeam) as string[]) !== BigInt(d.total)) return `day ${d.day} doesn't add up`;
    return null;
  });
  check("demo team spent + reserved + available = budget", r, 200, (j) =>
    j.teams.some((t: any) => BigInt(t.spent) + BigInt(t.reserved) + BigInt(t.available) !== BigInt(t.budget)) && "budget math",
  );
  check("demo overview money equals the sum of its teams", r, 200, (j) => BigInt(j.overview.money.budget) !== sum(j.teams.map((t: any) => t.budget)) && "overview mismatch");
  const r7 = await pub("GET", "/v1/demo?range=7d");
  check("GET /v1/demo?range=7d → 7 days", r7, 200, (j) => j.analytics.money.byDay.length !== 7 && "not 7");
  check("GET /v1/demo?range=5d → 400", await pub("GET", "/v1/demo?range=5d"), 400);
  const a = await pub("GET", "/v1/demo/analytics?range=90d");
  check("GET /v1/demo/analytics?range=90d", a, 200, (j) => j.money.byDay.length !== 90 && "not 90");
  const rid = r.json.reports.teams[0].reports[0].id;
  check("GET /v1/demo/reports/:id", await pub("GET", `/v1/demo/reports/${rid}`), 200, (j) => !j.report?.summary && "no summary");
  check("GET /v1/demo/reports/<unknown> → 404", await pub("GET", "/v1/demo/reports/nope"), 404);
  check("POST /v1/demo → 404 (no writes exist)", await pub("POST", "/v1/demo", {}), 404);
  const again = await pub("GET", "/v1/demo");
  truth("demo numbers are identical across requests", JSON.stringify(again.json.analytics.money.byTeam) === JSON.stringify(r.json.analytics.money.byTeam));
}

// ---------- sign-in ----------
section = "sign-in";
const W = newKey(); // NEAR wallet founder with a named account
const WNAME = "wang-e2e.testnet";
sim.fullKeys.set(WNAME, new Set([W.pk]));
sim.fund(WNAME, 1);
const P = newKey(); // Privy (Google/email) founder, implicit account
const O = newKey(); // outsider
const B = newKey(); // later invited as builder
let w: Client, p: Client, o: Client, b: Client;
{
  const t0 = Date.now();
  const ch = await client(null)("GET", "/v1/auth/challenge");
  const ms = Date.now() - t0;
  check("challenge without accountId (prefetch) → unbound, fast", ch, 200, (j) => (j.accountBound !== false || !j.nonce) && "bound");
  truth(`challenge answered in ${ms} ms (< 300 ms, no RPC)`, ms < 300);

  const lw = await login(W, { claimed: WNAME, method: "wallet" });
  check("NEAR wallet sign-in with a named account (full-access key on chain)", { status: lw.status, json: lw.json }, 200, (j) => (j.accountId !== WNAME || j.loginMethod !== "wallet" || j.email?.verified !== false) && JSON.stringify(j).slice(0, 200));
  w = client(lw.json.token);
  const replay = await fetch(`${API}/v1/auth/verify`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(lw.body) });
  check("same signed challenge can't be used twice", { status: replay.status, json: await replay.json() }, 401);

  {
    const ch = (await client(null)("GET", `/v1/auth/challenge?accountId=${B.implicit}`)).json;
    const payload = nep413Payload({ message: ch.message, nonce: Buffer.from(ch.nonce, "base64"), recipient: ch.recipient });
    const sig = Buffer.from(ed25519.sign(createHash("sha256").update(payload).digest(), B.seed)).toString("base64");
    const body = JSON.stringify({ accountId: B.implicit, publicKey: B.pk, signature: sig, message: ch.message, nonce: ch.nonce });
    const both = await Promise.all([0, 1, 2].map(() => fetch(`${API}/v1/auth/verify`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body })));
    truth("3 parallel verifies of one challenge → exactly one session", both.filter((r) => r.status === 200).length === 1, both.map((r) => r.status).join());
  }
  const noEmailTok = privyToken({ linked_accounts: JSON.stringify([{ type: "wallet", address: B.implicit }]) });
  const lnoemail = await login(B, { method: "privy", privy: noEmailTok });
  check("Privy login without an email → signs in, emailError privy_no_email", { status: lnoemail.status, json: lnoemail.json }, 200, (j) => j.emailError !== "privy_no_email" && JSON.stringify(j));

  const lfake = await login(O, { claimed: WNAME, method: "wallet" });
  check("a key that isn't on the named account signs in as its own implicit account", { status: lfake.status, json: lfake.json }, 200, (j) => j.accountId !== O.implicit && `got ${j.accountId}`);

  const tok = privyToken({ linked_accounts: JSON.stringify([{ type: "email", address: "Founder.P@Example.com" }, { type: "wallet", address: P.implicit, chain_type: "near" }]) });
  const lp = await login(P, { method: "privy", privy: tok, prefetch: true });
  check("Privy sign-in with a prefetched challenge + identity token → email verified at once", { status: lp.status, json: lp.json }, 200, (j) =>
    (j.accountId !== P.implicit || j.loginMethod !== "privy" || j.email?.verified !== true || j.email?.source !== "privy" || j.email?.address !== "f•••p@example.com") && JSON.stringify(j.email),
  );
  p = client(lp.json.token);

  const otherTok = privyToken({ linked_accounts: JSON.stringify([{ type: "email", address: "victim@example.com" }, { type: "wallet", address: P.implicit }]) });
  const lo = await login(O, { method: "privy", privy: otherTok });
  check("Privy token of another wallet: sign-in works, email NOT attached", { status: lo.status, json: lo.json }, 200, (j) => (j.emailError !== "privy_wallet_mismatch" || j.email?.verified) && JSON.stringify(j));
  o = client(lo.json.token);

  const expired = privyToken({ exp: Math.floor(Date.now() / 1000) - 600, linked_accounts: JSON.stringify([{ type: "email", address: "o@example.com" }, { type: "wallet", address: O.implicit }]) });
  check("expired Privy token → 401 bad_privy_token", await o("POST", "/v1/account/email/privy", { identityToken: expired }), 401, (j) => j.code !== "bad_privy_token" && j.code);
  const wrongAud = privyToken({ aud: "someone-else", linked_accounts: JSON.stringify([{ type: "email", address: "o@example.com" }, { type: "wallet", address: O.implicit }]) });
  check("Privy token for another app → 401", await o("POST", "/v1/account/email/privy", { identityToken: wrongAud }), 401);
  const forged = tok.slice(0, -4) + (tok.endsWith("AAAA") ? "BBBB" : "AAAA");
  check("tampered Privy token → 401", await o("POST", "/v1/account/email/privy", { identityToken: forged }), 401);
  check("garbage Privy token → 400", await o("POST", "/v1/account/email/privy", { identityToken: "x".repeat(40) }), 400);

  const bound = await client(null)("GET", `/v1/auth/challenge?accountId=${B.implicit}`);
  const payload = nep413Payload({ message: bound.json.message, nonce: Buffer.from(bound.json.nonce, "base64"), recipient: bound.json.recipient });
  const sig = ed25519.sign(createHash("sha256").update(payload).digest(), O.seed);
  const mism = await fetch(`${API}/v1/auth/verify`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ accountId: O.implicit, publicKey: O.pk, signature: Buffer.from(sig).toString("base64"), message: bound.json.message, nonce: bound.json.nonce }) });
  check("challenge bound to one account can't be used by another", { status: mism.status, json: await mism.json() }, 401);

  const lb = await login(B, { method: "wallet" });
  b = client(lb.json.token);
  check("no token → 401 on /v1/overview", await client(null)("GET", "/v1/overview"), 401);
}

// ---------- home with no company ----------
section = "home-empty";
{
  const me = await w("GET", "/v1/auth/me");
  check("/auth/me with no company: welcome home, setup next = email, demo link", me, 200, (j) =>
    (j.companies.length !== 0 || j.home.view !== "welcome" || j.setup.next !== "email" || j.home.demo !== "/v1/demo" || j.needsEmailForCompany !== true) && JSON.stringify({ h: j.home, n: j.setup.next }),
  );
  check("/overview with no company → empty portfolio, no error", await w("GET", "/v1/overview"), 200, (j) => (j.companies.length !== 0 || j.totals.companies !== 0 || j.home.view !== "welcome") && "not empty");
  check("/inbox with no company → empty", await w("GET", "/v1/inbox"), 200, (j) => (j.items.length !== 0 || j.unread !== 0) && "not empty");
  check("/companies → []", await w("GET", "/v1/companies"), 200, (j) => j.companies.length !== 0 && "not empty");
  check("/account → wallet, no email", await w("GET", "/v1/account"), 200, (j) => (j.loginMethod !== "wallet" || j.email.verified) && JSON.stringify(j));
  const pm = await p("GET", "/v1/auth/me");
  check("Privy founder: email step already done", pm, 200, (j) => (j.setup.steps.find((s: any) => s.id === "email")?.done !== true || j.setup.next !== "describe") && `next ${j.setup.next}`);
}

// ---------- drafts ----------
section = "drafts";
let d1: any, d2: any;
{
  const c1 = await w("POST", "/v1/drafts", {
    what: "A notes app for small teams. Users sign up with email. Notes API with sharing links. Editor UI with offline drafts. Stripe billing for the monthly plan. Marketing launch campaign and waitlist for growth. Deploy pipeline with uptime monitoring.",
    who: "Small design studios",
    howTheyPay: "Monthly subscription",
  });
  check("POST /drafts from Describe answers → plan, estimate, teams, setup", c1, 200, (j) => {
    const d = j.draft;
    if (!d?.id || d.status !== "draft" || d.companyId !== null) return "bad draft";
    if (!d.features.length || !d.features.every((f: any) => f.team && f.estimate)) return "features missing team/estimate";
    if (!d.description?.includes("Small design studios")) return "description not returned to author";
    const s = d.suggestedSetup;
    if (!s.teams.length || s.teams.some((t: any) => BigInt(t.perTxLimit) > BigInt(t.monthlyCap) || BigInt(t.monthlyCap) < 5_000_000n)) return "setup wrong";
    if (!/^[a-z0-9-]{2,32}$/.test(s.slug)) return `slug ${s.slug}`;
    return null;
  });
  d1 = c1.json.draft;
  check("POST /drafts {} → 400", await w("POST", "/v1/drafts", {}), 400);
  check("POST /drafts unknown field → 400", await w("POST", "/v1/drafts", { what: "a thing to build", hack: 1 }), 400);
  const c2 = await w("POST", "/v1/plans", { description: "Second idea: a habit tracker with streaks and reminders by email." });
  check("POST /plans without companyId → a draft (old clients)", c2, 200, (j) => (j.plan.companyId !== null || j.plan.status !== "draft") && "not draft");
  d2 = c2.json.draft;
  check("GET /drafts lists both, newest first", await w("GET", "/v1/drafts"), 200, (j) => (j.drafts.length !== 2 || j.drafts[0].id !== d2.id) && `n=${j.drafts.length}`);
  const keys = d1.features.map((f: any) => f.key);
  console.log("      draft teams:", d1.suggestedSetup.teams.map((t: any) => `${t.team}(${t.features.length})`).join(" "), "features:", d1.features.map((f: any) => `${f.key}:${f.tag}`).join(" "));
  const removable = d1.features.find((f: any) => f.team === "build" && !d1.features.some((g: any) => g.dependsOn.includes(f.key)))?.key ?? keys[0];
  const pa = await w("PATCH", `/v1/drafts/${d1.id}`, { title: "Lumen for studios", removeKeys: [removable] });
  check("PATCH /drafts: rename + remove a step → re-estimated", pa, 200, (j) =>
    (j.draft.title !== "Lumen for studios" || j.draft.features.length !== keys.length - 1 || BigInt(j.draft.estimate.cap) >= BigInt(d1.estimate.cap)) && "not updated",
  );
  d1 = pa.json.draft;
  const cyc = [
    { key: "a", title: "A", tag: "backend", size: "s", dependsOn: ["b"] },
    { key: "b", title: "B", tag: "backend", size: "s", dependsOn: ["a"] },
  ];
  check("PATCH /drafts with a dependency loop → 400", await w("PATCH", `/v1/drafts/${d1.id}`, { features: cyc }), 400);
  check("PATCH /drafts with unknown dependency → 400", await w("PATCH", `/v1/drafts/${d1.id}`, { features: [{ key: "a", title: "A", tag: "backend", size: "s", dependsOn: ["zz"] }] }), 400);
  check("someone else: GET /drafts/:id → 404", await o("GET", `/v1/drafts/${d1.id}`), 404);
  check("someone else: GET /plans/:id → 404", await o("GET", `/v1/plans/${d1.id}`), 404);
  check("someone else: PATCH /drafts/:id → 404", await o("PATCH", `/v1/drafts/${d1.id}`, { title: "mine now" }), 404);
  check("someone else: PATCH /plans/:id → 404", await o("PATCH", `/v1/plans/${d1.id}`, { tier: "economy" }), 404);
  check("someone else: DELETE /drafts/:id → 404", await o("DELETE", `/v1/drafts/${d1.id}`), 404);
  check("someone else: approve → 404", await o("POST", `/v1/plans/${d1.id}/approve`), 404);
  check("someone else's /drafts list doesn't show it", await o("GET", "/v1/drafts"), 200, (j) => j.drafts.length !== 0 && "leak");
  check("approve an unlaunched draft → 409 plan_not_launched", await w("POST", `/v1/plans/${d1.id}/approve`), 409, (j) => j.code !== "plan_not_launched" && j.code);
  check("GET /drafts/not-a-uuid → 404", await w("GET", "/v1/drafts/not-a-uuid"), 404);
  const me = await w("GET", "/v1/auth/me");
  check("/auth/me shows drafts; describe step done", me, 200, (j) => (j.drafts.length !== 2 || !j.setup.steps.find((s: any) => s.id === "describe").done) && "no");
}

// ---------- email (NEAR wallet founder) ----------
section = "email";
{
  check("launch before email → 403 email_required", await w("POST", "/v1/companies", { name: "Lumen", slug: "lumen-e2e", planId: d1.id }), 403, (j) => j.code !== "email_required" && j.code);
  check("bad email → 400", await w("POST", "/v1/account/email", { email: "not-an-email" }), 400);
  const s = await w("POST", "/v1/account/email", { email: "Wang.Founder@Example.com" });
  check("POST /account/email → code sent (dev echo), masked", s, 200, (j) => (!/^\d{6}$/.test(j.devCode) || j.sentTo !== "w•••r@example.com") && JSON.stringify(j));
  check("GET /account shows the pending address", await w("GET", "/v1/account"), 200, (j) => (j.email.pending !== "w•••r@example.com" || j.email.verified) && JSON.stringify(j.email));
  const wrong = String((Number(s.json.devCode) + 1) % 1_000_000).padStart(6, "0");
  check("wrong code → 400 wrong_code", await w("POST", "/v1/account/email/verify", { code: wrong }), 400, (j) => j.code !== "wrong_code" && j.code);
  check("someone else can't use the code", await o("POST", "/v1/account/email/verify", { code: s.json.devCode }), 404);
  check("right code → verified", await w("POST", "/v1/account/email/verify", { code: s.json.devCode }), 200, (j) => j.email.verified !== true && "no");
  check("code is single use", await w("POST", "/v1/account/email/verify", { code: s.json.devCode }), 404);
  check("/account → verified by code", await w("GET", "/v1/account"), 200, (j) => (j.email.verified !== true || j.email.source !== "code" || j.needsEmailForCompany) && JSON.stringify(j.email));
  const ch2 = await w("POST", "/v1/me/email", { email: "new.address@example.com" });
  check("old route /me/email now starts the verified flow (code, not a save)", ch2, 200, (j) => !j.devCode && "no code");
  check("changing address: the old one stays verified until the new one is confirmed", await w("GET", "/v1/account"), 200, (j) =>
    (j.email.address !== "w•••r@example.com" || !j.email.verified || j.email.pending !== "n•••s@example.com") && JSON.stringify(j.email),
  );
  check("confirm the new address", await w("POST", "/v1/account/email/verify", { code: ch2.json.devCode }), 200, (j) => j.email.address !== "n•••s@example.com" && JSON.stringify(j));
  // brute force guard
  await o("POST", "/v1/account/email", { email: "o@example.com" });
  for (let i = 0; i < 5; i++) await o("POST", "/v1/account/email/verify", { code: "000000" });
  check("6th wrong code → 429 too_many_attempts", await o("POST", "/v1/account/email/verify", { code: "000001" }), [429], (j) => j.code !== "too_many_attempts" && j.code);
}

// ---------- launch from a draft ----------
section = "launch";
let C1 = "";
{
  check("launch someone else's draft → 404", await p("POST", "/v1/companies", { name: "Steal", slug: "steal-e2e", planId: d1.id }), 404);
  check("launch with a random planId → 404", await w("POST", "/v1/companies", { name: "Random", slug: "rand-e2e", planId: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f" }), 404);
  const r402 = await w("POST", "/v1/companies", { name: "Lumen", slug: "lumen-e2e", planId: d1.id });
  check("launch with 1 NEAR → 402 insufficient_funds (nothing to sign)", r402, 402, (j) => j.code !== "insufficient_funds" && j.code);
  sim.fund(WNAME, 80);
  const r = await w("POST", "/v1/companies", { name: "Lumen", slug: "lumen-e2e", planId: d1.id });
  truth("the draft needs more than one team (build + others)", d1.suggestedSetup.teams.length >= 2, JSON.stringify(d1.suggestedSetup.teams.map((t: any) => t.team)));
  check("POST /companies {planId} → teams + budgets from the draft", r, 200, (j) => {
    const s = d1.suggestedSetup;
    if (j.planId !== d1.id) return "planId not echoed";
    if (j.teams.map((t: any) => t.name).join() !== s.teams.map((t: any) => t.team).join()) return `teams ${j.teams.map((t: any) => t.name)} vs ${s.teams.map((t: any) => t.team)}`;
    if (j.teams.some((t: any, i: number) => t.budget !== s.teams[i].monthlyCap || t.perTxLimit !== s.teams[i].perTxLimit)) return "budgets differ";
    if (j.dailyCap !== s.dailyCap) return "daily cap differs";
    if (j.transactions.length !== 1 + s.teams.length) return `txs ${j.transactions.length}`;
    return null;
  });
  C1 = r.json.companyId;
  check("draft shows 'launching' while the chain catches up", await w("GET", `/v1/drafts/${d1.id}`), 200, (j) => j.draft.status !== "launching" && j.draft.status);
  check("approve before the company exists → 409 plan_not_launched", await w("POST", `/v1/plans/${d1.id}/approve`), 409);
  const err = await trySign(W, WNAME, r.json.transactions);
  truth("founder signs create_company + create_department txs", !err, err ?? "");
  const st = await w("GET", "/v1/companies/creation/lumen-e2e");
  check("creation poll: company + teams on chain, draft bound", st, 200, (j) => (!j.companyExists || !j.founderIsYou || !j.plansBound?.includes(d1.id) || j.departments.length !== d1.suggestedSetup.teams.length) && JSON.stringify(j));
  check("GET /drafts/:id → 409 (it's a company plan now)", await w("GET", `/v1/drafts/${d1.id}`), 409, (j) => j.details?.companyId !== C1 && "no companyId");
  check("GET /plans/:id → launched plan in the company", await w("GET", `/v1/plans/${d1.id}`), 200, (j) => (j.plan.companyId !== C1 || j.plan.status !== "launched") && "not launched");
  check("GET /plans?companyId → the plan is listed", await w("GET", `/v1/plans?companyId=lumen-e2e`), 200, (j) => !j.plans.some((x: any) => x.id === d1.id) && "missing");
  check("/drafts no longer lists it", await w("GET", "/v1/drafts"), 200, (j) => j.drafts.some((x: any) => x.id === d1.id) && "still listed");
  const me = await w("GET", "/v1/auth/me");
  check("/auth/me → 1 founded company, overview home", me, 200, (j) => (j.companies.length !== 1 || !j.companies[0].isFounder || j.home.view !== "overview" || j.home.openCompanyId !== C1) && JSON.stringify(j.home));
  const ap = await w("POST", `/v1/plans/${d1.id}/approve`);
  check("approve → assign_task txs, every task routed to an existing team", ap, 200, (j) => {
    const teams = new Set(d1.suggestedSetup.teams.map((t: any) => `${t.team}.${C1}`));
    if (!j.tasks.length || j.tasks.some((t: any) => !teams.has(t.departmentId))) return "task on a missing team";
    for (const t of j.tasks) {
      const f = d1.features.find((x: any) => t.id.endsWith(`-${x.key}`));
      if (f && `${f.team}.${C1}` !== t.departmentId) return `${t.id} → ${t.departmentId}, draft said ${f.team}`;
    }
    return null;
  });
  const e2 = await trySign(W, WNAME, ap.json.transactions);
  truth("founder signs dept_call(assign_task)", !e2, e2 ?? "");
  {
    const { openPlanText } = await import("../../apps/api/src/drafts.ts");
    const [row] = await db.getDb().select().from(db.plans).where(db.eq(db.plans.id, d1.id));
    const text = await openPlanText(row);
    truth("plan text was re-sealed to the company and still opens", Boolean(text?.includes("Small design studios")) && row.companyId === C1);
  }
  const tk = await w("GET", `/v1/tasks?companyId=${C1}`);
  check("indexer saw task_assigned → tasks 'assigned'", tk, 200, (j) => j.tasks.some((t: any) => t.status !== "assigned") && j.tasks.map((t: any) => t.status).join());
  check("approve again → 409 plan_already_approved", await w("POST", `/v1/plans/${d1.id}/approve`), 409);
  check("launch a launched plan as another company → 409", await w("POST", "/v1/companies", { name: "Again", slug: "again-e2e", planId: d1.id }), 409, (j) => j.code !== "draft_already_launched" && j.code);
  // A create that fails on chain (slug grabbed between request and signing): the draft can be launched again.
  const d3 = (await w("POST", "/v1/drafts", { what: "Race idea: a recipe app with meal plans." })).json.draft;
  const race = await w("POST", "/v1/companies", { name: "Race", slug: "race-e2e", planId: d3.id });
  sim.fund(P.implicit, 30);
  const thief = await p("POST", "/v1/companies", { name: "Thief", slug: "race-e2e" });
  check("another founder asks for the same free slug (both get a bundle)", thief, 200);
  await signAll(P, P.implicit, thief.json.transactions);
  const lost = await trySign(W, WNAME, race.json.transactions);
  truth("signing after the slug was taken fails on chain (slug taken)", Boolean(lost?.includes("slug taken")), lost ?? "succeeded?!");
  check("the draft is still yours and 'launching' — not bound to someone else's company", await w("GET", `/v1/drafts/${d3.id}`), 200, (j) => j.draft.status !== "launching" && j.draft.status);
  check("creation poll for the lost slug: taken, not yours", await w("GET", "/v1/companies/creation/race-e2e"), 200, (j) => (j.founderIsYou !== false || j.plansBound) && JSON.stringify(j));
  const retry = await w("POST", "/v1/companies", { name: "Race", slug: "race2-e2e", planId: d3.id });
  check("launch the same draft under another name", retry, 200);
  await signAll(W, WNAME, retry.json.transactions);
  check("…and it binds to the new company", await w("GET", "/v1/companies/creation/race2-e2e"), 200, (j) => !j.plansBound?.includes(d3.id) && JSON.stringify(j));
}

// ---------- more companies ----------
section = "multi";
let C2 = "",
  CP = "";
{
  // Launch the second draft into the existing company.
  const l = await w("POST", `/v1/drafts/${d2.id}/launch`, { companyId: "lumen-e2e" });
  check("POST /drafts/:id/launch into a company you founded", l, 200, (j) => j.plan.companyId !== C1 && "not bound");
  check("someone else can't launch your draft", await o("POST", `/v1/drafts/${d2.id}/launch`, { companyId: "lumen-e2e" }), [403, 404]);
  // A second company without a draft.
  const r = await w("POST", "/v1/companies", { name: "Habit Co", slug: "habit-e2e", teams: [{ team: "Eng", monthlyCap: "50" }] });
  check("POST /companies without a draft (explicit teams)", r, 200, (j) => j.teams[0].name !== "eng" && "teams");
  C2 = r.json.companyId;
  const err = await trySign(W, WNAME, r.json.transactions);
  truth("second company signed", !err, err ?? "");
  // Privy founder launches their own.
  const dp = await p("POST", "/v1/drafts", { what: "Marketplace for used bikes with listings, chat and payments. Growth: launch campaign." });
  check("Privy founder makes a draft", dp, 200);
  sim.fund(P.implicit, 30);
  const taken = await p("POST", "/v1/companies", { name: "Lumen", slug: "lumen-e2e", planId: dp.json.draft.id });
  check("slug already taken by someone else → 409 slug_taken", taken, 409, (j) => j.code !== "slug_taken" && j.code);
  const rp = await p("POST", "/v1/companies", { name: "Bikes", slug: "bikes-e2e", planId: dp.json.draft.id });
  check("Privy founder launches (email came from Privy, no extra step)", rp, 200);
  CP = rp.json.companyId;
  const e3 = await trySign(P, P.implicit, rp.json.transactions);
  truth("Privy founder signs", !e3, e3 ?? "");
  check("Privy founder's approve binds the draft on the fly", await p("POST", `/v1/plans/${dp.json.draft.id}/approve`), 200, (j) => !j.transactions.length && "no txs");
  const ov = await w("GET", "/v1/overview");
  check("wallet founder's overview lists their 3 companies, not the Privy one", ov, 200, (j) =>
    (j.companies.map((c: any) => c.slug).sort().join() !== "habit-e2e,lumen-e2e,race2-e2e" || j.companies.some((c: any) => c.companyId === CP) || j.totals.founded !== 3) && j.companies.map((c: any) => c.slug).join(),
  );
  check("double-submit with the same Idempotency-Key replays", await (async () => {
    const h = { origin: ORIGIN, authorization: `Bearer ${(await login(W, { claimed: WNAME, method: "wallet" })).json.token}`, "content-type": "application/json", "idempotency-key": "same-key-1" };
    const a = await fetch(`${API}/v1/drafts`, { method: "POST", headers: h, body: JSON.stringify({ what: "idempotent idea one" }) });
    const bb = await fetch(`${API}/v1/drafts`, { method: "POST", headers: h, body: JSON.stringify({ what: "idempotent idea one" }) });
    const ja: any = await a.json();
    const jb: any = await bb.json();
    return { status: bb.status, json: { same: ja.draft.id === jb.draft.id, replay: bb.headers.get("idempotent-replay") } };
  })(), 200, (j) => (!j.same || j.replay !== "true") && JSON.stringify(j));
}

// ---------- agent activity → analytics, reports, inbox ----------
section = "activity";
let reportIds: Record<string, string> = {};
{
  const teams = d1.suggestedSetup.teams.map((t: any) => `${t.team}.${C1}`);
  const build = teams.find((t: string) => t.startsWith("build.")) ?? teams[0];
  const other = teams.find((t: string) => t !== build) ?? build;
  const tasks = (await w("GET", `/v1/tasks?companyId=${C1}`)).json.tasks;
  const buildTask = tasks.find((t: any) => t.departmentId === build);
  const otherTask = tasks.find((t: any) => t.departmentId === other);
  truth("tasks landed on two different teams", Boolean(buildTask && otherTask && buildTask.id !== otherTask.id), tasks.map((t: any) => t.departmentId).join());
  const buys = [
    { departmentId: build, amount: "1200000", model: "deepseek-v3.1", seller: "near-ai-x402", taskId: buildTask.id },
    { departmentId: build, amount: "800000", model: "qwen3-coder", seller: "near-ai-x402", taskId: buildTask.id },
    { departmentId: other, amount: "450000", model: "gpt-oss-120b", seller: "search-api", taskId: otherTask.id },
  ];
  for (const bb of buys) await index(sim.agentPurchase(bb.departmentId, bb), bb.departmentId);
  const y = sim.agentYield(other, { amount: "3000000", reason: "over_limit", seller: "near-ai-x402", taskId: otherTask.id });
  await index(y, other);
  await index(sim.agentBlocked(build, "evil-seller"), build);

  // The runner's records for two tasks: model calls + reports (what runTask writes).
  const dbx = db.getDb();
  const t0 = Date.now();
  await dbx.update(db.tasks).set({ status: "running", attempts: 1, agent: `backend-agent.${build}` }).where(db.eq(db.tasks.id, buildTask.id));
  await dbx.insert(db.modelCalls).values([
    { taskId: buildTask.id, model: "deepseek-v3.1", provider: "near-ai-x402", rail: "x402-evm", tier: "standard", cost: "1200000", outcome: "ok", tokensIn: 9000, tokensOut: 2500 },
    { taskId: buildTask.id, model: "qwen3-coder", provider: "near-ai-x402", rail: "x402-evm", tier: "standard", cost: "800000", outcome: "ok", tokensIn: 3000, tokensOut: 500 },
  ]);
  const r1 = await recordTaskReport(buildTask.id, {
    outcome: "needs_review",
    summary: "Added the notes API with share links and tests.",
    files: ["api/notes.ts", "api/notes.test.ts"],
    checks: { passed: true, errors: [] },
    review: { verdict: "pass", model: "glm-4.6", reasons: [] },
    generator: { model: "deepseek-v3.1", provider: "near-ai-x402", rail: "x402-evm" },
    commitSha: "abc123def",
    startedAt: t0,
  });
  await dbx.update(db.tasks).set({ status: "done" }).where(db.eq(db.tasks.id, buildTask.id));
  await finalizeTaskReport(buildTask.id, "done");
  reportIds.build = r1!.id;
  await dbx.update(db.tasks).set({ status: "paused", attempts: 1 }).where(db.eq(db.tasks.id, otherTask.id));
  await dbx.insert(db.modelCalls).values({ taskId: otherTask.id, model: "gpt-oss-120b", provider: "search-api", rail: "x402-evm", tier: "standard", cost: "450000", outcome: "ok" });
  const r2 = await recordTaskReport(otherTask.id, { outcome: "paused", reason: "a purchase is waiting for approval", startedAt: t0 });
  reportIds.other = r2!.id;
  truth("reports written with cost from model calls (not from the agent)", r1!.cost === "2000000" && r2!.cost === "450000", `${r1!.cost} ${r2!.cost}`);

  const an = await w("GET", `/v1/analytics?companyId=lumen-e2e&range=7d`);
  check("analytics: spend total = signed purchases; teams/models/sellers add up", an, 200, (j) => {
    const m = j.money;
    if (m.total !== "2450000") return `total ${m.total}`;
    if (sum(m.byTeam.map((t: any) => t.spentInRange)) !== 2450000n) return "byTeam";
    if (sum(m.byDay.map((d: any) => d.total)) !== 2450000n) return "byDay";
    if (m.byModel[0].model !== "deepseek-v3.1" || m.byModel[0].amount !== "1200000") return "byModel";
    if (!m.bySeller.some((s: any) => s.seller === "search-api" && s.amount === "450000")) return "bySeller";
    if (m.dailyCap.spentToday !== "2450000") return `spentToday ${m.dailyCap.spentToday}`;
    const bt = m.byTeam.find((t: any) => t.departmentId === build);
    if (bt.spent !== "2000000" || bt.spentInRange !== "2000000") return "team spent from chain";
    if (bt.runwayDays === null) return "runway";
    return null;
  });
  check("analytics: work + control sections", an, 200, (j) =>
    (j.work.tasks.done !== 1 || j.work.reviewPassRate !== 1 || j.work.costPerDoneTask !== "2000000" || j.control.approvals.pending !== 1 || j.control.blockedPurchases !== 1 || !j.sections.money) && JSON.stringify({ w: j.work.tasks, c: j.control }),
  );
  check("analytics ?team=<name> narrows to one team", await w("GET", `/v1/analytics?companyId=lumen-e2e&range=7d&team=${build.split(".")[0]}`), 200, (j) => (j.money.total !== "2000000" || j.teams.length !== 1) && j.money.total);
  check("analytics range=3d → 400", await w("GET", `/v1/analytics?companyId=lumen-e2e&range=3d`), 400);

  const rep = await w("GET", `/v1/reports?companyId=lumen-e2e`);
  check("reports grouped by team, every chain team listed, counts right", rep, 200, (j) => {
    if (j.groupBy !== "team" || j.teams.length !== teams.length) return `teams ${j.teams.length}`;
    const bt = j.teams.find((t: any) => t.departmentId === build);
    if (bt.summary.done !== 1 || bt.summary.cost !== "2000000" || !bt.summary.headline.includes("1 done")) return JSON.stringify(bt.summary);
    const r = bt.reports[0];
    if (r.summarySource !== "agent" || !r.facts.files.length || r.facts.models.length !== 2) return "report detail";
    return null;
  });
  check("GET /reports/:id with attempt history", await w("GET", `/v1/reports/${reportIds.build}`), 200, (j) => (j.report.outcome !== "done" || j.attempts.length !== 1) && j.report.outcome);
  check("GET /reports/<bad id> → 404", await w("GET", `/v1/reports/nope`), 404);

  const ov = await w("GET", "/v1/overview");
  check("overview: money, approvals, needs-attention per company", ov, 200, (j) => {
    const c = j.companies.find((x: any) => x.companyId === C1);
    if (c.money.spentToday !== "2450000" || c.approvals.pending !== 1 || c.work.needsAttention !== 1 || !c.work.lastReport) return JSON.stringify({ m: c.money, a: c.approvals, w: c.work?.needsAttention });
    if (j.totals.pendingApprovals !== 1 || j.totals.needsAttention !== 1) return "totals";
    return null;
  });
  const ib = await w("GET", "/v1/inbox");
  check("inbox: the approval card + reports (done, waiting)", ib, 200, (j) =>
    (!j.items.some((i: any) => i.kind === "approval") || j.items.filter((i: any) => i.kind === "report").length !== 2 || j.unread < 3) && j.items.map((i: any) => i.kind).join(),
  );
  const ids = ib.json.items.filter((i: any) => i.kind === "report").map((i: any) => i.id);
  check("POST /inbox/read marks items read", await w("POST", "/v1/inbox/read", { ids }), 200);
  check("unread drops by the items read", await w("GET", "/v1/inbox"), 200, (j) => j.unread !== ib.json.unread - ids.length && `${j.unread}`);

  const card = (await w("GET", `/v1/approvals?companyId=lumen-e2e`)).json.cards[0];
  const dec = await w("POST", `/v1/approvals/${card.id}`, { decision: "approve" });
  check("approve the card → approve tx", dec, 200);
  const e = await trySign(W, WNAME, dec.json.transactions);
  truth("founder signs approve; card closes", !e, e ?? "");
  check("no pending approvals left", await w("GET", `/v1/analytics?companyId=lumen-e2e`), 200, (j) => j.control.approvals.pending !== 0 && "still pending");
}

// ---------- invites and permissions ----------
section = "permissions";
{
  const build = d1.suggestedSetup.teams[0].team; // first team
  const other = d1.suggestedSetup.teams[1]?.team;
  const inv = await w("POST", "/v1/members/invite", { companyId: "lumen-e2e", email: "founder.p@example.com", departments: [build], template: "viewer" });
  check("founder invites the Privy user's email as a team viewer", inv, 200);
  const e = await trySign(W, WNAME, inv.json.transactions);
  truth("founder signs invite; worker marks it sent", !e, e ?? "");
  const pib = await p("GET", "/v1/inbox");
  const item = pib.json.items.find((i: any) => i.kind === "invite");
  check("invitee's inbox shows it (matched by verified email, no code needed)", pib, 200, (j) => !item && j.items.map((i: any) => i.kind).join());
  check("someone else can't accept it from their inbox", await o("POST", `/v1/inbox/invites/${item.id.split(":")[1]}/accept`), 404);
  const acc = await p("POST", `/v1/inbox/invites/${item.id.split(":")[1]}/accept`);
  check("accept from inbox → accept_invite tx for the invitee", acc, 200, (j) => j.transactions[0].actions[0].params.methodName !== "accept_invite" && "wrong tx");
  const e2 = await trySign(P, P.implicit, acc.json.transactions);
  truth("invitee signs accept_invite", !e2, e2 ?? "");
  const pme = await p("GET", "/v1/auth/me");
  check("invitee now sees the company with view scope on one team", pme, 200, (j) => {
    const c = j.companies.find((x: any) => x.companyId === C1);
    return (!c || c.isFounder || c.scopes.join() !== "view" || c.departmentId !== `${build}.${C1}`) && JSON.stringify(c);
  });
  const pa = await p("GET", `/v1/analytics?companyId=lumen-e2e`);
  check("viewer analytics: money for their team only; no work, no control", pa, 200, (j) =>
    (j.work !== null || j.control !== null || j.teams.length !== 1 || j.money.byTeam.length !== 1 || j.money.dailyCap !== null) && JSON.stringify(j.sections),
  );
  if (other) {
    check("viewer asks for another team → 403", await p("GET", `/v1/analytics?companyId=lumen-e2e&team=${other}`), 403);
    check("viewer opens another team's report → 403", await p("GET", `/v1/reports/${reportIds.other}`), 403);
  }
  const pr = await p("GET", `/v1/reports?companyId=lumen-e2e`);
  check("viewer reports: own team only, cost shown, code detail hidden", pr, 200, (j) => {
    if (j.teams.length !== 1) return `teams ${j.teams.length}`;
    const r = j.teams[0].reports[0];
    if (r && (r.facts.files !== undefined || r.cost === null)) return "detail leak or cost missing";
    return null;
  });
  const pov = await p("GET", "/v1/overview");
  check("viewer overview: member role, their team's money, no work section", pov, 200, (j) => {
    const c = j.companies.find((x: any) => x.companyId === C1);
    return (!c || c.role !== "member" || c.work !== null || c.approvals !== null || c.teams.length !== 1) && JSON.stringify(c);
  });
  check("viewer can't launch a draft into the company (needs admin)", await p("POST", `/v1/drafts/${(await p("POST", "/v1/drafts", { what: "side project idea" })).json.draft.id}/launch`, { companyId: "lumen-e2e" }), 403);
  check("viewer can't approve plans", await p("POST", `/v1/plans/${d2.id}/approve`), 403);
  check("viewer can't read company plans (needs builder)", await p("GET", `/v1/plans?companyId=lumen-e2e`), 403);
  check("outsider: analytics → 403", await o("GET", `/v1/analytics?companyId=lumen-e2e`), 403);
  check("outsider: reports → 403", await o("GET", `/v1/reports?companyId=lumen-e2e`), 403);
  check("outsider: report by id → 403", await o("GET", `/v1/reports/${reportIds.build}`), 403);
  check("outsider: overview has no companies", await o("GET", "/v1/overview"), 200, (j) => j.companies.length !== 0 && "leak");
  check("outsider: preferences can't point at a company they can't open", await o("PATCH", "/v1/account/preferences", { lastCompanyId: "lumen-e2e" }), 403);

  // Builder via the classic code flow.
  const inv2 = await w("POST", "/v1/members/invite", { companyId: "lumen-e2e", email: "b@example.com", departments: [build], template: "builder" });
  await signAll(W, WNAME, inv2.json.transactions);
  const [row] = await db.getDb().select().from(db.invites).where(db.eq(db.invites.id, inv2.json.inviteId));
  const { code } = JSON.parse(await openString(deserialize(row.emailCiphertext!), serverKey(process.env.SESSION_SECRET!), "invite"));
  sim.fund(B.implicit, 0.1); // a brand-new wallet needs a little NEAR for gas to accept
  const accB = await b("POST", "/v1/invites/accept", { code });
  await signAll(B, B.implicit, accB.json.transactions);
  const ba = await b("GET", `/v1/analytics?companyId=lumen-e2e`);
  // The builder template grants view + builder + code (members.ts), so money and work, but not approvals.
  check("builder analytics (view+builder+code): money + work for their team, no control", ba, 200, (j) => (j.money === null || j.work === null || j.control !== null || j.teams.length !== 1) && JSON.stringify(j.sections));
  const br = await b("GET", `/v1/reports?companyId=lumen-e2e`);
  check("builder reports: own team only, code detail shown", br, 200, (j) => {
    const r = j.teams[0].reports[0];
    return (j.teams.length !== 1 || !r || !Array.isArray(r.facts.files) || !r.facts.commitSha) && JSON.stringify(r?.facts);
  });
  check("builder can read company plans", await b("GET", `/v1/plans?companyId=lumen-e2e`), 200);

  // Approver limited to one team: sees only that team's cards in the inbox and approvals.
  const A = newKey();
  sim.fund(A.implicit, 0.1);
  const la = await login(A, { method: "wallet" });
  const ac = client(la.json.token);
  const invA = await w("POST", "/v1/members/invite", { companyId: "lumen-e2e", email: "a@example.com", departments: [other ?? build], template: "approver" });
  await signAll(W, WNAME, invA.json.transactions);
  const [rowA] = await db.getDb().select().from(db.invites).where(db.eq(db.invites.id, invA.json.inviteId));
  const codeA = JSON.parse(await openString(deserialize(rowA.emailCiphertext!), serverKey(process.env.SESSION_SECRET!), "invite")).code;
  await signAll(A, A.implicit, (await ac("POST", "/v1/invites/accept", { code: codeA })).json.transactions);
  const teamA = `${other ?? build}.${C1}`;
  const teamX = `${build}.${C1}`;
  const tasksNow = (await w("GET", `/v1/tasks?companyId=${C1}`)).json.tasks;
  await index(sim.agentYield(teamX, { amount: "2000000", reason: "over_limit", seller: "near-ai-x402", taskId: tasksNow.find((t: any) => t.departmentId === teamX).id }), teamX);
  await index(sim.agentYield(teamA, { amount: "1500000", reason: "new_seller", seller: "new-seller", taskId: tasksNow.find((t: any) => t.departmentId === teamA).id }), teamA);
  const aib = await ac("GET", "/v1/inbox");
  check("team approver's inbox: only their team's card", aib, 200, (j) => {
    const cards = j.items.filter((i: any) => i.kind === "approval");
    return cards.length !== 1 && `cards ${cards.length}`;
  });
  check("team approver's /approvals: only their team's card", await ac("GET", `/v1/approvals?companyId=lumen-e2e`), 200, (j) => (j.cards.length !== 1 || j.cards[0].payload.department_id !== teamA) && `cards ${j.cards.length}`);
  const otherCard = (await w("GET", `/v1/approvals?companyId=lumen-e2e`)).json.cards.find((c: any) => c.payload.department_id === teamX);
  check("team approver can't decide another team's card", await ac("POST", `/v1/approvals/${otherCard.id}`, { decision: "approve" }), 403);
  check("builder's inbox has no approval cards (no approve scope)", await b("GET", "/v1/inbox"), 200, (j) => j.items.some((i: any) => i.kind === "approval") && "leak");
  check("team approver's overview: approvals counted for their team only", await ac("GET", "/v1/overview"), 200, (j) => j.companies.find((c: any) => c.companyId === C1)?.approvals?.pending !== 1 && JSON.stringify(j.companies[0]?.approvals));

  // Revoke the viewer.
  const rv = await w("DELETE", `/v1/members/${P.implicit}?companyId=lumen-e2e`);
  await signAll(W, WNAME, rv.json.transactions);
  check("after revoke: analytics → 403", await p("GET", `/v1/analytics?companyId=lumen-e2e`), 403);
  check("after revoke: company gone from overview", await p("GET", "/v1/overview"), 200, (j) => j.companies.some((c: any) => c.companyId === C1) && "still there");
  check("after revoke: company gone from /auth/me", await p("GET", "/v1/auth/me"), 200, (j) => j.companies.some((c: any) => c.companyId === C1) && "still there");
}

// ---------- preferences ----------
section = "prefs";
{
  check("set last company", await w("PATCH", "/v1/account/preferences", { lastCompanyId: "habit-e2e" }), 200, (j) => j.preferences.lastCompanyId !== C2 && JSON.stringify(j));
  check("home opens the last company", await w("GET", "/v1/auth/me"), 200, (j) => j.home.openCompanyId !== C2 && j.home.openCompanyId);
  check("dismissed tips are kept", await w("PATCH", "/v1/account/preferences", { dismissed: ["welcome", "welcome"] }), 200, (j) => j.preferences.dismissed.join() !== "welcome" && JSON.stringify(j));
  check("clear last company", await w("PATCH", "/v1/account/preferences", { lastCompanyId: null }), 200, (j) => "lastCompanyId" in j.preferences && "still set");
  check("unknown preference → 400", await w("PATCH", "/v1/account/preferences", { isAdmin: true }), 400);
}

// ---------- pause / resume ----------
section = "pause";
{
  const f = await w("POST", "/v1/freeze", { companyId: "lumen-e2e" });
  check("pause all → freeze tx", f, 200);
  await signAll(W, WNAME, f.json.transactions);
  check("overview ?fresh=1 shows the company paused right after signing", await w("GET", "/v1/overview?fresh=1"), 200, (j) => !j.companies.find((c: any) => c.companyId === C1).frozen && "not frozen");
  check("analytics control shows paused", await w("GET", `/v1/analytics?companyId=lumen-e2e`), 200, (j) => (!j.control.companyFrozen || !j.control.pausedTeams.length) && JSON.stringify(j.control));
  let blocked = false;
  try {
    sim.agentPurchase(`${d1.suggestedSetup.teams[0].team}.${C1}`, { amount: "1", model: "m", seller: "s", taskId: "t" });
  } catch {
    blocked = true;
  }
  truth("agents can't spend while paused (contract)", blocked);
  const u = await w("POST", "/v1/unfreeze", { companyId: "lumen-e2e" });
  await signAll(W, WNAME, u.json.transactions);
  check("builder can't resume (founder only)", await b("POST", "/v1/unfreeze", { companyId: "lumen-e2e" }), 403);
}

// ---------- older routes still behave ----------
section = "regression";
{
  check("/teams", await w("GET", `/v1/teams?companyId=lumen-e2e`), 200, (j) => j.teams.length !== d1.suggestedSetup.teams.length && "teams");
  check("/companies/:id", await w("GET", `/v1/companies/lumen-e2e`), 200, (j) => (j.access.founder !== true || j.slug !== "lumen-e2e") && "access");
  check("/members (founder sees everyone)", await w("GET", `/v1/members?companyId=lumen-e2e`), 200);
  check("/ledger", await w("GET", `/v1/ledger?companyId=lumen-e2e`), 200, (j) => !j.receipts?.length && "no receipts");
  check("/deposit (testnet: per-team addresses)", await w("GET", `/v1/deposit?companyId=lumen-e2e`), 200, (j) => (j.supported !== false || !j.teams.every((t: any) => t.address)) && "deposit");
  check("/policy raise a team budget (v3) → dept_call", await w("POST", "/v1/policy", { companyId: "lumen-e2e", team: d1.suggestedSetup.teams[0].team, budgetIncrease: "1000000" }), 200);
  check("/estimate public", await client(null)("GET", "/v1/estimate?tag=backend&size=m"), 200);
  const tok = await w("POST", "/v1/stream/token");
  check("stream token", tok, 200);
  // SSE: a new report reaches the founder's stream.
  const ctl = new AbortController();
  const got: string[] = [];
  const res = await fetch(`${API}/v1/stream?token=${encodeURIComponent(tok.json.token)}&companyId=lumen-e2e`, { signal: ctl.signal, headers: { origin: ORIGIN } });
  const reader = res.body!.getReader();
  const pump = (async () => {
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        got.push(dec.decode(value));
      }
    } catch {
      /* aborted */
    }
  })();
  await sleep(300);
  const t = (await w("GET", `/v1/tasks?companyId=${C1}`)).json.tasks.find((x: any) => x.status === "assigned");
  await db.getDb().update(db.tasks).set({ attempts: 1 }).where(db.eq(db.tasks.id, t.id));
  await recordTaskReport(t.id, { outcome: "retrying", error: "model timeout" });
  await sleep(800);
  ctl.abort();
  await pump;
  truth("SSE carries task_reported to the founder", got.join("").includes("event: task_reported"), got.join("").slice(0, 300));
}

// ---------- done ----------
const passed = evidence.filter((e) => e.ok).length;
console.log(`\n${passed}/${evidence.length} passed`);
fs.writeFileSync(process.env.EVIDENCE ?? "e2e-evidence-flow.json", JSON.stringify({ when: new Date().toISOString(), passed, total: evidence.length, fails, evidence }, null, 2));
await app.close();
await hub.stop();
await db.closeDb();
simSrv.close();
{
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  await c.query(`drop database if exists ${dbName} with (force)`);
  await c.end();
}
if (fails.length) {
  console.log("\nFailures:\n" + fails.map((f) => ` - ${f}`).join("\n"));
  process.exit(1);
}
process.exit(0);

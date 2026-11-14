/**
 * Company treasury on NEAR Intents, end to end in mainnet mode: deposit address, withdrawal planning, the
 * founder's `request_withdrawal` moving the funds, and the worker following the 1Click swap to its outcome.
 *
 *   DATABASE_URL=postgres://…/postgres npx tsx tests/e2e/intents.mts
 *
 * NEAR Intents and 1Click exist on mainnet only, so this runs the real API, indexer, worker event router and
 * bridge worker with NETWORK=mainnet against `tests/sim/near-sim.ts` (which models the Intents contract and
 * the version-4 company contract) and `tests/sim/oneclick-mock.ts`. No real funds, no real network.
 */
import { createHash, generateKeyPairSync, randomBytes, sign as signEs256 } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import pg from "pg";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { NearSim } from "../sim/near-sim.ts";
import { OneClickMock } from "../sim/oneclick-mock.ts";

const FACTORY = "builderos-e2e.near";
const ORIGIN = "http://localhost:3000";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDC_CONTRACT = USDC.slice("nep141:".length);
const sim = new NearSim(FACTORY, "v1.signer");
sim.intents = "intents.near";
const simSrv = await sim.listen();
const oneClick = new OneClickMock();
const ocSrv = await oneClick.listen();

const adminUrl = process.env.DATABASE_URL ?? "postgres://builderos:builderos@localhost:5432/builderos";
const dbName = `bos_intents_${Date.now().toString(36)}`;
{
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  await c.query(`create database ${dbName}`);
  await c.end();
}
const dbUrl = adminUrl.replace(/\/[^/]+$/, `/${dbName}`);
Object.assign(process.env, {
  NODE_ENV: "development",
  NETWORK: "mainnet",
  DATABASE_URL: dbUrl,
  NEAR_RPC_URL: simSrv.url,
  NEAR_RPC_FALLBACK_URL: simSrv.url,
  BASE_RPC_URL: simSrv.url,
  FACTORY_CONTRACT: FACTORY,
  REGISTRY_CONTRACT: `registry.${FACTORY}`,
  ONECLICK_BASE_URL: ocSrv.url,
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
const { runWithdrawal, setChainCaller } = await import("../../packages/bridge/src/index.ts");
const { notify } = await import("../../packages/notify/src/index.ts");
const { nep413Payload } = await import("../../packages/near/src/nep413.ts");
const { forgetCompanyVersion } = await import("../../packages/near/src/contracts.ts");
const db = await import("../../packages/db/src/index.ts");

const log = createLogger("e2e-intents");
const hub = new SseHub(log);
await hub.start();
const app = await buildApp({ log, hub });
await app.listen({ port: 0, host: "127.0.0.1" });
const API = `http://127.0.0.1:${(app.server.address() as any).port}`;

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
  console.log(`${ok ? "PASS" : "FAIL"}  ${section.padEnd(12)} ${step.padEnd(86)} ${String(status).padEnd(4)} ${ok ? "" : (note ?? "")}`);
}
function check(step: string, r: { status: number; json: any }, want: number, test?: (j: any) => string | null | false | undefined) {
  let ok = r.status === want;
  let note = ok ? undefined : `want ${want}: ${JSON.stringify(r.json).slice(0, 260)}`;
  if (ok && test) {
    try {
      const bad = test(r.json);
      if (bad) [ok, note] = [false, String(bad)];
    } catch (e: any) {
      [ok, note] = [false, `check threw: ${e?.message}`];
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
/** Sign in through Privy with a verified email, so the account can create a company at once. */
async function signIn(k: Key, email: string): Promise<Client> {
  const ch: any = await (await fetch(`${API}/v1/auth/challenge?accountId=${k.implicit}`, { headers: { origin: ORIGIN } })).json();
  const payload = nep413Payload({ message: ch.message, nonce: Buffer.from(ch.nonce, "base64"), recipient: ch.recipient });
  const sig = ed25519.sign(createHash("sha256").update(payload).digest(), k.seed);
  const privy = privyToken({ linked_accounts: JSON.stringify([{ type: "email", address: email }, { type: "wallet", address: k.implicit, chain_type: "near" }]) });
  const body = { accountId: k.implicit, publicKey: k.pk, signature: Buffer.from(sig).toString("base64"), message: ch.message, nonce: ch.nonce, loginMethod: "privy", privyIdentityToken: privy };
  const r = await fetch(`${API}/v1/auth/verify`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });
  const j: any = await r.json();
  if (r.status !== 200) throw new Error(`sign-in failed: ${JSON.stringify(j)}`);
  return client(j.token);
}

// ---------- chain plumbing ----------
/** The bridge worker's queue, run by hand so the test controls when a swap is followed. */
const jobs: any[] = [];
const workerSend = async (queue: string, data: any) => {
  if (queue === "notify.send") await notify(data.alert, log).catch(() => {});
  if (queue === db.QUEUES.bridgeWithdraw) jobs.push(data);
};
async function index(t: { hash: string; height: number; status: any }, signer: string) {
  await processTx(t.hash, signer, t.height, t.status, { log, onEvent: (e: any) => handleEvent(e, { send: workerSend, log }) });
}
// The worker's record-only call: signed by the worker account on the simulated chain, then indexed.
setChainCaller(async (c) => {
  const res = sim.workerCall(c.contractId, c.methodName, c.args);
  await index(res, sim.worker);
  return res;
});
async function signTx(k: Key, signer: string, t: any) {
  const { signerId: _s, ...txOnly } = t;
  const msg = createHash("sha256").update(JSON.stringify({ signerId: signer, tx: txOnly })).digest();
  const res = sim.send(signer, k.pk, Buffer.from(ed25519.sign(msg, k.seed)).toString("base64"), txOnly);
  await index(res, signer);
  return res;
}
async function signAll(k: Key, signer: string, txs: any[]) {
  for (const t of txs) {
    const res = await signTx(k, signer, t);
    if (res.failure) throw new Error(`tx ${t.actions[0].params.methodName} failed: ${res.failure}`);
  }
}
const runJob = () => runWithdrawal(jobs.shift(), log, { pollMs: 10, tries: 3 });
const row = async (id: string) => (await db.getDb().select().from(db.withdrawals).where(db.eq(db.withdrawals.id, id)))[0];
const ledger = async (c: Client, companyId: string) => (await c("GET", `/v1/ledger?companyId=${companyId}&kind=withdrawal`)).json.receipts as any[];

// =====================================================================================================
section = "setup";
const F = newKey(); // founder
const O = newKey(); // outsider
sim.fund(F.implicit, 80);
sim.fund(O.implicit, 80);
const f = await signIn(F, "founder@example.com");
const o = await signIn(O, "outsider@example.com");
let C = "";
{
  check("API runs in mainnet mode", await client(null)("GET", "/health"), 200);
  const d = await f("POST", "/v1/drafts", { what: "A notes app for small teams. Notes API with sharing links. Editor UI. Growth: launch campaign and waitlist." });
  check("founder makes a draft", d, 200);
  const r = await f("POST", "/v1/companies", { name: "Treasury", slug: "treasury-e2e", planId: d.json.draft.id });
  check("founder launches a company", r, 200);
  C = r.json.companyId;
  await signAll(F, F.implicit, r.json.transactions);
  truth("company is on chain at contract version 4", sim.view(C, "contract_version", {}) === 4, String(sim.view(C, "contract_version", {})));
}

// ---------- deposit ----------
section = "deposit";
{
  const r = await f("GET", `/v1/deposit?companyId=${C}`);
  check("deposit info on mainnet: one company address through NEAR Intents", r, 200, (j) =>
    (j.supported !== true || j.address !== C || j.method !== "near_intents" || !j.tokens.some((t: any) => t.tokenId === USDC)) && JSON.stringify(j).slice(0, 240),
  );
  const empty = await f("POST", "/v1/withdrawals", { companyId: C, amount: "1000000", token: "USDC", to: "0x1111111111111111111111111111111111111111", chain: "base" });
  check("withdraw from an empty treasury → 409 insufficient_funds, available 0", empty, 409, (j) => (j.code !== "insufficient_funds" || j.details?.available !== "0") && JSON.stringify(j));
  // what a USDC ft_transfer_call to intents.near with msg = the company id does
  sim.intentsDeposit(C, USDC, 500_000_000n);
  truth("the company's Intents balance reads 500 USDC", sim.view("intents.near", "mt_balance_of", { account_id: C, token_id: USDC }) === "500000000");
}

// ---------- planning ----------
section = "plan";
const EVM = "0x52908400098527886E0F7030069857D2E4169EE7";
{
  const body = { companyId: C, amount: "120000000", token: "USDC", to: EVM, chain: "base" };
  check("an outsider can't plan a withdrawal → 403", await o("POST", "/v1/withdrawals", body), 403);
  check("more than the balance → 409 with the real available amount", await f("POST", "/v1/withdrawals", { ...body, amount: "500000001" }), 409, (j) => (j.code !== "insufficient_funds" || j.details?.available !== "500000000") && JSON.stringify(j));
  check("a NEAR account as a Base address → 400", await f("POST", "/v1/withdrawals", { ...body, to: "someone.near" }), 400);
  check("an EVM address as a NEAR account → 400", await f("POST", "/v1/withdrawals", { ...body, chain: "near" }), 400);
  check("a token other than USDC → 400", await f("POST", "/v1/withdrawals", { ...body, token: "NEAR" }), 400);
  check("zero amount → 400", await f("POST", "/v1/withdrawals", { ...body, amount: "0" }), 400);

  sim.companies.get(C)!.version = 3;
  forgetCompanyVersion(C);
  check("company still on contract version 3 → 409 contract_upgrade_required (no transaction built)", await f("POST", "/v1/withdrawals", body), 409, (j) =>
    (j.code !== "contract_upgrade_required" || j.details?.requiredVersion !== 4 || j.details?.currentVersion !== 3 || j.transaction) && JSON.stringify(j),
  );
  sim.companies.get(C)!.version = 4;
  forgetCompanyVersion(C);

  oneClick.down = true;
  check("1Click is down → 503, nothing planned", await f("POST", "/v1/withdrawals", body), 503, (j) => j.code !== "unavailable" && j.code);
  oneClick.down = false;
  truth("no quote was committed while planning failed", oneClick.swaps.size === 0, String(oneClick.swaps.size));
}

// ---------- to another chain ----------
section = "swap";
let firstTx: any = null;
{
  const r = await f("POST", "/v1/withdrawals", { companyId: C, amount: "120000000", token: "USDC", to: EVM, chain: "base" });
  check("plan a Base withdrawal → swap route with a committed quote", r, 200, (j) => {
    const p = j.plan;
    if (p.route !== "swap" || p.chain !== "base" || p.to !== EVM) return "route";
    if (p.quote.amountOut !== "119880000" || p.quote.fees !== "120000") return `quote ${p.quote.amountOut}/${p.quote.fees}`;
    if (!/^[0-9a-f]{64}$/.test(p.quote.depositAddress) || !p.quote.deadline || !p.quote.quoteId) return "quote fields";
    if (p.quote.destinationAsset !== "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near") return `dest ${p.quote.destinationAsset}`;
    if (p.sources.length !== 1 || p.sources[0].from !== "intents" || p.sources[0].estFee !== "120000" || p.available.intents !== "500000000") return "sources";
    return null;
  });
  const { plan, transaction } = r.json;
  const dep = plan.quote.depositAddress;
  const q = oneClick.swaps.get(dep)!;
  truth("the quote asks 1Click for Intents USDC → Base USDC to the founder's address, refunds to the company", q.request.originAsset === USDC && q.request.recipient === EVM && q.request.refundTo === C && q.request.depositType === "INTENTS" && q.request.refundType === "INTENTS" && q.request.dry === false, JSON.stringify(q.request));
  const a = transaction.actions[0].params;
  truth("the transaction is the founder's request_withdrawal on the company, 1 yocto", transaction.receiverId === C && transaction.signerId === F.implicit && a.methodName === "request_withdrawal" && a.deposit === "1" && a.args.route === "swap" && a.args.token_id === USDC && a.args.deposit_address === dep, JSON.stringify(transaction).slice(0, 300));
  truth("before signing: saved as quoted, nothing moved", (await row(plan.withdrawalId)).status === "quoted" && sim.intentsBalance(C, USDC) === 500_000_000n);

  const bad = await signTx(O, O.implicit, { ...transaction, signerId: O.implicit });
  truth("someone else signing the same transaction is refused by the contract", !!bad.failure && sim.intentsBalance(C, USDC) === 500_000_000n, String(bad.failure));

  firstTx = transaction;
  const res = await signTx(F, F.implicit, transaction);
  truth("founder signs; the funds leave the company inside Intents to the quote's account", !res.failure && sim.intentsBalance(C, USDC) === 380_000_000n && sim.intentsBalance(dep, USDC) === 120_000_000n, String(res.failure));
  truth("the worker got one job, carrying the route, deposit address and the NEAR tx", jobs.length === 1 && jobs[0].route === "swap" && jobs[0].depositAddress === dep && jobs[0].nearTx === res.hash && jobs[0].withdrawalId === plan.withdrawalId, JSON.stringify(jobs[0]));

  // 1Click hasn't finished: the job gives up for now and stays retryable, nothing is recorded
  let stillRunning = "";
  const job = jobs[0];
  await runWithdrawal(job, log, { pollMs: 5, tries: 2 }).catch((e: any) => (stillRunning = String(e.message)));
  truth("swap still processing → the job throws to be retried; no outcome recorded", /still processing/.test(stillRunning) && (await row(plan.withdrawalId)).status === "running" && (await ledger(f, C)).length === 0, stillRunning);
  truth("1Click was told the funding transaction", q.submitted === res.hash, String(q.submitted));

  oneClick.settle(dep, "SUCCESS");
  const out = await runJob();
  truth("swap delivered → recorded done", out.status === "done" && (await row(plan.withdrawalId)).status === "done", JSON.stringify(out));
  const led = await ledger(f, C);
  truth("ledger shows the withdrawal with what arrived, the fee and both transactions", led.length === 1 && led[0].payload.status === "done" && led[0].payload.amount_out === "119880000" && led[0].payload.fees === "120000" && led[0].payload.to === EVM && led[0].payload.chain === "base" && led[0].payload.origin_tx === res.hash && !!led[0].payload.dest_tx, JSON.stringify(led[0]?.payload));
  const again = await runWithdrawal(job, log, { pollMs: 5, tries: 1 });
  truth("running the finished job again records nothing new", again.status === "done" && (await ledger(f, C)).length === 1);
  check("the next plan sees the reduced balance", await f("POST", "/v1/withdrawals", { companyId: C, amount: "380000001", token: "USDC", to: EVM, chain: "base" }), 409, (j) => j.details?.available !== "380000000" && JSON.stringify(j.details));
}

// ---------- replay ----------
section = "replay";
{
  const before = sim.intentsBalance(C, USDC);
  const res = await signTx(F, F.implicit, firstTx);
  truth("signing the same withdrawal twice is refused by the contract; nothing moves", !!res.failure && /already requested/.test(String(res.failure)) && sim.intentsBalance(C, USDC) === before && jobs.length === 0, String(res.failure));
}

// ---------- refunded / failed swaps ----------
section = "outcomes";
{
  const r = await f("POST", "/v1/withdrawals", { companyId: C, amount: "50000000", token: "USDC", to: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", chain: "solana" });
  check("plan a Solana withdrawal", r, 200, (j) => (j.plan.route !== "swap" || j.plan.quote.destinationAsset !== "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near") && JSON.stringify(j.plan.quote));
  const dep = r.json.plan.quote.depositAddress;
  await signAll(F, F.implicit, [r.json.transaction]);
  oneClick.settle(dep, "REFUNDED");
  sim.intentsDeposit(C, USDC, 50_000_000n); // 1Click returns the funds to refundTo (the company) inside Intents
  const out = await runJob();
  const led = await ledger(f, C);
  truth("refunded swap → recorded refunded, amount out 0, and the money is back in the company", out.status === "refunded" && (await row(r.json.plan.withdrawalId)).status === "refunded" && led.some((x) => x.payload.withdrawal_id === r.json.plan.withdrawalId && x.payload.status === "refunded" && x.payload.amount_out === "0") && sim.intentsBalance(C, USDC) === 380_000_000n, JSON.stringify(out));

  const r2 = await f("POST", "/v1/withdrawals", { companyId: C, amount: "30000000", token: "USDC", to: EVM, chain: "arbitrum" });
  check("plan an Arbitrum withdrawal", r2, 200, (j) => j.plan.quote.destinationAsset !== "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near" && j.plan.quote.destinationAsset);
  await signAll(F, F.implicit, [r2.json.transaction]);
  oneClick.settle(r2.json.plan.quote.depositAddress, "FAILED");
  const out2 = await runJob();
  truth("failed swap → recorded failed (never shown as delivered)", out2.status === "failed" && (await ledger(f, C)).some((x) => x.payload.withdrawal_id === r2.json.plan.withdrawalId && x.payload.status === "failed"), JSON.stringify(out2));
}

// ---------- straight to a NEAR account ----------
section = "near";
{
  sim.ftRegistered.add(`${USDC_CONTRACT}:founder-wallet.near`);
  const r = await f("POST", "/v1/withdrawals", { companyId: C, amount: "100000000", token: "USDC", to: "founder-wallet.near", chain: "near" });
  const swapsBefore = oneClick.swaps.size;
  check("plan a NEAR withdrawal → direct route, no quote, no fee", r, 200, (j) => (j.plan.route !== "near" || j.plan.quote.fees !== "0" || j.plan.quote.amountOut !== "100000000" || j.plan.quote.depositAddress !== null || j.plan.quote.deadline !== null) && JSON.stringify(j.plan));
  truth("no 1Click quote is used for NEAR", oneClick.swaps.size === swapsBefore);
  const before = sim.intentsBalance(C, USDC);
  await signAll(F, F.implicit, [r.json.transaction]);
  truth("founder signs; USDC lands in the NEAR account", sim.intentsBalance(C, USDC) === before - 100_000_000n && sim.ftBalance("founder-wallet.near", USDC_CONTRACT) === 100_000_000n);
  const out = await runJob();
  truth("recorded done with the full amount", out.status === "done" && (await ledger(f, C)).some((x) => x.payload.withdrawal_id === r.json.plan.withdrawalId && x.payload.status === "done" && x.payload.amount_out === "100000000" && x.payload.chain === "near"));
}

// ---------- the Intents transfer fails ----------
section = "failure";
{
  // an account that never registered with the USDC contract: Intents can't deliver, the contract's callback sees it
  const r = await f("POST", "/v1/withdrawals", { companyId: C, amount: "10000000", token: "USDC", to: "unregistered.near", chain: "near" });
  check("plan to an unregistered NEAR account", r, 200);
  const before = sim.intentsBalance(C, USDC);
  const res = await signTx(F, F.implicit, r.json.transaction);
  truth("transfer fails → nothing leaves the company, no worker job, marked failed", !res.failure && sim.intentsBalance(C, USDC) === before && jobs.length === 0 && (await row(r.json.plan.withdrawalId)).status === "failed", `${res.failure} jobs ${jobs.length}`);
  truth("a failed transfer is not in the ledger as a withdrawal", !(await ledger(f, C)).some((x) => x.payload.withdrawal_id === r.json.plan.withdrawalId));
  sim.ftRegistered.add(`${USDC_CONTRACT}:unregistered.near`);
  const retry = await signTx(F, F.implicit, r.json.transaction);
  truth("the id is released after a failed transfer: the same plan can be signed again and now pays", !retry.failure && sim.intentsBalance(C, USDC) === before - 10_000_000n && jobs.length === 1, String(retry.failure));
  const out = await runJob();
  truth("the retried withdrawal is followed and recorded done", out.status === "done" && (await row(r.json.plan.withdrawalId)).status === "done", JSON.stringify(out));
}

// ---------- totals ----------
section = "totals";
{
  // 500 in; out: 120 (base) + 30 (arbitrum, failed in flight) + 100 (near) + 10 (near); the 50 was refunded
  truth("the company's Intents balance matches every movement: 240 USDC left", sim.intentsBalance(C, USDC) === 240_000_000n, sim.intentsBalance(C, USDC).toString());
  const led = await ledger(f, C);
  truth("ledger has one entry per withdrawal that moved money (5)", led.length === 5, String(led.length));
  check("outsider can't read the ledger", await o("GET", `/v1/ledger?companyId=${C}`), 403);
}

// ---------- done ----------
const passed = evidence.filter((e) => e.ok).length;
console.log(`\n${passed}/${evidence.length} passed`);
fs.writeFileSync(process.env.EVIDENCE ?? "e2e-evidence-intents.json", JSON.stringify({ when: new Date().toISOString(), passed, total: evidence.length, fails, evidence }, null, 2));
await app.close();
await hub.stop();
await db.closeDb();
simSrv.close();
ocSrv.close();
{
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  await c.query(`drop database if exists ${dbName} with (force)`);
  await c.end();
}
if (fails.length) {
  console.log("\nFailures:\n" + fails.map((x) => ` - ${x}`).join("\n"));
  process.exit(1);
}
process.exit(0);

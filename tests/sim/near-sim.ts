/**
 * NEAR testnet stand-in for end-to-end runs when testnet isn't reachable. It is a test double, not a chain:
 *
 *  - JSON-RPC: `query` (call_function views, view_account, view_access_key_list), `EXPERIMENTAL_tx_status`,
 *    `block`, plus Base `eth_call` (USDC balanceOf → 0).
 *  - POST /sim/send executes one wallet-selector transaction for a signer. The signer must prove the key
 *    (ed25519 signature over the transaction, key = the implicit account or a full-access key we know).
 *  - Contract rules mirror contracts/{factory,company,department}/src/lib.rs for the methods the web flow
 *    uses (founder/admin/approve checks, deposits, frozen, single-use invites, team limits on approvals), and
 *    every state change emits the same NEP-297 `EVENT_JSON` logs so the real indexer can process them.
 *  - Agent side (no wallet): POST /sim/agent/purchase and /sim/agent/yield emit payment/approval events.
 */
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";

const ONE_NEAR = 10n ** 24n;
const GAS_FEE = 10n ** 21n; // 0.001 NEAR per tx
const UPGRADE_FREE = new Set(["allow_seller", "set_evm_config", "top_up_budget"]);
const FORWARD = new Set(["assign_task", "set_task_tier", "set_task_hire", "set_rail_float", "allow_seller", "set_evm_config", "top_up_budget", "freeze"]);

type Grant = { account_id: string; department_id: string; scopes: string[]; limit: string | null; expires_at_ms: number | null; revoked: boolean };
type Dept = { id: string; name: string; company: string; budget: bigint; spent: bigint; reserved: bigint; perTx: bigint; frozen: boolean; base: string | null; tasks: Map<string, any>; agents: Map<string, string> };
type Company = {
  id: string;
  founder: string;
  name: string;
  preset: string;
  frozen: boolean;
  dailyCap: bigint;
  spentToday: bigint;
  codeKeyVersion: number;
  version: number;
  depts: string[];
  grants: Map<string, Grant>;
  invites: Map<string, { departments: string[]; scopes: string[]; limit: string | null; expires_at_ms: number }>;
  pending: Map<string, { department: string; amount: string; reason: string }>;
};

export class NearSim {
  height = 100_000_000;
  balances = new Map<string, bigint>();
  fullKeys = new Map<string, Set<string>>(); // account → ed25519:… full-access keys (named accounts)
  factoryCompanies = new Map<string, { company_id: string; founder: string; name: string; preset: string }>();
  companies = new Map<string, Company>();
  depts = new Map<string, Dept>();
  txs = new Map<string, any>();
  /** Every executed tx (hash, signer, status) — the harness feeds these to the indexer. */
  log: Array<{ hash: string; signer: string; height: number; status: any }> = [];
  calls = 0;
  /**
   * NEAR Intents (the verifier contract). Null = not deployed, which is the testnet situation: views on it fail
   * and a withdrawal's transfer fails. Set `intents` to an account id to model mainnet.
   */
  intents: string | null = null;
  /** Intents balances: account → token id → amount. */
  intentsBalances = new Map<string, Map<string, bigint>>();
  /** NEAR-side FT balances credited by Intents `ft_withdraw`: account → token contract → amount. */
  ftBalances = new Map<string, Map<string, bigint>>();
  /** NEAR accounts registered with a token contract (ft_withdraw to anyone else fails, as on chain). */
  ftRegistered = new Set<string>();
  /** Withdrawal ids already used, per company (contract storage `wd:<id>`). */
  withdrawalIds = new Set<string>();
  /** Service account allowed to record outcomes (the company's worker_id). */
  worker = "worker.sim";
  failNextView: string | null = null;

  constructor(public factory: string, public mpc = "v1.signer-prod.testnet", public registry = `registry.${factory}`) {
    this.balances.set(factory, 100n * ONE_NEAR);
  }

  /** Credit an account inside Intents (what `ft_transfer_call` to the Intents contract with msg = account does). */
  intentsDeposit(account: string, tokenId: string, amount: bigint) {
    const m = this.intentsBalances.get(account) ?? new Map<string, bigint>();
    m.set(tokenId, (m.get(tokenId) ?? 0n) + amount);
    this.intentsBalances.set(account, m);
  }
  intentsBalance(account: string, tokenId: string) {
    return this.intentsBalances.get(account)?.get(tokenId) ?? 0n;
  }
  ftBalance(account: string, token: string) {
    return this.ftBalances.get(account)?.get(token) ?? 0n;
  }
  /** Intents `mt_transfer`: move a token between two Intents accounts. Throws like the contract panics. */
  private mtTransfer(from: string, to: string, tokenId: string, amount: bigint) {
    if (!this.intents) throw new Error("intents: account does not exist");
    const have = this.intentsBalance(from, tokenId);
    if (amount <= 0n || have < amount) throw new Error("intents: insufficient balance");
    this.intentsBalances.get(from)!.set(tokenId, have - amount);
    this.intentsDeposit(to, tokenId, amount);
  }
  /** Intents `ft_withdraw`: the token leaves Intents to a NEAR account registered with the token contract. */
  private ftWithdraw(from: string, token: string, receiver: string, amount: bigint) {
    if (!this.intents) throw new Error("intents: account does not exist");
    const tokenId = `nep141:${token}`;
    const have = this.intentsBalance(from, tokenId);
    if (amount <= 0n || have < amount) throw new Error("intents: insufficient balance");
    if (!this.ftRegistered.has(`${token}:${receiver}`)) throw new Error("intents: receiver is not registered with the token");
    this.intentsBalances.get(from)!.set(tokenId, have - amount);
    const m = this.ftBalances.get(receiver) ?? new Map<string, bigint>();
    m.set(token, (m.get(token) ?? 0n) + amount);
    this.ftBalances.set(receiver, m);
  }
  /** A call signed by the worker's record-only key (the harness uses it in place of near-api-js). */
  workerCall(receiver: string, method: string, args: any) {
    const logs: Array<{ executor: string; log: string }> = [];
    this.exec(this.worker, receiver, method, args, 0n, logs);
    return this.agentTx(this.worker, logs, String(args?.withdrawal_id ?? ""));
  }

  fund(account: string, near: number) {
    this.balances.set(account, (this.balances.get(account) ?? 0n) + BigInt(Math.round(near * 1000)) * (ONE_NEAR / 1000n));
  }

  // ---------------- views ----------------
  view(account: string, method: string, args: any): unknown {
    if (account === this.factory) {
      if (method === "get_company") return this.factoryCompanies.get(args.slug) ?? null;
      if (method === "get_pending_refund") return "0";
      throw new Error("MethodNotFound");
    }
    if (this.intents && account === this.intents) {
      if (method === "mt_balance_of") return this.intentsBalance(args.account_id, args.token_id).toString();
      throw new Error("MethodNotFound");
    }
    if (account === this.registry) {
      if (method === "list_sellers" || method === "list_hireable_agents") return [];
      return null;
    }
    if (account === this.mpc && method === "derived_public_key") {
      const a = createHash("sha256").update(`${args.path}:${args.predecessor}:x`).digest();
      const b = createHash("sha256").update(`${args.path}:${args.predecessor}:y`).digest();
      return `secp256k1:${bs58.encode(Buffer.concat([a, b]))}`;
    }
    const c = this.companies.get(account);
    if (c) {
      switch (method) {
        case "contract_version":
          return c.version;
        case "get_company":
          return { founder: c.founder, name: c.name, frozen: c.frozen, code_key_version: c.codeKeyVersion, daily_cap: c.dailyCap.toString(), spent_today: c.spentToday.toString(), registry_id: this.registry };
        case "get_grant":
          return c.grants.get(args.account_id) ?? null;
        case "get_departments":
          return c.depts.map((id) => ({ name: this.depts.get(id)!.name, department_id: id }));
        case "get_pending_approval":
          return c.pending.get(args.request_id) ?? null;
        default:
          throw new Error("MethodNotFound");
      }
    }
    const d = this.depts.get(account);
    if (d) {
      if (method === "get_department")
        return { budget: d.budget.toString(), spent: d.spent.toString(), reserved: d.reserved.toString(), per_tx_limit: d.perTx.toString(), frozen: d.frozen, company_id: d.company, base_address: d.base, evm_chain_id: 84532, evm_usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" };
      if (method === "get_request") return null;
      throw new Error("MethodNotFound");
    }
    throw new Error("UNKNOWN_ACCOUNT");
  }

  exists(account: string) {
    return this.balances.has(account) || this.companies.has(account) || this.depts.has(account) || (this.intents !== null && account === this.intents);
  }

  // ---------------- transactions ----------------
  /** Execute one wallet-selector tx. Returns a FinalExecutionOutcome-like status (Failure on any panic). */
  send(signer: string, publicKey: string, signature: string, t: any) {
    const msg = createHash("sha256").update(JSON.stringify({ signerId: signer, tx: t })).digest();
    const pk = bs58.decode(publicKey.replace(/^ed25519:/, ""));
    if (!ed25519.verify(Buffer.from(signature, "base64"), msg, pk)) throw new Error("InvalidSignature");
    const implicit = Buffer.from(pk).toString("hex");
    if (signer !== implicit && !this.fullKeys.get(signer)?.has(publicKey)) throw new Error("InvalidAccessKey: key isn't a full-access key of the signer");
    const hash = bs58.encode(randomBytes(32));
    this.height += 1;
    const outcomes: any[] = [];
    let failure: string | null = null;
    // Snapshot for atomic rollback of a failed receipt (one tx = one receipt here).
    const snap = this.snapshot();
    try {
      for (const a of t.actions) {
        const deposit = BigInt(a.params.deposit);
        const bal = this.balances.get(signer) ?? 0n;
        if (bal < deposit + GAS_FEE) throw new Error(`NotEnoughBalance: ${signer} has ${bal}, needs ${deposit + GAS_FEE}`);
        this.balances.set(signer, bal - deposit - GAS_FEE);
        const logs: Array<{ executor: string; log: string }> = [];
        this.exec(signer, t.receiverId, a.params.methodName, a.params.args, deposit, logs);
        for (const l of logs) outcomes.push({ id: bs58.encode(randomBytes(32)), outcome: { executor_id: l.executor, logs: [l.log], status: { SuccessValue: "" } } });
      }
    } catch (e: any) {
      this.restore(snap);
      const bal = this.balances.get(signer) ?? 0n;
      this.balances.set(signer, bal > GAS_FEE ? bal - GAS_FEE : 0n);
      failure = String(e?.message ?? e);
    }
    const status = {
      status: failure ? { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${failure}` } } } } } : { SuccessValue: "" },
      transaction: { hash, signer_id: signer, receiver_id: t.receiverId },
      transaction_outcome: { id: hash, outcome: { executor_id: signer, logs: [], status: { SuccessReceiptId: "x" } } },
      receipts_outcome: failure ? [{ id: bs58.encode(randomBytes(32)), outcome: { executor_id: t.receiverId, logs: [], status: { Failure: failure } } }] : outcomes,
    };
    this.txs.set(hash, status);
    this.log.push({ hash, signer, height: this.height, status });
    return { hash, height: this.height, status, failure };
  }

  private snapshot() {
    const clone = (c: Company): Company => ({ ...c, depts: [...c.depts], grants: new Map([...c.grants].map(([k, v]) => [k, { ...v }])), invites: new Map(c.invites), pending: new Map(c.pending) });
    return {
      balances: new Map(this.balances),
      intentsBalances: new Map([...this.intentsBalances].map(([k, v]) => [k, new Map(v)])),
      ftBalances: new Map([...this.ftBalances].map(([k, v]) => [k, new Map(v)])),
      withdrawalIds: new Set(this.withdrawalIds),
      factoryCompanies: new Map(this.factoryCompanies),
      companies: new Map([...this.companies].map(([k, v]) => [k, clone(v)])),
      depts: new Map([...this.depts].map(([k, v]) => [k, { ...v, tasks: new Map(v.tasks), agents: new Map(v.agents) }])),
    };
  }
  private restore(s: ReturnType<NearSim["snapshot"]>) {
    this.balances = s.balances;
    this.intentsBalances = s.intentsBalances;
    this.ftBalances = s.ftBalances;
    this.withdrawalIds = s.withdrawalIds;
    this.factoryCompanies = s.factoryCompanies;
    this.companies = s.companies;
    this.depts = s.depts;
  }

  private emit(logs: Array<{ executor: string; log: string }>, executor: string, event: string, data: Record<string, unknown>) {
    logs.push({ executor, log: `EVENT_JSON:${JSON.stringify({ standard: "builderos", version: "1.0.0", event, data: [data] })}` });
  }

  private has(c: Company, account: string, scopes: string[]) {
    const g = c.grants.get(account);
    return Boolean(g && !g.revoked && (!g.expires_at_ms || g.expires_at_ms >= Date.now()) && g.scopes.some((s) => s === "admin" || scopes.includes(s)));
  }
  private teamLimit(c: Company, account: string): string | null {
    if (account === c.founder) return null;
    const g = c.grants.get(account);
    if (!g || g.scopes.includes("admin") || g.department_id === c.id) return null;
    return g.department_id;
  }

  private exec(signer: string, receiver: string, method: string, args: any, deposit: bigint, logs: Array<{ executor: string; log: string }>) {
    const req = (ok: unknown, msg: string) => {
      if (!ok) throw new Error(msg);
    };
    if (receiver === this.factory) {
      if (method === "create_company") {
        req(/^[a-z0-9-]{2,32}$/.test(args.slug), "bad slug");
        req(!this.factoryCompanies.has(args.slug), "slug taken");
        req(deposit >= (75n * ONE_NEAR) / 10n, "attach >= 7.5 NEAR (company wasm storage)");
        const id = `${args.slug}.${this.factory}`;
        this.factoryCompanies.set(args.slug, { company_id: id, founder: signer, name: args.name, preset: args.preset });
        this.companies.set(id, { id, founder: signer, name: args.name, preset: args.preset, frozen: false, dailyCap: BigInt(args.daily_cap), spentToday: 0n, codeKeyVersion: 0, version: 4, depts: [], grants: new Map(), invites: new Map(), pending: new Map() });
        this.balances.set(id, deposit);
        this.emit(logs, this.factory, "company_created", { company_id: id, founder: signer, name: args.name, preset: args.preset });
        return;
      }
      if (method === "claim_refund") throw new Error("nothing to refund");
      throw new Error(`MethodNotFound: ${method}`);
    }
    const c = this.companies.get(receiver);
    req(c, `UNKNOWN_ACCOUNT ${receiver}`);
    const co = c!;
    const founder = signer === co.founder;
    const oneYocto = () => req(deposit >= 1n, "1 yocto");
    switch (method) {
      case "create_department": {
        req(founder, "founder only");
        req(!co.frozen, "frozen");
        req(deposit >= (45n * ONE_NEAR) / 10n, "attach >= 4.5 NEAR for team storage + agent gas");
        const id = `${args.name}.${co.id}`;
        req(!co.depts.includes(id), "department exists");
        co.depts.push(id);
        this.depts.set(id, { id, name: args.name, company: co.id, budget: BigInt(args.budget), spent: 0n, reserved: 0n, perTx: BigInt(args.per_tx_limit), frozen: false, base: args.evm?.from ?? null, tasks: new Map(), agents: new Map() });
        this.emit(logs, co.id, "department_created", { company_id: co.id, department_id: id, name: args.name });
        return;
      }
      case "set_caps":
        req(founder, "founder only");
        oneYocto();
        co.dailyCap = BigInt(args.daily_cap);
        this.emit(logs, co.id, "policy_changed", { new_hash: `daily_cap:${args.daily_cap}` });
        return;
      case "invite":
        req(founder, "founder only");
        oneYocto();
        co.invites.set(args.invite_hash, { departments: args.departments, scopes: args.scopes, limit: args.limit, expires_at_ms: args.expires_at_ms });
        this.emit(logs, co.id, "member_invited", { company_id: co.id, invite_hash: args.invite_hash, departments: args.departments, scopes: args.scopes });
        return;
      case "accept_invite": {
        const h = createHash("sha256").update(String(args.code)).digest("hex");
        const inv = co.invites.get(h);
        req(inv, "invalid invite");
        req(Date.now() <= inv!.expires_at_ms, "invite expired");
        req(signer !== co.founder, "founder already owns the company");
        const name = inv!.departments[0];
        const dept = name && co.depts.includes(`${name}.${co.id}`) ? `${name}.${co.id}` : co.id;
        co.grants.set(signer, { account_id: signer, department_id: dept, scopes: inv!.scopes, limit: inv!.limit, expires_at_ms: inv!.expires_at_ms, revoked: false });
        co.invites.delete(h);
        this.emit(logs, co.id, "grant_set", { account_id: signer, department_id: dept, scopes: inv!.scopes, limit: inv!.limit, expires_at: inv!.expires_at_ms });
        return;
      }
      case "revoke": {
        req(founder, "founder only");
        oneYocto();
        const g = co.grants.get(args.account_id);
        if (g) g.revoked = true;
        this.emit(logs, co.id, "grant_revoked", { account_id: args.account_id, company_id: co.id });
        return;
      }
      case "register_view_key":
        this.emit(logs, co.id, "view_key_registered", { account_id: signer, x25519_public_key: args.x25519_public_key });
        return;
      case "rotate_code_key":
        req(founder, "founder only");
        oneYocto();
        co.codeKeyVersion = args.version;
        this.emit(logs, co.id, "code_key_rotated", { company_id: co.id, version: args.version });
        return;
      case "request_withdrawal": {
        // contracts/company/src/lib.rs: founder + 1 yocto, single-use id, then the Intents transfer; the
        // announcement comes from the callback, only when that transfer succeeded.
        req(founder, "founder only");
        oneYocto();
        if (co.version < 4) {
          // before version 4 the contract announced the request and moved nothing
          this.emit(logs, co.id, "withdrawal_requested", { company_id: co.id, withdrawal_id: args.withdrawal_id, amount: args.amount, token: args.token, to: args.to, chain: args.chain });
          return;
        }
        req(typeof args.withdrawal_id === "string" && args.withdrawal_id.length > 0 && args.withdrawal_id.length <= 64, "bad withdrawal id");
        req(/^\d+$/.test(String(args.amount)) && BigInt(args.amount) > 0n, "amount must be a positive integer");
        req(typeof args.token_id === "string" && args.token_id.startsWith("nep141:") && args.token_id.length > 7, "token_id must be a nep141 Intents token");
        const key = `${co.id}:${args.withdrawal_id}`;
        req(!this.withdrawalIds.has(key), "this withdrawal was already requested");
        req(args.route === "near" || args.route === "swap", "route must be near or swap");
        if (args.route === "swap") {
          req(args.deposit_address, "deposit_address is required for a swap");
          req(args.deposit_address !== co.id, "deposit_address can't be this company");
        }
        this.withdrawalIds.add(key);
        try {
          if (args.route === "near") this.ftWithdraw(co.id, String(args.token_id).slice("nep141:".length), args.to, BigInt(args.amount));
          else this.mtTransfer(co.id, args.deposit_address, args.token_id, BigInt(args.amount));
        } catch {
          // on_withdrawal_paid with a failed transfer: nothing left the company, the id is released
          this.withdrawalIds.delete(key);
          this.emit(logs, co.id, "withdrawal_failed", { company_id: co.id, withdrawal_id: args.withdrawal_id, amount: args.amount, reason: "intents_transfer_failed" });
          return;
        }
        this.emit(logs, co.id, "withdrawal_requested", { company_id: co.id, withdrawal_id: args.withdrawal_id, amount: args.amount, token: args.token, to: args.to, chain: args.chain, route: args.route, token_id: args.token_id, deposit_address: args.deposit_address ?? null, quote_id: args.quote_id ?? null, paid_to: args.route === "near" ? args.to : args.deposit_address });
        return;
      }
      case "record_withdrawal":
        req(signer === this.worker, "worker only");
        this.emit(logs, co.id, "withdrawal_recorded", { company_id: co.id, ...args });
        return;
      case "freeze":
        req(founder || this.has(co, signer, []), "founder or admin only");
        oneYocto();
        co.frozen = true;
        for (const id of co.depts) this.depts.get(id)!.frozen = true;
        this.emit(logs, co.id, "frozen", { company_id: co.id });
        return;
      case "unfreeze":
        req(founder, "founder only");
        oneYocto();
        co.frozen = false;
        for (const id of co.depts) this.depts.get(id)!.frozen = false;
        this.emit(logs, co.id, "unfrozen", { company_id: co.id });
        return;
      case "dept_call": {
        req(founder || this.has(co, signer, []), "founder or admin only");
        const calls: any[] = args.calls ?? [];
        req(calls.length >= 1 && calls.length <= 12, "1..=12 calls");
        req(deposit >= BigInt(calls.length), "attach 1 yocto per call");
        if (co.version < 2) req(calls.length === 1, "Returning joint promise is currently prohibited");
        for (const call of calls) {
          req(FORWARD.has(call.method), "method not allowed");
          if (co.version < 3) req(!UPGRADE_FREE.has(call.method), `${call.method} panicked: requires no deposit`);
          const id = `${call.department}.${co.id}`;
          const d = this.depts.get(id);
          req(d && co.depts.includes(id), "unknown department");
          this.deptCall(d!, call.method, call.args, logs);
        }
        return;
      }
      case "approve":
      case "reject": {
        oneYocto();
        req(founder || this.has(co, signer, ["approve"]), "approver only");
        req(method === "reject" || !co.frozen, "frozen");
        const ids: string[] = args.request_ids ?? [];
        req(ids.length >= 1 && ids.length <= 20, "1..=20 requests per call");
        const limit = this.teamLimit(co, signer);
        for (const rid of ids) {
          const p = co.pending.get(rid);
          req(p, "unknown request");
          if (limit) req(p!.department === limit, "your approve grant covers another team");
          co.pending.delete(rid);
          if (method === "approve") this.emit(logs, co.id, "purchase_approved", { request_id: rid, approvers: [signer], amount: p!.amount, card_id: args.card_id ?? null, department_id: p!.department });
          else this.emit(logs, co.id, "purchase_rejected", { request_id: rid, approvers: [signer], card_id: args.card_id ?? null, reason: "rejected_by_approver", department_id: p!.department });
        }
        return;
      }
      case "register_agent": {
        req(founder || this.has(co, signer, []), "founder or admin only");
        const id = `${args.department_name}.${co.id}`;
        const d = this.depts.get(id);
        req(d, "unknown department");
        d!.agents.set(args.public_key, args.role);
        this.emit(logs, id, "agent_registered", { department_id: id, public_key: args.public_key, role: args.role });
        return;
      }
      case "fire_agent": {
        req(founder || this.has(co, signer, []), "founder or admin only");
        const id = `${args.department_name}.${co.id}`;
        this.depts.get(id)?.agents.delete(args.public_key);
        this.emit(logs, id, "agent_fired", { department_id: id, public_key: args.public_key });
        return;
      }
      default:
        throw new Error(`MethodNotFound: ${method}`);
    }
  }

  private deptCall(d: Dept, method: string, args: any, logs: Array<{ executor: string; log: string }>) {
    switch (method) {
      case "assign_task":
        d.tasks.set(args.task_id, args);
        this.emit(logs, d.id, "task_assigned", { task_id: args.task_id, department_id: d.id, tier: args.tier, cap: args.cap });
        return;
      case "set_task_tier":
        this.emit(logs, d.id, "task_tier_set", { task_id: args.task_id, department_id: d.id, tier: args.tier });
        return;
      case "top_up_budget":
        d.budget += BigInt(args.amount);
        this.emit(logs, d.id, "budget_topped_up", { department_id: d.id, amount: args.amount, budget: d.budget.toString() });
        return;
      case "freeze":
        d.frozen = true;
        this.emit(logs, d.id, "frozen", { department_id: d.id, company_id: d.company });
        return;
      case "set_rail_float":
        this.emit(logs, d.id, "float_set", { department_id: d.id, rail: args.rail, target: args.target, enabled: args.enabled });
        return;
      case "allow_seller":
        if (args.pay_to) this.emit(logs, d.id, "seller_allowed", { department_id: d.id, seller_id: args.seller_id, pay_to: args.pay_to });
        else this.emit(logs, d.id, "seller_removed", { department_id: d.id, seller_id: args.seller_id });
        return;
      default:
        this.emit(logs, d.id, `${method}_done`, { department_id: d.id });
    }
  }

  /** Agent side: a signed payment (spend) — what payment_signed + receipt look like after a purchase. */
  agentPurchase(departmentId: string, p: { amount: string; model: string; seller: string; taskId: string }) {
    const d = this.depts.get(departmentId);
    if (!d) throw new Error("unknown department");
    const c = this.companies.get(d.company)!;
    if (d.frozen || c.frozen) throw new Error("frozen");
    const amount = BigInt(p.amount);
    if (d.spent + d.reserved + amount > d.budget) throw new Error("over budget");
    d.spent += amount;
    c.spentToday += amount;
    const rid = `req-${randomBytes(6).toString("hex")}`;
    const logs: Array<{ executor: string; log: string }> = [];
    this.emit(logs, d.id, "payment_signed", { request_id: rid, department_id: d.id, seller_id: p.seller, amount: p.amount, rail: "x402-evm", chain_id: "84532", token: "usdc", task_id: p.taskId, model: p.model, tier: "standard" });
    return this.agentTx(d.id, logs, rid);
  }

  /** Agent side: a purchase that needs approval (purchase_yielded + pending approval on the company). */
  agentYield(departmentId: string, p: { amount: string; reason: string; seller: string; taskId: string }) {
    const d = this.depts.get(departmentId)!;
    const c = this.companies.get(d.company)!;
    const rid = `req-${randomBytes(6).toString("hex")}`;
    c.pending.set(rid, { department: d.id, amount: p.amount, reason: p.reason });
    const logs: Array<{ executor: string; log: string }> = [];
    this.emit(logs, d.id, "purchase_requested", { request_id: rid, department_id: d.id, task_id: p.taskId, seller_id: p.seller, rail: "x402-evm", amount: p.amount, challenge_hash: rid });
    this.emit(logs, c.id, "purchase_yielded", { request_id: rid, reason: p.reason, company_id: c.id, department_id: d.id, amount: p.amount, seller_id: p.seller });
    return this.agentTx(d.id, logs, rid);
  }

  /** Agent side: a purchase the contract blocked (payee mismatch). */
  agentBlocked(departmentId: string, seller: string) {
    const d = this.depts.get(departmentId)!;
    const logs: Array<{ executor: string; log: string }> = [];
    const rid = `req-${randomBytes(6).toString("hex")}`;
    this.emit(logs, d.id, "purchase_rejected", { request_id: rid, department_id: d.id, seller_id: seller, reason: "payee_mismatch", blocked: true });
    return this.agentTx(d.id, logs, rid);
  }

  private agentTx(signer: string, logs: Array<{ executor: string; log: string }>, requestId: string) {
    const hash = bs58.encode(randomBytes(32));
    this.height += 1;
    const status = {
      status: { SuccessValue: "" },
      transaction: { hash, signer_id: signer, receiver_id: signer },
      receipts_outcome: logs.map((l) => ({ id: bs58.encode(randomBytes(32)), outcome: { executor_id: l.executor, logs: [l.log], status: { SuccessValue: "" } } })),
    };
    this.txs.set(hash, status);
    this.log.push({ hash, signer, height: this.height, status });
    return { hash, height: this.height, status, requestId };
  }

  // ---------------- HTTP ----------------
  rpc(method: string, params: any): any {
    this.calls++;
    if (method === "query") {
      if (params.request_type === "call_function") {
        if (this.failNextView && params.method_name === this.failNextView) {
          this.failNextView = null;
          throw Object.assign(new Error("TIMEOUT"), { retryable: true });
        }
        const args = params.args_base64 ? JSON.parse(Buffer.from(params.args_base64, "base64").toString() || "{}") : {};
        if (!this.exists(params.account_id) && params.account_id !== this.mpc && params.account_id !== this.registry) throw new Error("UNKNOWN_ACCOUNT");
        const out = this.view(params.account_id, params.method_name, args);
        return { result: [...Buffer.from(JSON.stringify(out ?? null))], block_height: this.height, logs: [] };
      }
      if (params.request_type === "view_account") {
        if (!this.balances.has(params.account_id)) throw new Error("UNKNOWN_ACCOUNT");
        return { amount: this.balances.get(params.account_id)!.toString(), locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 100, block_height: this.height };
      }
      if (params.request_type === "view_access_key_list") {
        const keys = [...(this.fullKeys.get(params.account_id) ?? [])].map((k) => ({ public_key: k, access_key: { nonce: 1, permission: "FullAccess" } }));
        return { keys, block_height: this.height };
      }
    }
    if (method === "EXPERIMENTAL_tx_status" || method === "tx") {
      const t = this.txs.get(params.tx_hash ?? params[0]);
      if (!t) throw new Error("UNKNOWN_TRANSACTION");
      return t;
    }
    if (method === "block") return { header: { height: this.height, hash: "sim", timestamp: Date.now() * 1e6 }, chunks: [] };
    if (method === "eth_call") return "0x0";
    throw new Error(`MethodNotFound ${method}`);
  }

  listen(port = 0): Promise<{ url: string; close: () => void }> {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const reply = (code: number, obj: unknown) => {
          res.writeHead(code, { "content-type": "application/json" });
          res.end(JSON.stringify(obj));
        };
        try {
          const j = body ? JSON.parse(body) : {};
          if (req.url === "/sim/send") return reply(200, this.send(j.signerId, j.publicKey, j.signature, j.tx));
          if (req.url === "/sim/agent/purchase") return reply(200, this.agentPurchase(j.departmentId, j));
          if (req.url === "/sim/agent/yield") return reply(200, this.agentYield(j.departmentId, j));
          if (req.url === "/sim/agent/blocked") return reply(200, this.agentBlocked(j.departmentId, j.seller));
          try {
            reply(200, { jsonrpc: "2.0", id: j.id, result: this.rpc(j.method, j.params) });
          } catch (e: any) {
            reply(200, { jsonrpc: "2.0", id: j.id, error: { message: e.message, cause: { name: e.message.split(" ")[0] } } });
          }
        } catch (e: any) {
          reply(400, { error: e?.message ?? String(e) });
        }
      });
    });
    return new Promise((resolve) =>
      server.listen(port, "127.0.0.1", () => {
        const a = server.address() as any;
        resolve({ url: `http://127.0.0.1:${a.port}`, close: () => server.close() });
      }),
    );
  }
}

import type { UnsignedTx } from "@builderos/shared";
import { network } from "@builderos/shared";
import { view } from "./rpc.js";
import { CREATE_COMPANY_DEPOSIT_YOCTO, CREATE_DEPARTMENT_DEPOSIT_YOCTO } from "./funding.js";

/**
 * Single source of truth for contract method names and argument shapes.
 * Align these with "BuilderOS — Build Architecture" (contracts) if any name differs.
 */

export const TGAS = 10n ** 12n;
const gas = (tgas: number) => (BigInt(tgas) * TGAS).toString();
const ONE_YOCTO = "1";

function call(receiverId: string, methodName: string, args: Record<string, unknown>, tgas = 50, deposit = "0"): UnsignedTx {
  return { receiverId, actions: [{ type: "FunctionCall", params: { methodName, args, gas: gas(tgas), deposit } }] };
}

// Account naming: <slug>.<factory> for a company, <dept>.<company> for a department.
export const companyAccount = (slug: string) => `${slug}.${network().factory}`;
/**
 * One spelling for a company everywhere: "demo", "DEMO" and "demo.<factory>" all become "demo.<factory>".
 * Anything that already has a dot (a full account id) is only lower-cased.
 */
export function normalizeCompanyId(v: string): string {
  const s = String(v ?? "").trim().toLowerCase();
  return /^[a-z0-9-]{2,32}$/.test(s) ? companyAccount(s) : s;
}
/** "demo.<factory>" → "demo" (the short form used in web URLs). */
export const companySlug = (companyId: string) => companyId.replace(new RegExp(`\\.${network().factory.replace(/\./g, "\\.")}$`), "");
export const departmentAccount = (companyId: string, dept: string) => `${dept}.${companyId}`;
/** `build.acme.factory` → { name: "build", companyId: "acme.factory" } */
export function splitDepartment(departmentId: string) {
  const i = departmentId.indexOf(".");
  if (i <= 0) throw new Error(`not a department account: ${departmentId}`);
  return { name: departmentId.slice(0, i), companyId: departmentId.slice(i + 1) };
}

/** Department account prefix rules (also a valid NEAR sub-account label). */
export const DEPARTMENT_NAME_RE = /^[a-z0-9](?:[a-z0-9_-]{0,18}[a-z0-9])?$/;

export type DeptCall = {
  department: string;
  method: "assign_task" | "set_task_tier" | "set_task_hire" | "set_rail_float" | "allow_seller" | "set_evm_config" | "top_up_budget" | "freeze";
  args: Record<string, unknown>;
};

/** Team payment settings passed to create_department (its Chain Signatures Base address + USDC). */
export type EvmConfig = { chain_id: number; usdc: string; from: string };
export const APPROVALS_PER_TX = 20;
export const DEPT_CALLS_PER_TX = 12;

/**
 * Departments only accept policy changes from their company contract, so founder/admin changes go
 * through `company.dept_call`, which checks the caller's grant on chain before forwarding.
 */
function deptCall(companyId: string, calls: DeptCall[]): UnsignedTx {
  if (!calls.length || calls.length > DEPT_CALLS_PER_TX) throw new Error(`1..${DEPT_CALLS_PER_TX} department calls per transaction`);
  return call(companyId, "dept_call", { calls }, Math.min(300, 20 + 16 * calls.length), String(calls.length));
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

type TaskAssign = { taskId: string; tier: string; cap: string; tag: string; agentRole: string; dependsOn: string[] };

/** One assign_task call (batch them with `deptCalls`). */
function assignTaskCall(departmentId: string, t: TaskAssign): DeptCall {
  return {
    department: splitDepartment(departmentId).name,
    method: "assign_task",
    args: { task_id: t.taskId, tier: t.tier, cap: t.cap, tag: t.tag, role: t.agentRole, depends_on: t.dependsOn },
  };
}

/** Batch department calls for one company into as few transactions as possible. */
/**
 * `perTx` = 1 for companies on code older than contract_version 2: their dept_call/approve/freeze return a
 * joint promise when given several calls, which NEAR refuses ("Returning joint promise is currently prohibited").
 * One call per tx returns a plain promise and works on every version.
 */
function deptCalls(companyId: string, calls: DeptCall[], perTx = DEPT_CALLS_PER_TX): UnsignedTx[] {
  const n = Math.max(1, Math.min(perTx, DEPT_CALLS_PER_TX));
  return chunks(calls, n).map((c) => deptCall(companyId, c));
}

// ---------------- transactions a person signs in the browser ----------------

export const tx = {
  createCompany: (a: { slug: string; name: string; preset: string; dailyCap: string; presetHash?: string }) =>
    // company.wasm ≈ 6.7 NEAR storage — factory requires ≥ 7.5 NEAR attached.
    call(network().factory, "create_company", { slug: a.slug, name: a.name, preset: a.preset, daily_cap: a.dailyCap, preset_hash: a.presetHash ?? null }, 300, CREATE_COMPANY_DEPOSIT_YOCTO.toString()),

  createDepartment: (companyId: string, d: { name: string; budget: string; perTxLimit: string; evm?: EvmConfig | null }) =>
    // department.wasm ≈ 3.4 NEAR storage + agent gas — company requires ≥ 4.5 NEAR attached.
    call(companyId, "create_department", { name: d.name, budget: d.budget, per_tx_limit: d.perTxLimit, evm: d.evm ?? null }, 200, CREATE_DEPARTMENT_DEPOSIT_YOCTO.toString()),

  setCaps: (companyId: string, a: { dailyCap: string }) => call(companyId, "set_caps", { daily_cap: a.dailyCap }, 30, ONE_YOCTO),

  assignTaskCall,
  deptCalls,

  assignTask: (departmentId: string, t: TaskAssign) => deptCall(splitDepartment(departmentId).companyId, [assignTaskCall(departmentId, t)]),

  setTaskTier: (departmentId: string, taskId: string, tier: string, pinnedModel: string | null) => {
    const { name, companyId } = splitDepartment(departmentId);
    return deptCall(companyId, [{ department: name, method: "set_task_tier", args: { task_id: taskId, tier, pinned_model: pinnedModel } }]);
  },

  /** Founder/admin: pin a hireable agent (or clear) for a niche task before the swarm runs. */
  setTaskHire: (departmentId: string, taskId: string, agentId: string | null) => {
    const { name, companyId } = splitDepartment(departmentId);
    return deptCall(companyId, [{ department: name, method: "set_task_hire", args: { task_id: taskId, agent_id: agentId } }]);
  },

  /** Approve waiting purchases; each tells its team to let the agent get the Chain Signatures signature. ≤20 per tx. */
  approve: (companyId: string, requestIds: string[], cardId?: string, perTx = APPROVALS_PER_TX): UnsignedTx[] =>
    chunks(requestIds, Math.max(1, Math.min(perTx, APPROVALS_PER_TX))).map((ids) => call(companyId, "approve", { request_ids: ids, card_id: cardId ?? null }, Math.min(300, 20 + 12 * ids.length), ONE_YOCTO)),
  reject: (companyId: string, requestIds: string[], cardId?: string, perTx = APPROVALS_PER_TX): UnsignedTx[] =>
    chunks(requestIds, Math.max(1, Math.min(perTx, APPROVALS_PER_TX))).map((ids) => call(companyId, "reject", { request_ids: ids, card_id: cardId ?? null }, Math.min(300, 20 + 12 * ids.length), ONE_YOCTO)),

  /** Founder/admin: allow-list a seller and the only address it may be paid at (null removes it). */
  allowSeller: (departmentId: string, sellerId: string, payTo: string | null) => {
    const { name, companyId } = splitDepartment(departmentId);
    return deptCall(companyId, [{ department: name, method: "allow_seller", args: { seller_id: sellerId, pay_to: payTo } }]);
  },
  /** Founder/admin: set a team's Base chain, USDC and Chain Signatures address. */
  setEvmConfig: (departmentId: string, evm: EvmConfig) => {
    const { name, companyId } = splitDepartment(departmentId);
    return deptCall(companyId, [{ department: name, method: "set_evm_config", args: { chain_id: evm.chain_id, usdc: evm.usdc, from: evm.from } }]);
  },

  invite: (companyId: string, a: { inviteHash: string; departments: string[]; scopes: string[]; limit: string | null; expiresAtMs: number }) =>
    call(companyId, "invite", { invite_hash: a.inviteHash, departments: a.departments, scopes: a.scopes, limit: a.limit, expires_at_ms: a.expiresAtMs }, 50, ONE_YOCTO),
  acceptInvite: (companyId: string, code: string) => call(companyId, "accept_invite", { code }, 50),
  revoke: (companyId: string, account: string) => call(companyId, "revoke", { account_id: account }, 50, ONE_YOCTO),
  registerViewKey: (companyId: string, x25519PublicKey: string) => call(companyId, "register_view_key", { x25519_public_key: x25519PublicKey }, 30),

  setRailFloat: (departmentId: string, rail: string, target: string, enabled: boolean) => {
    const { name, companyId } = splitDepartment(departmentId);
    return deptCall(companyId, [{ department: name, method: "set_rail_float", args: { rail, target, enabled } }]);
  },

  /**
   * Founder withdrawal from the company's NEAR Intents balance. The contract moves the funds in this same
   * transaction (route "near": ft_withdraw to `to`; route "swap": mt_transfer to the 1Click deposit address)
   * and announces the withdrawal only after that transfer succeeded. Needs company contract_version ≥ 4.
   */
  requestWithdrawal: (
    companyId: string,
    a: { withdrawalId: string; amount: string; token: string; to: string; chain: string; route: "near" | "swap"; tokenId: string; depositAddress?: string | null; quoteId?: string | null },
  ) =>
    call(
      companyId,
      "request_withdrawal",
      { withdrawal_id: a.withdrawalId, amount: a.amount, token: a.token, to: a.to, chain: a.chain, route: a.route, token_id: a.tokenId, deposit_address: a.depositAddress ?? null, quote_id: a.quoteId ?? null },
      100,
      ONE_YOCTO,
    ),

  rotateCodeKey: (companyId: string, newVersion: number) => call(companyId, "rotate_code_key", { version: newVersion }, 30, ONE_YOCTO),

  /** Pause all spending: freezes the company and every department (cascade on chain). Founder or admin. */
  freeze: (companyId: string) => call(companyId, "freeze", {}, 150, ONE_YOCTO),
  /** Pause selected teams only. Founder or admin. */
  freezeDepartments: (companyId: string, departmentIds: string[], perTx = DEPT_CALLS_PER_TX) =>
    deptCalls(
      companyId,
      departmentIds.map((d) => ({ department: splitDepartment(d).name, method: "freeze" as const, args: {} })),
      perTx,
    ),
  /** Resume: company + every department. Founder only. */
  unfreeze: (companyId: string) => call(companyId, "unfreeze", {}, 150, ONE_YOCTO),

  /** Founder/admin: the team adds an agent key limited to request_purchase/record_response/create_bounty. */
  registerAgent: (departmentId: string, publicKey: string, role: string) => {
    const { name, companyId } = splitDepartment(departmentId);
    return call(companyId, "register_agent", { department_name: name, public_key: publicKey, role }, 60);
  },
  /** Founder/admin: "Fire" — the team deletes the agent's key. */
  fireAgent: (departmentId: string, publicKey: string) => {
    const { name, companyId } = splitDepartment(departmentId);
    return call(companyId, "fire_agent", { department_name: name, public_key: publicKey }, 60);
  },

  /** Pull a create-company refund the factory couldn't pay inside the failed-create callback. */
  claimRefund: () => call(network().factory, "claim_refund", {}, 30),
};

// ---------------- calls made by service keys (request/record only) ----------------

export const serviceCalls = {
  requestPurchase: (departmentId: string, a: { sellerId: string; rail: string; amount: string; challengeHash: string; taskId: string; model?: string | null; payload?: unknown }) => ({
    contractId: departmentId,
    methodName: "request_purchase",
    args: { seller_id: a.sellerId, rail: a.rail, amount: a.amount, challenge_hash: a.challengeHash, task_id: a.taskId, model: a.model ?? null, payload: a.payload ?? null },
    gas: 300n * TGAS,
  }),
  /** Agent: after an approval card is approved, get the Chain Signatures signature. */
  signApproved: (departmentId: string, requestId: string) => ({
    contractId: departmentId,
    methodName: "sign_approved",
    args: { request_id: requestId },
    gas: 120n * TGAS,
  }),
  /** Agent: drop a waiting request (frees the reserved budget). */
  cancelRequest: (departmentId: string, requestId: string) => ({
    contractId: departmentId,
    methodName: "cancel_request",
    args: { request_id: requestId },
    gas: 20n * TGAS,
  }),
  recordResponse: (departmentId: string, a: { requestId: string; responseHash: string; foreignTx: string | null; outcome: string }) => ({
    contractId: departmentId,
    methodName: "record_response",
    args: { request_id: a.requestId, response_hash: a.responseHash, foreign_tx: a.foreignTx, outcome: a.outcome },
    gas: 30n * TGAS,
  }),
  requestRailTopup: (departmentId: string, a: { jobId: string; amount: string; rail: string }) => ({
    contractId: departmentId,
    methodName: "request_rail_topup",
    args: { job_id: a.jobId, amount: a.amount, rail: a.rail },
    gas: 100n * TGAS,
  }),
  recordTopup: (departmentId: string, a: Record<string, unknown>) => ({ contractId: departmentId, methodName: "record_topup", args: a, gas: 30n * TGAS }),
  recordWithdrawal: (companyId: string, a: Record<string, unknown>) => ({ contractId: companyId, methodName: "record_withdrawal", args: a, gas: 30n * TGAS }),
  submitVerdict: (departmentId: string, a: { taskId: string; verdict: "pass" | "fail"; logHash: string; bountyId?: string | null }) => ({
    contractId: departmentId,
    methodName: "submit_verdict",
    args: { task_id: a.taskId, verdict: a.verdict, log_hash: a.logHash, bounty_id: a.bountyId ?? null },
    gas: 50n * TGAS,
  }),
  /**
   * Reserve exact hire payment (pay-on-green). Amount/currency/rail/payee must match the
   * hired agent's quoted service cost. Released only after the hiring agent verifies pass
   * and the verifier key submits the verdict.
   */
  createBounty: (
    departmentId: string,
    a: {
      bountyId: string;
      taskId: string;
      agentId: string;
      payee: string;
      amount: string;
      currency: string;
      rail: string;
      hiringRole: string;
      quoteHash: string;
    },
  ) => ({
    contractId: departmentId,
    methodName: "create_bounty",
    args: {
      bounty_id: a.bountyId,
      task_id: a.taskId,
      agent_id: a.agentId,
      payee: a.payee,
      amount: a.amount,
      currency: a.currency,
      token: a.currency,
      rail: a.rail,
      hiring_role: a.hiringRole,
      quote_hash: a.quoteHash,
    },
    gas: 80n * TGAS,
  }),
};

// ---------------- views (the chain decides) ----------------

/** Department purchase request as stored on chain. `authorization` / `signature` are JSON strings. */
export type PurchaseRequestView = {
  request_id: string;
  seller_id: string;
  rail: string;
  amount: string;
  challenge_hash: string;
  task_id: string;
  model: string | null;
  status: "checking" | "pending" | "approved" | "signed" | "settled" | "rejected" | "cancelled";
  reason: string | null;
  pay_to: string;
  authorization: string | null;
  signature: string | null;
};

export type Grant = {
  account_id: string;
  department_id: string;
  scopes: string[]; // e.g. ["view","approve","code","admin"]
  limit: string | null;
  expires_at_ms: number | null;
  revoked: boolean;
};

const versionCache = new Map<string, { v: number; at: number }>();
/** contract_version of a company (0 = older code without the method). Cached for 5 minutes. */
async function companyVersion(companyId: string): Promise<number> {
  const hit = versionCache.get(companyId);
  if (hit && Date.now() - hit.at < 300_000) return hit.v;
  const v = await view<number>(companyId, "contract_version", {}).then(Number).catch(() => 0);
  versionCache.set(companyId, { v, at: Date.now() });
  return v;
}
/** Drop the cached contract_version (after an upgrade is applied, and in tests). */
export const forgetCompanyVersion = (companyId?: string) => (companyId ? versionCache.delete(companyId) : versionCache.clear());
/** How many calls one tx may carry for this company (1 on legacy code, see deptCalls). */
export async function batchLimits(companyId: string) {
  const version = await companyVersion(companyId);
  const ok = version >= 2;
  return {
    version,
    legacy: !ok,
    deptCallsPerTx: ok ? DEPT_CALLS_PER_TX : 1,
    approvalsPerTx: ok ? APPROVALS_PER_TX : 1,
    /** allow_seller / set_evm_config / top_up_budget only work through dept_call from version 3. */
    zeroDepositForwarding: version >= 3,
    /** request_withdrawal moves Intents funds itself from version 4; before that it only emitted an event. */
    intentsWithdrawals: version >= 4,
  };
}

export { companyVersion };

export const views = {
  getGrant: (target: string, account: string) => view<Grant | null>(target, "get_grant", { account_id: account }),
  getDepartments: (companyId: string) => view<Array<{ name: string; department_id: string }>>(companyId, "get_departments"),
  getFactoryCompany: (slug: string) => view<{ company_id: string; founder: string; name: string; preset: string } | null>(network().factory, "get_company", { slug }),
  getPendingRefund: (account: string) => view<string>(network().factory, "get_pending_refund", { account_id: account }),
  getCompany: (companyId: string) => view<{ founder: string; name: string; frozen: boolean; code_key_version: number; daily_cap: string; spent_today: string } | null>(companyId, "get_company"),
  getDepartment: (departmentId: string) =>
    view<{ budget: string; spent: string; reserved?: string; per_tx_limit: string; frozen: boolean; base_address?: string | null; evm_chain_id?: number; evm_usdc?: string | null } | null>(departmentId, "get_department"),
  getRequest: (departmentId: string, requestId: string) => view<PurchaseRequestView | null>(departmentId, "get_request", { request_id: requestId }),
  getRequestByChallenge: (departmentId: string, challengeHash: string) =>
    view<PurchaseRequestView | null>(departmentId, "get_request_by_challenge", { challenge_hash: challengeHash }),
  getPendingApproval: (companyId: string, requestId: string) => view<{ department: string; amount: string; reason: string } | null>(companyId, "get_pending_approval", { request_id: requestId }),
  getSeller: (sellerId: string) => view<any>(network().registry, "get_seller", { seller_id: sellerId }),
  listSellers: (service: string) => view<any[]>(network().registry, "list_sellers", { service }),
  getModelsHash: () => view<string>(network().registry, "get_models_hash"),
  /** Hireable niche agents (registry service, typically "expertise"). */
  getHireableAgent: (agentId: string) => view<HireableAgentView | null>(network().registry, "get_hireable_agent", { agent_id: agentId }),
  listHireableAgents: (service = "expertise") => view<HireableAgentView[]>(network().registry, "list_hireable_agents", { service }),
  getBounty: (departmentId: string, bountyId: string) =>
    view<{
      bounty_id: string;
      task_id: string;
      payee: string;
      amount: string;
      currency: string;
      rail: string;
      agent_id: string;
      status: string;
    } | null>(departmentId, "get_bounty", { bounty_id: bountyId }),
};

export type HireableAgentView = {
  agent_id: string;
  service: string;
  description: string;
  skills: string[];
  rating: number;
  rail: string;
  pay_to: string;
  endpoint: string;
  currency: string;
  price: string;
  quality_note?: string | null;
};

/** Founder check, read from chain (never from cache). */
export async function isFounder(companyId: string, account: string) {
  const c = await views.getCompany(normalizeCompanyId(companyId)).catch(() => null);
  return c?.founder === account;
}

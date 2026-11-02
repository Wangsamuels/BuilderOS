import type { UnsignedTx } from "@builderos/shared";
import { network } from "@builderos/shared";
import { view } from "./rpc.js";

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
export const departmentAccount = (companyId: string, dept: string) => `${dept}.${companyId}`;

// ---------------- transactions a person signs in the browser ----------------

export const tx = {
  createCompany: (a: { slug: string; name: string; preset: string; dailyCap: string; presetHash?: string }) =>
    // Storage for the company + department sub-accounts is paid by the founder.
    call(network().factory, "create_company", { slug: a.slug, name: a.name, preset: a.preset, daily_cap: a.dailyCap, preset_hash: a.presetHash ?? null }, 300, "5000000000000000000000000"),

  createDepartment: (companyId: string, d: { name: string; budget: string; perTxLimit: string }) =>
    call(companyId, "create_department", { name: d.name, budget: d.budget, per_tx_limit: d.perTxLimit }, 200, "3000000000000000000000000"),

  setCaps: (companyId: string, a: { dailyCap: string }) => call(companyId, "set_caps", { daily_cap: a.dailyCap }, 30, ONE_YOCTO),

  assignTask: (departmentId: string, t: { taskId: string; tier: string; cap: string; tag: string; agentRole: string; dependsOn: string[] }) =>
    call(departmentId, "assign_task", { task_id: t.taskId, tier: t.tier, cap: t.cap, tag: t.tag, role: t.agentRole, depends_on: t.dependsOn }, 30, ONE_YOCTO),

  setTaskTier: (departmentId: string, taskId: string, tier: string, pinnedModel: string | null) =>
    call(departmentId, "set_task_tier", { task_id: taskId, tier, pinned_model: pinnedModel }, 30, ONE_YOCTO),

  approve: (companyId: string, requestIds: string[], cardId?: string) => call(companyId, "approve", { request_ids: requestIds, card_id: cardId ?? null }, 100, ONE_YOCTO),
  reject: (companyId: string, requestIds: string[], cardId?: string) => call(companyId, "reject", { request_ids: requestIds, card_id: cardId ?? null }, 50, ONE_YOCTO),

  invite: (companyId: string, a: { inviteHash: string; departments: string[]; scopes: string[]; limit: string | null; expiresAtMs: number }) =>
    call(companyId, "invite", { invite_hash: a.inviteHash, departments: a.departments, scopes: a.scopes, limit: a.limit, expires_at_ms: a.expiresAtMs }, 50, ONE_YOCTO),
  acceptInvite: (companyId: string, code: string) => call(companyId, "accept_invite", { code }, 50),
  revoke: (companyId: string, account: string) => call(companyId, "revoke", { account_id: account }, 50, ONE_YOCTO),
  registerViewKey: (companyId: string, x25519PublicKey: string) => call(companyId, "register_view_key", { x25519_public_key: x25519PublicKey }, 30),

  setRailFloat: (departmentId: string, rail: string, target: string, enabled: boolean) =>
    call(departmentId, "set_rail_float", { rail, target, enabled }, 30, ONE_YOCTO),

  requestWithdrawal: (companyId: string, a: { withdrawalId: string; amount: string; token: string; to: string; chain: string }) =>
    call(companyId, "request_withdrawal", { withdrawal_id: a.withdrawalId, amount: a.amount, token: a.token, to: a.to, chain: a.chain }, 50, ONE_YOCTO),

  rotateCodeKey: (companyId: string, newVersion: number) => call(companyId, "rotate_code_key", { version: newVersion }, 30, ONE_YOCTO),

  freeze: (target: string) => call(target, "freeze", {}, 30, ONE_YOCTO),
  unfreeze: (target: string) => call(target, "unfreeze", {}, 30, ONE_YOCTO),
};

// ---------------- calls made by service keys (request/record only) ----------------

export const serviceCalls = {
  requestPurchase: (departmentId: string, a: { sellerId: string; rail: string; amount: string; challengeHash: string; taskId: string; model?: string | null; payload?: unknown }) => ({
    contractId: departmentId,
    methodName: "request_purchase",
    args: { seller_id: a.sellerId, rail: a.rail, amount: a.amount, challenge_hash: a.challengeHash, task_id: a.taskId, model: a.model ?? null, payload: a.payload ?? null },
    gas: 300n * TGAS,
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
  submitVerdict: (departmentId: string, a: { taskId: string; verdict: "pass" | "fail"; logHash: string }) => ({
    contractId: departmentId,
    methodName: "submit_verdict",
    args: { task_id: a.taskId, verdict: a.verdict, log_hash: a.logHash },
    gas: 50n * TGAS,
  }),
};

// ---------------- views (the chain decides) ----------------

export type Grant = {
  account_id: string;
  department_id: string;
  scopes: string[]; // e.g. ["view","approve","code","admin"]
  limit: string | null;
  expires_at_ms: number | null;
  revoked: boolean;
};

export const views = {
  getGrant: (target: string, account: string) => view<Grant | null>(target, "get_grant", { account_id: account }),
  getCompany: (companyId: string) => view<{ founder: string; name: string; frozen: boolean; code_key_version: number; daily_cap: string; spent_today: string } | null>(companyId, "get_company"),
  getDepartment: (departmentId: string) => view<{ budget: string; spent: string; per_tx_limit: string; frozen: boolean; base_address?: string } | null>(departmentId, "get_department"),
  getRequest: (departmentId: string, requestId: string) => view<any>(departmentId, "get_request", { request_id: requestId }),
  getSeller: (sellerId: string) => view<any>(network().registry, "get_seller", { seller_id: sellerId }),
  listSellers: (service: string) => view<any[]>(network().registry, "list_sellers", { service }),
  getModelsHash: () => view<string>(network().registry, "get_models_hash"),
};

/** Founder check, read from chain (never from cache). */
export async function isFounder(companyId: string, account: string) {
  const c = await views.getCompany(companyId).catch(() => null);
  return c?.founder === account;
}

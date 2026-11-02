import type { EventName, ReceiptKind } from "@builderos/shared";

export type ReceiptDraft = {
  kind: ReceiptKind;
  actor?: string | null;
  amount?: string | null;
  token?: string | null;
  rail?: string | null;
  chainId?: string | null;
  foreignTx?: string | null;
  requestId?: string | null;
  payload: Record<string, unknown>;
};

const s = (v: unknown) => (v == null ? null : String(v));

/** Pure mapping from one contract event to a receipt row (or null for cache-only events). */
export function buildReceipt(event: EventName, d: Record<string, any>, signer: string | null): ReceiptDraft | null {
  switch (event) {
    case "payment_signed":
      return {
        kind: "purchase",
        actor: signer,
        amount: s(d.amount),
        token: s(d.token) ?? "usdc",
        rail: s(d.rail),
        chainId: s(d.chain_id),
        requestId: s(d.request_id),
        payload: { seller: d.seller_id, task: d.task_id, model: d.model, tier: d.tier, stage: "signed" },
      };
    case "receipt":
      return {
        kind: "purchase",
        actor: signer,
        requestId: s(d.request_id),
        foreignTx: s(d.foreign_tx),
        payload: { response_hash: d.response_hash, outcome: d.outcome, stage: "settled" },
      };
    case "purchase_approved":
    case "purchase_rejected":
      return {
        kind: event === "purchase_approved" ? "approval" : "rejection",
        actor: signer,
        amount: s(d.amount),
        requestId: s(d.request_id),
        payload: { approvers: d.approvers ?? [signer], card: d.card_id },
      };
    case "topup_recorded":
      return {
        kind: "topup",
        actor: signer,
        amount: s(d.amount_in),
        token: s(d.token) ?? "usdc",
        rail: "tempo",
        foreignTx: s(d.dest_tx ?? d.origin_tx),
        payload: { amount_in: d.amount_in, amount_out: d.amount_out, fees: d.fees, quote_id: d.quote_id, origin_tx: d.origin_tx, dest_tx: d.dest_tx, job_id: d.job_id },
      };
    case "withdrawal_recorded":
      return {
        kind: "withdrawal",
        actor: signer,
        amount: s(d.amount_out),
        token: s(d.token),
        foreignTx: s(d.dest_tx),
        payload: { amount_in: d.amount_in, amount_out: d.amount_out, fees: d.fees, quote_id: d.quote_id, origin_tx: d.origin_tx, dest_tx: d.dest_tx, withdrawal_id: d.withdrawal_id },
      };
    case "deposit":
      return { kind: "deposit", actor: s(d.payer), amount: s(d.amount), token: s(d.token), payload: { payer: d.payer } };
    case "revenue":
      return { kind: "revenue", actor: s(d.payer), amount: s(d.amount), token: s(d.token), foreignTx: s(d.foreign_tx), payload: { payer: d.payer } };
    case "bounty_released":
    case "bounty_voided":
      return {
        kind: "bounty",
        actor: signer,
        amount: s(d.amount),
        payload: { task: d.task_id, payee: d.payee, verdict: d.verdict ?? (event === "bounty_voided" ? "fail" : "pass"), log_hash: d.log_hash, voided: event === "bounty_voided" },
      };
    case "member_invited":
    case "grant_set":
    case "grant_revoked":
      return { kind: "membership", actor: signer, payload: { event, ...d } };
    case "code_key_rotated":
    case "policy_changed":
    case "frozen":
    case "unfrozen":
      return { kind: "keys_policy", actor: signer, payload: { event, ...d } };
    default:
      return { kind: "other", actor: signer, payload: { event, ...d } };
  }
}

/** Work out company / department from the emitting contract's account (dept.company.factory). */
export function scopeOf(contract: string, factory: string): { companyId: string | null; departmentId: string | null } {
  if (contract === factory || !contract.endsWith(`.${factory}`)) return { companyId: null, departmentId: null };
  const parts = contract.slice(0, -(factory.length + 1)).split(".");
  if (parts.length === 1) return { companyId: contract, departmentId: null };
  const company = `${parts[parts.length - 1]}.${factory}`;
  return { companyId: company, departmentId: contract };
}

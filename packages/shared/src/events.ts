import { z } from "zod";

/** NEP-297 envelope emitted by every BuilderOS contract as `EVENT_JSON:{...}`. */
export const EVENT_STANDARD = "builderos";
export const EVENT_VERSION = "1.0.0";

export const EventEnvelope = z.object({
  standard: z.literal(EVENT_STANDARD),
  version: z.string(),
  event: z.string(),
  data: z.array(z.record(z.string(), z.unknown())).or(z.record(z.string(), z.unknown())),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

const amount = z.union([z.string(), z.number()]).transform(String);
const opt = <T extends z.ZodTypeAny>(t: T) => t.optional().nullable();

/**
 * Per-event payload schemas. Keys are loose (passthrough) so a new contract field
 * never drops an event into dead letters; only the fields receipts need are required.
 */
export const EventSchemas = {
  company_created: z.looseObject({ company_id: z.string(), founder: z.string(), name: opt(z.string()), preset: opt(z.string()) }),
  department_created: z.looseObject({ company_id: z.string(), department_id: z.string(), name: opt(z.string()), contract_hash: opt(z.string()) }),
  agent_registered: z.looseObject({ department_id: z.string(), public_key: z.string(), role: z.string(), max_tier: opt(z.string()) }),
  task_assigned: z.looseObject({ task_id: z.string(), department_id: opt(z.string()), tier: opt(z.string()), cap: opt(amount) }),

  purchase_requested: z.looseObject({ request_id: z.string(), task_id: opt(z.string()), seller_id: z.string(), rail: z.string(), amount, challenge_hash: z.string() }),
  purchase_yielded: z.looseObject({ request_id: z.string(), reason: z.string(), company_id: opt(z.string()) }),
  purchase_approved: z.looseObject({ request_id: z.string(), approvers: opt(z.array(z.string())), amount: opt(amount), card_id: opt(z.string()) }),
  purchase_rejected: z.looseObject({ request_id: z.string(), approvers: opt(z.array(z.string())), amount: opt(amount), card_id: opt(z.string()) }),
  payment_signed: z.looseObject({ request_id: z.string(), seller_id: z.string(), rail: z.string(), chain_id: opt(z.union([z.string(), z.number()])), amount, task_id: opt(z.string()), model: opt(z.string()), tier: opt(z.string()) }),
  receipt: z.looseObject({ request_id: z.string(), response_hash: opt(z.string()), foreign_tx: opt(z.string()), outcome: opt(z.string()) }),

  topup_requested: z.looseObject({ department_id: z.string(), amount, job_id: z.string() }),
  topup_recorded: z.looseObject({ department_id: z.string(), job_id: z.string(), amount_in: amount, amount_out: amount, fees: opt(amount), quote_id: opt(z.string()), origin_tx: opt(z.string()), dest_tx: opt(z.string()), token: opt(z.string()) }),
  withdrawal_requested: z.looseObject({ company_id: z.string(), withdrawal_id: z.string(), amount, token: z.string(), to: z.string() }),
  withdrawal_recorded: z.looseObject({ company_id: z.string(), withdrawal_id: z.string(), amount_in: opt(amount), amount_out: amount, fees: opt(amount), quote_id: opt(z.string()), origin_tx: opt(z.string()), dest_tx: opt(z.string()), token: opt(z.string()) }),
  float_set: z.looseObject({ department_id: z.string(), rail: z.string(), target: opt(amount) }),

  bounty_released: z.looseObject({ task_id: z.string(), payee: z.string(), verdict: opt(z.string()), log_hash: opt(z.string()), amount: opt(amount) }),
  bounty_voided: z.looseObject({ task_id: z.string(), verdict: opt(z.string()), log_hash: opt(z.string()) }),

  member_invited: z.looseObject({ company_id: z.string(), account_id: opt(z.string()), departments: opt(z.array(z.string())), scopes: opt(z.array(z.string())) }),
  grant_set: z.looseObject({ account_id: z.string(), department_id: z.string(), scopes: z.array(z.string()), limit: opt(amount), expires_at: opt(z.union([z.string(), z.number()])) }),
  grant_revoked: z.looseObject({ account_id: z.string(), department_id: opt(z.string()), company_id: opt(z.string()) }),
  view_key_registered: z.looseObject({ account_id: z.string(), x25519_public_key: z.string() }),

  code_key_rotated: z.looseObject({ company_id: z.string(), version: z.number() }),
  policy_changed: z.looseObject({ old_hash: opt(z.string()), new_hash: z.string() }),
  frozen: z.looseObject({ company_id: opt(z.string()), department_id: opt(z.string()) }),
  unfrozen: z.looseObject({ company_id: opt(z.string()), department_id: opt(z.string()) }),

  deposit: z.looseObject({ amount, token: z.string(), payer: opt(z.string()) }),
  revenue: z.looseObject({ amount, token: z.string(), payer: opt(z.string()), foreign_tx: opt(z.string()) }),
} as const;

export type EventName = keyof typeof EventSchemas;
export const isKnownEvent = (e: string): e is EventName => e in EventSchemas;

export const ReceiptKind = z.enum([
  "purchase",
  "approval",
  "rejection",
  "topup",
  "withdrawal",
  "deposit",
  "revenue",
  "bounty",
  "membership",
  "keys_policy",
  "other",
]);
export type ReceiptKind = z.infer<typeof ReceiptKind>;

/** Money receipts are what viewers are allowed to see. */
export const MONEY_RECEIPT_KINDS: ReceiptKind[] = ["purchase", "approval", "rejection", "topup", "withdrawal", "deposit", "revenue", "bounty"];

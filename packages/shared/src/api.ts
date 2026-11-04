import { z } from "zod";

/** Request/response schemas shared by the API and (optionally) the Vercel web app. */

export const AccountId = z.string().regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/).min(2).max(64);
export const Tier = z.enum(["economy", "standard", "premium", "private"]);
export const TaskTag = z.enum([
  "frontend",
  "backend",
  "contract",
  "security",
  "devops",
  "design",
  "docs",
  "test",
  "research",
  "growth",
  "support",
  /** Outside the major platform roles — filled by a hired niche agent. */
  "niche",
  "expert",
]);

export const ChallengeQuery = z.object({ accountId: AccountId });
export const VerifyBody = z.object({
  accountId: AccountId,
  publicKey: z.string().startsWith("ed25519:"),
  signature: z.string(), // base64 (NEP-413 signMessage output)
  nonce: z.string(), // base64 32 bytes, as issued by /challenge
  message: z.string(),
  callbackUrl: z.string().optional(),
});

export const CreateCompanyBody = z.object({
  name: z.string().min(2).max(64),
  slug: z.string().regex(/^[a-z0-9-]{2,32}$/),
  preset: z.string().default("saas-starter"),
  dailyCap: z.string().regex(/^\d+$/).default("50000000"), // USDC 6dp
  departments: z
    .array(z.object({ name: z.string(), budget: z.string().regex(/^\d+$/), perTxLimit: z.string().regex(/^\d+$/) }))
    .default([
      { name: "build", budget: "100000000", perTxLimit: "5000000" },
      { name: "ops", budget: "30000000", perTxLimit: "2000000" },
      { name: "growth", budget: "20000000", perTxLimit: "2000000" },
    ]),
});

export const CreatePlanBody = z.object({
  companyId: z.string(),
  description: z.string().min(10).max(20_000),
  tier: Tier.default("standard"),
});

export const EstimateQuery = z.object({
  tag: TaskTag,
  size: z.enum(["xs", "s", "m", "l", "xl"]).default("m"),
  tier: Tier.optional(),
});

export const PatchTaskBody = z.object({ tier: Tier.optional(), pinnedModel: z.string().nullable().optional() });

export const SellerOptionsQuery = z.object({ service: z.string() });

export const HireOptionsQuery = z.object({
  service: z.string().default("expertise"),
  q: z.string().optional(),
  tag: z.string().optional(),
});

export const DecideApprovalBody = z.object({ decision: z.enum(["approve", "reject"]) });

export const LedgerQuery = z.object({
  companyId: z.string(),
  kind: z.string().optional(),
  departmentId: z.string().optional(),
  before: z.coerce.number().optional(),
  limit: z.coerce.number().min(1).max(500).default(100),
  format: z.enum(["json", "csv"]).default("json"),
});

export const InviteBody = z.object({
  companyId: z.string(),
  email: z.string().email(),
  departments: z.array(z.string()).min(1),
  template: z.enum(["viewer", "approver", "builder", "admin"]).default("viewer"),
  limit: z.string().regex(/^\d+$/).optional(),
  expiresInDays: z.number().int().min(1).max(365).default(30),
});

export const TempoFloatBody = z.object({
  departmentId: z.string(),
  target: z.string().regex(/^\d+$/),
  enabled: z.boolean().default(true),
});

export const WithdrawalBody = z.object({
  companyId: z.string(),
  amount: z.string().regex(/^\d+$/),
  token: z.string().default("usdc"),
  to: z.string(),
  chain: z.enum(["near", "base", "ethereum", "arbitrum", "solana"]).default("near"),
});

export const RotateCodeKeyBody = z.object({
  companyId: z.string(),
  newVersion: z.number().int().positive(),
  wrappedKeys: z.array(z.object({ memberAccount: z.string(), ciphertext: z.string() })).min(1),
});

export const FreezeBody = z.object({ companyId: z.string(), departments: z.array(z.string()).optional() });

export const PushSubscriptionBody = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});

/** wallet-selector compatible transaction shape, so the web app can call signAndSendTransactions directly. */
export type UnsignedTx = {
  receiverId: string;
  actions: Array<{
    type: "FunctionCall";
    params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string };
  }>;
};

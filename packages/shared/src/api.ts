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

/**
 * `accountId` is optional so the web app can fetch a challenge before it knows the account (prefetch on page
 * load, so the sign-in button works on the first click). Identity always comes from the signing key.
 */
export const ChallengeQuery = z.object({ accountId: AccountId.optional() });
export const LoginMethod = z.enum(["privy", "wallet"]);
export const VerifyBody = z.object({
  accountId: AccountId,
  /** How the person signed in: Privy (Google/email embedded wallet) or a NEAR wallet. */
  loginMethod: LoginMethod.optional(),
  /** Privy identity token (Privy sign-in only): verifies the person's email in the same step. */
  privyIdentityToken: z.string().min(20).max(20_000).optional(),
  /** ed25519:… — prefix added if the client omits it (some Privy adapters). */
  publicKey: z
    .string()
    .min(8)
    .transform((s) => (s.startsWith("ed25519:") ? s : `ed25519:${s}`)),
  signature: z.string(), // base64 (also hex / ed25519:base58 accepted by verifier)
  nonce: z.string(), // base64 32 bytes, as issued by /challenge
  message: z.string(),
  callbackUrl: z.string().optional(),
});

/** Department label: lowercase, becomes `<name>.<company>` on chain. */
export const DepartmentName = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9](?:[a-z0-9_-]{0,18}[a-z0-9])?$/, "team names: 1-20 chars, a-z 0-9 - _ (no spaces)"));

/**
 * USDC amount. Integer strings are already in micro-USDC (6dp, the backend's unit everywhere);
 * a decimal string ("12.5") is read as dollars and converted.
 */
export const UsdcAmount = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return s;
  const m = /^(\d+)\.(\d{1,6})$/.exec(s);
  if (m) return (BigInt(m[1]) * 1_000_000n + BigInt(m[2].padEnd(6, "0"))).toString();
  ctx.addIssue({ code: "custom", message: "amount must be micro-USDC integer or a dollar decimal" });
  return z.NEVER;
});

const DEFAULT_DEPARTMENTS = [
  { name: "build", budget: "100000000", perTxLimit: "5000000" },
  { name: "ops", budget: "30000000", perTxLimit: "2000000" },
  { name: "growth", budget: "20000000", perTxLimit: "2000000" },
];

export const CreateCompanyBody = z
  .object({
    name: z.string().min(2).max(64),
    /** "sezk" or the full company account "sezk.<factory>" (normalised to "sezk"). */
    slug: z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase().split(".")[0] : v), z.string().regex(/^[a-z0-9-]{2,32}$/)),
    preset: z.string().default("saas-starter"),
    dailyCap: UsdcAmount.optional(),
    departments: z.array(z.object({ name: DepartmentName, budget: UsdcAmount, perTxLimit: UsdcAmount })).min(1).max(6).optional(),
    /** Web app shape: teams[{ team, monthlyCap }] (mapped to departments; per-tx limit = autoApproveLimit or 5% of the cap). */
    teams: z.array(z.object({ team: DepartmentName, monthlyCap: UsdcAmount })).min(1).max(6).optional(),
    autoApproveLimit: UsdcAmount.optional(),
    /** Launch this draft: teams and budgets default to the draft's suggested setup; the draft joins the company. */
    planId: z.uuid().optional(),
  })
  .transform((b) => {
    const departments =
      b.departments ??
      (b.teams
        ? b.teams.map((t) => {
            const fivePct = (BigInt(t.monthlyCap) / 20n).toString();
            const perTx = b.autoApproveLimit && BigInt(b.autoApproveLimit) <= BigInt(t.monthlyCap) ? b.autoApproveLimit : fivePct;
            return { name: t.team, budget: t.monthlyCap, perTxLimit: perTx };
          })
        : DEFAULT_DEPARTMENTS);
    return { name: b.name, slug: b.slug, preset: b.preset, dailyCap: b.dailyCap ?? "50000000", dailyCapGiven: b.dailyCap !== undefined, departments, planId: b.planId, teamsGiven: Boolean(b.departments ?? b.teams) };
  })
  .superRefine((b, ctx) => {
    const names = b.departments.map((d) => d.name);
    if (new Set(names).size !== names.length) ctx.addIssue({ code: "custom", message: "team names must be unique", path: ["departments"] });
    for (const d of b.departments)
      if (BigInt(d.perTxLimit) > BigInt(d.budget)) ctx.addIssue({ code: "custom", message: `${d.name}: per-transaction limit is above the budget`, path: ["departments"] });
  });

export const RegisterAgentBody = z.object({
  companyId: z.string(),
  departmentId: z.string(),
  publicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/, "ed25519:<base58> public key"),
  role: z.string().min(2).max(32),
});
export const AgentStatusBody = z.object({ companyId: z.string(), status: z.enum(["running", "paused", "fired"]) });

export const CreatePlanBody = z.object({
  companyId: z.string(),
  description: z.string().min(10).max(20_000),
  tier: Tier.default("standard"),
});

/**
 * A draft: the Describe answers (or a free-text description). No company, no chain, no money.
 * `description` wins when given; otherwise it is built from what / who / howTheyPay.
 */
export const CreateDraftBody = z
  .object({
    title: z.string().trim().min(2).max(80).optional(),
    description: z.string().trim().min(10).max(20_000).optional(),
    what: z.string().trim().min(3).max(4_000).optional(),
    who: z.string().trim().max(2_000).optional(),
    howTheyPay: z.string().trim().max(2_000).optional(),
    /** "Keep my code private" → private tier (TEE models only). */
    private: z.boolean().optional(),
    tier: Tier.optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (!b.description && !b.what) ctx.addIssue({ code: "custom", message: "describe the product: send description, or what (+ who, howTheyPay)", path: ["what"] });
  })
  .transform((b) => {
    const description =
      b.description ??
      [`Build: ${b.what}`, b.who ? `For: ${b.who}` : null, b.howTheyPay ? `How they pay: ${b.howTheyPay}` : null].filter(Boolean).join("\n");
    const tier = b.tier ?? (b.private ? "private" : "standard");
    const title = b.title ?? (b.what ?? b.description ?? "").split(/[.\n]/)[0].trim().slice(0, 80);
    return { title: title.length >= 2 ? title : "Untitled product", description, tier };
  });

export const EmailBody = z.object({ email: z.string().trim().toLowerCase().pipe(z.email().max(254)) });
export const EmailCodeBody = z.object({ code: z.string().trim().regex(/^\d{6}$/, "6-digit code") });
export const PrivyEmailBody = z.object({ identityToken: z.string().min(20).max(20_000) });
export const PreferencesBody = z
  .object({
    /** Company the home screen opens next time (re-checked on chain when read). null clears it. */
    lastCompanyId: z.string().nullable().optional(),
    /** Tips / banners the person closed. */
    dismissed: z.array(z.string().max(64)).max(100).optional(),
  })
  .strict();

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

export const DecideApprovalBody = z.object({
  decision: z.enum(["approve", "reject"]),
  /** Seller cards: also allow-list this seller at the payee shown on the card ("Always use this"). */
  alwaysAllow: z.boolean().default(false),
});

export const AllowSellerBody = z.object({
  companyId: z.string(),
  departmentId: z.string(),
  sellerId: z.string().min(1).max(128),
  /** EVM address the seller may be paid at; null removes the seller from the allow-list. */
  payTo: z.string().regex(/^0x[0-9a-fA-F]{40}$/).nullable(),
});

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
  /** The account that must sign (the caller). Omitted on txs any signed-in wallet may sign. */
  signerId?: string;
  receiverId: string;
  actions: Array<{
    type: "FunctionCall";
    params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string };
  }>;
};

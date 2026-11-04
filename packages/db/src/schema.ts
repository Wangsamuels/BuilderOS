import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** numeric(38,0) in the token's smallest unit, surfaced as string so no precision is lost. */
const amount = (name: string) => numeric(name, { precision: 38, scale: 0 });
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
const ts = (name: string) => timestamp(name, { withTimezone: true });
const created = () => ts("created_at").defaultNow().notNull();
/** Every row that came from chain keeps block_height and near_tx. */
const chain = () => ({ blockHeight: bigint("block_height", { mode: "number" }), nearTx: text("near_tx") });

// ---------- Indexer-owned ----------

export const companies = pgTable("companies", {
  id: text("id").primaryKey(), // company contract account id
  accountId: text("account_id").notNull().unique(),
  name: text("name"),
  preset: text("preset"),
  network: text("network").notNull(),
  founderAccount: text("founder_account").notNull(),
  frozen: boolean("frozen").default(false).notNull(),
  codeKeyVersion: integer("code_key_version").default(0).notNull(),
  ...chain(),
  createdAt: created(),
});

export const departments = pgTable(
  "departments",
  {
    id: text("id").primaryKey(), // department contract account id
    companyId: text("company_id").notNull().references(() => companies.id),
    accountId: text("account_id").notNull(),
    name: text("name"),
    contractHash: text("contract_hash"),
    baseAddress: text("base_address"),
    frozen: boolean("frozen").default(false).notNull(),
    ...chain(),
    createdAt: created(),
  },
  (t) => [index("departments_company_idx").on(t.companyId)],
);

export const membersCache = pgTable(
  "members_cache",
  {
    accountId: text("account_id").notNull(),
    departmentId: text("department_id").notNull(),
    companyId: text("company_id"),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    limit: amount("limit"),
    expiresAt: ts("expires_at"),
    revoked: boolean("revoked").default(false).notNull(),
    viewKey: text("view_key"),
    ...chain(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.departmentId] }), index("members_account_idx").on(t.accountId)],
);

export const agents = pgTable("agents", {
  publicKey: text("public_key").primaryKey(),
  accountId: text("account_id"),
  departmentId: text("department_id").notNull(),
  role: text("role").notNull(),
  maxTier: text("max_tier"),
  status: text("status").default("active").notNull(),
  ...chain(),
});

export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    event: text("event").notNull(),
    standard: text("standard").notNull(),
    version: text("version").notNull(),
    contract: text("contract").notNull(),
    companyId: text("company_id"),
    departmentId: text("department_id"),
    data: jsonb("data").notNull(),
    receiptId: text("receipt_id").notNull(),
    logIndex: integer("log_index").notNull(),
    ...chain(),
    createdAt: created(),
  },
  (t) => [uniqueIndex("events_receipt_log_uq").on(t.receiptId, t.logIndex), index("events_company_idx").on(t.companyId, t.id)],
);

export const deadLetters = pgTable("dead_letters", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  contract: text("contract"),
  raw: text("raw").notNull(),
  error: text("error").notNull(),
  ...chain(),
  createdAt: created(),
});

export const indexerState = pgTable("indexer_state", {
  id: text("id").primaryKey(), // "near"
  lastBlockHeight: bigint("last_block_height", { mode: "number" }).notNull(),
  updatedAt: ts("updated_at").defaultNow().notNull(),
});

export const receipts = pgTable(
  "receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    companyId: text("company_id"),
    departmentId: text("department_id"),
    actor: text("actor"),
    amount: amount("amount"),
    token: text("token"),
    rail: text("rail"),
    chainId: text("chain_id"),
    foreignTx: text("foreign_tx"),
    verifiedOnChain: boolean("verified_on_chain"),
    verifyError: text("verify_error"),
    requestId: text("request_id"),
    eventId: bigint("event_id", { mode: "number" }),
    payload: jsonb("payload").notNull(),
    ...chain(),
    createdAt: created(),
  },
  (t) => [
    index("receipts_company_idx").on(t.companyId, t.createdAt),
    index("receipts_request_idx").on(t.requestId),
    uniqueIndex("receipts_event_uq").on(t.eventId),
  ],
);

export const bountiesCache = pgTable("bounties_cache", {
  taskId: text("task_id").primaryKey(),
  bountyId: text("bounty_id"),
  payee: text("payee"),
  amount: amount("amount"),
  currency: text("currency"),
  rail: text("rail"),
  agentId: text("agent_id"),
  status: text("status").notNull(),
  verdict: text("verdict"),
  logHash: text("log_hash"),
  ...chain(),
});

/** Niche hire jobs: reserved exact quote, verified by the hiring platform agent, paid on pass. */
export const hires = pgTable(
  "hires",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bountyId: text("bounty_id").notNull().unique(),
    taskId: text("task_id").notNull(),
    companyId: text("company_id").notNull(),
    departmentId: text("department_id").notNull(),
    hiringRole: text("hiring_role").notNull(),
    hiringAgent: text("hiring_agent"),
    hiredAgentId: text("hired_agent_id").notNull(),
    amount: amount("amount").notNull(),
    currency: text("currency").notNull(),
    rail: text("rail").notNull(),
    payTo: text("pay_to").notNull(),
    quoteHash: text("quote_hash").notNull(),
    alignmentScore: real("alignment_score"),
    ratingUsed: real("rating_used"),
    status: text("status").default("quoted").notNull(), // quoted|reserved|working|verified_pass|verified_fail|paid|voided|failed
    deliverable: jsonb("deliverable"),
    hiringVerdict: text("hiring_verdict"),
    hiringReasons: jsonb("hiring_reasons").$type<string[]>(),
    logHash: text("log_hash"),
    nearTx: text("near_tx"),
    updatedAt: ts("updated_at").defaultNow().notNull(),
    createdAt: created(),
  },
  (t) => [index("hires_task_idx").on(t.taskId), index("hires_dept_idx").on(t.departmentId, t.status)],
);

export const railFloats = pgTable(
  "rail_floats",
  {
    departmentId: text("department_id").notNull(),
    rail: text("rail").notNull(),
    target: amount("target"),
    balance: amount("balance").default("0"),
    reserved: amount("reserved").default("0"),
    enabled: boolean("enabled").default(true).notNull(),
    topupsToday: integer("topups_today").default(0).notNull(),
    topupsDay: text("topups_day"),
    paused: boolean("paused").default(false).notNull(),
    updatedAt: ts("updated_at").defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.departmentId, t.rail] })],
);

// ---------- App API ----------

export const authChallenges = pgTable("auth_challenges", {
  nonce: text("nonce").primaryKey(), // base64
  accountId: text("account_id").notNull(),
  message: text("message").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
});

export const authSessions = pgTable(
  "auth_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    accountId: text("account_id").notNull(),
    publicKey: text("public_key").notNull(),
    expiresAt: ts("expires_at").notNull(),
    rotatedAt: ts("rotated_at"),
    createdAt: created(),
  },
  (t) => [index("auth_sessions_account_idx").on(t.accountId)],
);

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  accountId: text("account_id").notNull(),
  route: text("route").notNull(),
  status: integer("status").notNull(),
  response: jsonb("response").notNull(),
  createdAt: created(),
});

export const invites = pgTable("invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: text("company_id").notNull(),
  emailHash: text("email_hash").notNull(),
  emailCiphertext: text("email_ciphertext"),
  codeHash: text("code_hash").notNull().unique(),
  departments: jsonb("departments").$type<string[]>().notNull(),
  template: text("template").notNull(),
  limit: amount("limit"),
  status: text("status").default("pending_confirmation").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: created(),
});

export const plans = pgTable("plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: text("company_id").notNull(),
  description: text("description").notNull(), // libsodium ciphertext (base64)
  keyVersion: integer("key_version").notNull(),
  features: jsonb("features").$type<PlanFeature[]>().notNull(),
  estimate: jsonb("estimate").notNull(),
  tier: text("tier").notNull(),
  approvedAt: ts("approved_at"),
  createdBy: text("created_by").notNull(),
  createdAt: created(),
});
export type PlanFeature = { key: string; title: string; tag: string; size: string; dependsOn: string[] };

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    planId: uuid("plan_id").notNull(),
    companyId: text("company_id").notNull(),
    departmentId: text("department_id"),
    title: text("title").notNull(),
    tag: text("tag").notNull(),
    size: text("size").notNull(),
    tier: text("tier").notNull(),
    pinnedModel: text("pinned_model"),
    dependsOn: jsonb("depends_on").$type<string[]>().default([]).notNull(),
    estP50: amount("est_p50"),
    estP90: amount("est_p90"),
    cap: amount("cap"),
    status: text("status").default("pending").notNull(), // pending|assigned|ready|running|paused|review|done|failed
    pauseReason: text("pause_reason"),
    agent: text("agent"),
    /** When set, the orchestrator hires a niche agent instead of (or before) in-house generation. */
    hireAgentId: text("hire_agent_id"),
    hireRequired: boolean("hire_required").default(false).notNull(),
    attempts: integer("attempts").default(0).notNull(),
    commitSha: text("commit_sha"),
    updatedAt: ts("updated_at").defaultNow().notNull(),
    createdAt: created(),
  },
  (t) => [index("tasks_plan_idx").on(t.planId), index("tasks_status_idx").on(t.status)],
);

export const modelCalls = pgTable("model_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: text("task_id").notNull(),
  model: text("model").notNull(),
  provider: text("provider").notNull(),
  rail: text("rail").notNull(),
  tier: text("tier").notNull(),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  cost: amount("cost"),
  latencyMs: integer("latency_ms"),
  outcome: text("outcome").notNull(),
  receiptId: text("receipt_id"),
  createdAt: created(),
});

export const sellerOptions = pgTable(
  "seller_options",
  {
    service: text("service").notNull(),
    sellerId: text("seller_id").notNull(),
    rail: text("rail").notNull(),
    price: amount("price"),
    qualityNote: text("quality_note"),
    endpoint: text("endpoint"),
    fetchedAt: ts("fetched_at").defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.service, t.sellerId] })],
);

export const approvalCards = pgTable(
  "approval_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: text("company_id").notNull(),
    kind: text("kind").notNull(), // single | daily-cap | seller
    day: text("day"),
    requestIds: jsonb("request_ids").$type<string[]>().default([]).notNull(),
    amount: amount("amount"),
    payload: jsonb("payload").default({}).notNull(),
    status: text("status").default("pending").notNull(),
    decidedBy: text("decided_by"),
    createdAt: created(),
  },
  (t) => [index("approval_cards_company_idx").on(t.companyId, t.status), uniqueIndex("approval_cards_daily_uq").on(t.companyId, t.kind, t.day)],
);

export const bridgeTransfers = pgTable("bridge_transfers", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: text("job_id").notNull().unique(),
  departmentId: text("department_id").notNull(),
  direction: text("direction").notNull(), // topup | withdrawal
  amountIn: amount("amount_in"),
  amountOut: amount("amount_out"),
  fees: amount("fees"),
  quoteId: text("quote_id"),
  depositAddress: text("deposit_address"),
  originTx: text("origin_tx"),
  relayRequestId: text("relay_request_id"),
  destTx: text("dest_tx"),
  status: text("status").notNull(),
  error: text("error"),
  updatedAt: ts("updated_at").defaultNow().notNull(),
  createdAt: created(),
});

export const withdrawals = pgTable("withdrawals", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull(),
  amount: amount("amount").notNull(),
  token: text("token").notNull(),
  to: text("to").notNull(),
  chain: text("chain"),
  sources: jsonb("sources").default([]).notNull(),
  status: text("status").notNull(),
  createdAt: created(),
});

/** Tempo MPP session channels (not auth sessions). */
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  departmentId: text("department_id").notNull(),
  seller: text("seller").notNull(),
  channelId: text("channel_id"),
  walletAddress: text("wallet_address"),
  depositCap: amount("deposit_cap").notNull(),
  spent: amount("spent").default("0").notNull(),
  status: text("status").notNull(),
  createdAt: created(),
});

export const provenance = pgTable("provenance", {
  id: uuid("id").primaryKey().defaultRandom(),
  commitSha: text("commit_sha").notNull(),
  file: text("file").notNull(),
  model: text("model").notNull(),
  provider: text("provider").notNull(),
  cost: amount("cost"),
  receiptId: text("receipt_id"),
  attestation: text("attestation"),
  createdAt: created(),
});

export const leaderboardStats = pgTable(
  "leaderboard_stats",
  {
    tag: text("tag").notNull(),
    tier: text("tier").notNull(),
    modelOrSeller: text("model_or_seller").notNull(),
    tasks: integer("tasks").default(0).notNull(),
    passed: integer("passed").default(0).notNull(),
    costPerPass: amount("cost_per_pass"),
    refunds: integer("refunds").default(0).notNull(),
    passRate: real("pass_rate"),
    updatedAt: ts("updated_at").defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.tag, t.tier, t.modelOrSeller] })],
);

export const services = pgTable("services", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: text("company_id").notNull(),
  seller: text("seller").notNull(),
  resource: text("resource").notNull(),
  renewsAt: ts("renews_at"),
  cancelUrl: text("cancel_url"),
  lastUsedAt: ts("last_used_at"),
  status: text("status").default("active").notNull(),
});

export const wrappedKeys = pgTable(
  "wrapped_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: text("company_id").notNull(),
    kind: text("kind").notNull(), // code | log
    departmentId: text("department_id"),
    version: integer("version").notNull(),
    memberAccount: text("member_account").notNull(),
    ciphertext: text("ciphertext").notNull(),
    createdAt: created(),
  },
  (t) => [uniqueIndex("wrapped_keys_uq").on(t.companyId, t.kind, t.departmentId, t.version, t.memberAccount)],
);

export const keyAccessLog = pgTable("key_access_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  accountId: text("account_id").notNull(),
  companyId: text("company_id").notNull(),
  kind: text("kind").notNull(),
  allowed: boolean("allowed").notNull(),
  reason: text("reason"),
  createdAt: created(),
});

export const encryptedLogs = pgTable("encrypted_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  departmentId: text("department_id").notNull(),
  taskId: text("task_id"),
  keyVersion: integer("key_version").notNull(),
  ciphertext: bytea("ciphertext").notNull(),
  hashOnChain: text("hash_on_chain").notNull(),
  createdAt: created(),
});

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    account: text("account").notNull(),
    companyId: text("company_id"),
    kind: text("kind").notNull(),
    channel: text("channel").notNull(),
    payload: jsonb("payload").notNull(),
    sentAt: ts("sent_at"),
    error: text("error"),
    read: boolean("read").default(false).notNull(),
    createdAt: created(),
  },
  (t) => [index("notifications_account_idx").on(t.account, t.createdAt)],
);

export const pushSubscriptions = pgTable("push_subscriptions", {
  endpoint: text("endpoint").primaryKey(),
  account: text("account").notNull(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  createdAt: created(),
});

export const accountEmails = pgTable("account_emails", {
  account: text("account").primaryKey(),
  emailCiphertext: text("email_ciphertext").notNull(),
  emailHash: text("email_hash").notNull(),
});

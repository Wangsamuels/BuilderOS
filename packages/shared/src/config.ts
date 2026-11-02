import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "1" || v === "true");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().default("postgres://builderos:builderos@localhost:5432/builderos"),
  DATABASE_SSL: bool,
  DB_POOL_MAX: z.coerce.number().default(5),

  // Web app wiring (Vercel). Comma-separated list of exact origins.
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  // Optional regex for Vercel preview deployments, e.g. ^https://builderos-[a-z0-9-]+-you\.vercel\.app$
  WEB_ORIGIN_PATTERN: z.string().optional(),
  // Set to ".your-domain.com" when app.<domain> and api.<domain> share a parent domain.
  COOKIE_DOMAIN: z.string().optional(),
  SESSION_SECRET: z.string().default("dev-only-session-secret-change-me-please-32b"),
  AUTH_RECIPIENT: z.string().default("builderos"),

  // NEAR
  NEAR_RPC_URL: z.string().optional(),
  NEAR_RPC_FALLBACK_URL: z.string().optional(),
  FACTORY_CONTRACT: z.string().optional(),
  REGISTRY_CONTRACT: z.string().optional(),
  MPC_SIGNER: z.string().optional(),
  INDEXER_START_BLOCK: z.coerce.number().optional(),

  // Worker-side keys (request-only / record-only function-call keys)
  WORKER_ACCOUNT_ID: z.string().optional(),
  WORKER_PRIVATE_KEY: z.string().optional(),
  VERIFIER_ACCOUNT_ID: z.string().optional(),
  VERIFIER_PRIVATE_KEY: z.string().optional(),
  AGENT_KEYSTORE_PATH: z.string().default("./keystore/agents.json"),
  AGENT_KEYSTORE_PASSPHRASE: z.string().optional(),
  AGENT_KEYSTORE_JSON: z.string().optional(), // encrypted keystore blob for Heroku (no disk)
  ORCHESTRATOR_X25519_SECRET: z.string().optional(),

  // Inference
  NEAR_AI_API_KEY: z.string().optional(),
  NEAR_AI_BASE_URL: z.string().default("https://cloud-api.near.ai/v1"),

  // Chains / bridges
  BASE_RPC_URL: z.string().optional(),
  TEMPO_RPC_URL: z.string().optional(),
  TEMPO_ENABLED: bool,
  ONECLICK_BASE_URL: z.string().default("https://1click.chaindefuser.com"),
  ONECLICK_JWT: z.string().optional(),
  RELAY_BASE_URL: z.string().optional(),
  BRIDGE_MOCK_URL: z.string().default("http://localhost:4100/bridge"),

  // Notifications
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:ops@builderos.dev"),
  NEAR_EMAIL_URL: z.string().optional(),
  NEAR_EMAIL_PAYMENT_KEY: z.string().optional(),
  STABLE_EMAIL_URL: z.string().optional(),

  // Local seller mesh
  SELLER_MESH_URL: z.string().default("http://localhost:4100"),
  USE_SELLER_MESH: bool,

  LOG_LEVEL: z.string().default("info"),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;
export function env(): Env {
  if (!cached) {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      console.error("Invalid environment", parsed.error.issues);
      throw new Error("Invalid environment variables");
    }
    cached = parsed.data;
    // Never run production on the public dev default: it keys session cookies and server-side encryption.
    if (cached.NODE_ENV === "production" && (cached.SESSION_SECRET.startsWith("dev-only") || cached.SESSION_SECRET.length < 32)) {
      throw new Error("SESSION_SECRET must be set to 32+ random characters in production (heroku config:set SESSION_SECRET=$(openssl rand -base64 32))");
    }
    // Heroku Postgres always needs SSL.
    if (cached.DATABASE_URL.includes("amazonaws.com") || cached.NODE_ENV === "production") {
      cached.DATABASE_SSL = true;
    }
  }
  return cached;
}

/** Everything that changes between testnet and mainnet lives here. */
export function network() {
  const e = env();
  const testnet = e.NETWORK === "testnet";
  return {
    id: e.NETWORK,
    rpcUrl: e.NEAR_RPC_URL ?? (testnet ? "https://rpc.testnet.fastnear.com" : "https://rpc.mainnet.fastnear.com"),
    rpcFallbackUrl: e.NEAR_RPC_FALLBACK_URL ?? (testnet ? "https://rpc.testnet.near.org" : "https://rpc.mainnet.near.org"),
    factory: e.FACTORY_CONTRACT ?? (testnet ? "builderos.testnet" : "builderos.near"),
    registry: e.REGISTRY_CONTRACT ?? (testnet ? "registry.builderos.testnet" : "registry.builderos.near"),
    mpcSigner: e.MPC_SIGNER ?? (testnet ? "v1.signer-prod.testnet" : "v1.signer"),
    base: {
      chainId: testnet ? 84532 : 8453,
      x402Network: testnet ? "base-sepolia" : "base",
      rpcUrl: e.BASE_RPC_URL ?? (testnet ? "https://sepolia.base.org" : "https://mainnet.base.org"),
      usdc: testnet ? "0x036CbD53842c5426634e7929541eC2318f3dCF7e" : "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    },
    tempo: { rpcUrl: e.TEMPO_RPC_URL, enabled: e.TEMPO_ENABLED },
    oneClickDry: testnet,
  };
}

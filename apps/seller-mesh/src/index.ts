import Fastify from "fastify";
import { randomBytes } from "node:crypto";

/**
 * Seller mesh: local mocks for every external seller so `pnpm demo` and tests run offline.
 * Models: Near AI via x402 on Base USDC. Tempo/MPP only for services that require it.
 */
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
const PORT = Number(process.env.SELLER_MESH_PORT ?? 4100);
const BASE = `http://localhost:${PORT}`;
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const mockTx = () => `0xmock${randomBytes(29).toString("hex")}`;

type Seller = { id: string; service: string; rail: "x402-evm" | "mpp-tempo-charge"; price: string; payTo: string; quality_note: string };
const SELLERS: Seller[] = [
  {
    id: "near-ai.x402",
    service: "inference",
    rail: "x402-evm",
    price: "20000",
    payTo: "0x1321223B9bA9673974356B3fE286fB81E1747469",
    quality_note: "Near AI models via x402 (Base USDC) — primary inference rail",
  },
  { id: "names.base", service: "domain", rail: "x402-evm", price: "12000000", payTo: "0x3333333333333333333333333333333333333333", quality_note: "Instant .com/.dev registration" },
  { id: "dnsbuy", service: "domain", rail: "x402-evm", price: "11000000", payTo: "0x4444444444444444444444444444444444444444", quality_note: "Cheaper, slower DNS propagation" },
  { id: "stableemail", service: "email", rail: "x402-evm", price: "1000", payTo: "0x5555555555555555555555555555555555555555", quality_note: "Transactional email, 99.9% delivery" },
  { id: "run402", service: "hosting", rail: "x402-evm", price: "0", payTo: "0x6666666666666666666666666666666666666666", quality_note: "Postgres + auth + static + functions" },
  // Only used when TEMPO_ENABLED — not for models
  { id: "tempo-mpp.demo", service: "mpp-demo", rail: "mpp-tempo-charge", price: "50000", payTo: "0x2222222222222222222222222222222222222222", quality_note: "Demo MPP-only service (not inference)" },
];

/** Niche specialists — hired only when decideHire says necessary + cheaper/more efficient than swarm. */
type Hireable = {
  agent_id: string;
  service: string;
  description: string;
  skills: string[];
  rating: number;
  rail: "x402-evm";
  pay_to: string;
  currency: string;
  price: string;
  quality_note: string;
};
const HIREABLE: Hireable[] = [
  {
    agent_id: "counsel.delaware-llc",
    service: "expertise",
    description: "Delaware LLC formation, articles of organization, registered agent filings",
    skills: ["llc", "incorporation", "delaware", "registered agent", "ein"],
    rating: 0.91,
    rail: "x402-evm",
    pay_to: "0x7777777777777777777777777777777777777777",
    currency: "usdc",
    price: "2500000",
    quality_note: "Formation packets only; not general product advice",
  },
  {
    agent_id: "counsel.hipaa",
    service: "expertise",
    description: "HIPAA BAA review and PHI handling checklist for health apps",
    skills: ["hipaa", "baa", "phi", "healthcare compliance"],
    rating: 0.88,
    rail: "x402-evm",
    pay_to: "0x8888888888888888888888888888888888888888",
    currency: "usdc",
    price: "4000000",
    quality_note: "Narrow HIPAA specialty; expensive vs swarm for ordinary auth work",
  },
  {
    agent_id: "ads.programmatic",
    service: "expertise",
    description: "Programmatic media buy and ad campaign setup with budget caps",
    skills: ["ad buy", "media buy", "programmatic", "campaign"],
    rating: 0.84,
    rail: "x402-evm",
    pay_to: "0x9999999999999999999999999999999999999999",
    currency: "usdc",
    price: "1500000",
    quality_note: "Paid media only; not in-app growth copy",
  },
];

app.get("/registry", async (req) => {
  const service = (req.query as any).service;
  return SELLERS.filter((s) => !service || s.service === service).map((s) => ({
    seller_id: s.id,
    service: s.service,
    rail: s.rail,
    endpoint: `${BASE}/sellers/${s.id}`,
    probe_url: `${BASE}/sellers/${s.id}/price`,
    quality_note: s.quality_note,
  }));
});

app.get("/hireable", async (req) => {
  const service = (req.query as any).service;
  return HIREABLE.filter((a) => !service || a.service === service).map((a) => ({
    ...a,
    endpoint: `${BASE}/hireable/${a.agent_id}`,
  }));
});

app.get("/hireable/:id/quote", async (req, reply) => {
  const a = HIREABLE.find((x) => x.agent_id === (req.params as any).id);
  if (!a) return reply.code(404).send({ error: "unknown hireable agent" });
  return { amount: a.price, currency: a.currency, pay_to: a.pay_to, rail: a.rail, agent_id: a.agent_id };
});

app.post("/hireable/:id/hire", async (req, reply) => {
  const a = HIREABLE.find((x) => x.agent_id === (req.params as any).id);
  if (!a) return reply.code(404).send({ error: "unknown hireable agent" });
  const body = (req.body ?? {}) as any;
  const bounty = req.headers["x-bounty-id"];
  if (!bounty) return reply.code(400).send({ error: "x-bounty-id required (pay-on-green)" });
  return {
    ok: true,
    summary: `Niche deliverable from ${a.agent_id} for: ${String(body.title ?? "").slice(0, 160)}`,
    agent_id: a.agent_id,
    amount: body.amount ?? a.price,
    currency: body.currency ?? a.currency,
    artifacts: [{ path: `niche/${a.agent_id}.md`, content: `# ${a.agent_id}\n\n${a.description}\n\nTask: ${body.title ?? ""}\n` }],
  };
});

function challenge(s: Seller, resource: string, amount = s.price) {
  if (s.rail === "mpp-tempo-charge") {
    const request = Buffer.from(JSON.stringify({ amount, currency: "usdc", recipient: s.payTo })).toString("base64url");
    return { headers: { "www-authenticate": `Payment id="${randomBytes(8).toString("hex")}", realm="${s.id}", method="tempo", intent="charge", request="${request}"` }, body: { error: "payment required" } };
  }
  // Near AI path mirrors PingPay: x402 v2 PAYMENT-REQUIRED (CAIP-2) + v1 body for older clients
  if (s.id === "near-ai.x402") {
    const v2 = {
      x402Version: 2,
      error: "PAYMENT-SIGNATURE header is required",
      resource: { url: resource, description: s.service, mimeType: "application/json" },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:84532",
          amount,
          asset: USDC_SEPOLIA,
          payTo: s.payTo,
          maxTimeoutSeconds: 60,
          extra: { name: "USDC", version: "2" },
        },
      ],
    };
    return {
      headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(v2)).toString("base64") },
      body: { error: "payment required" },
    };
  }
  return {
    headers: {},
    body: {
      x402Version: 1,
      error: "X-PAYMENT header is required",
      accepts: [{ scheme: "exact", network: "base-sepolia", maxAmountRequired: amount, resource, description: s.service, mimeType: "application/json", payTo: s.payTo, maxTimeoutSeconds: 60, asset: USDC_SEPOLIA, extra: { name: "USDC", version: "2" } }],
    },
  };
}

function paid(req: any) {
  for (const h of [req.headers["payment-signature"], req.headers["x-payment"]]) {
    if (!h) continue;
    try {
      const p = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
      if (p.payload?.signature || p.payload?.signedDelegateAction) return "x402";
    } catch {
      /* ignore */
    }
  }
  return String(req.headers.authorization ?? "").startsWith("Payment ") ? "mpp" : null;
}

app.all("/sellers/:id/*", async (req, reply) => {
  const s = SELLERS.find((x) => x.id === (req.params as any).id);
  if (!s) return reply.code(404).send({ error: "unknown seller" });
  const path = (req.params as any)["*"] as string;
  const kind = paid(req);
  if (!kind) {
    const c = challenge(s, `${BASE}${req.url}`);
    return reply.code(402).headers(c.headers).send(c.body);
  }
  const tx = mockTx();
  if (kind === "x402") {
    const settled = Buffer.from(JSON.stringify({ success: true, transaction: tx, network: "base-sepolia" })).toString("base64");
    reply.header("x-payment-response", settled);
    reply.header("PAYMENT-RESPONSE", settled);
  } else reply.header("payment-receipt", Buffer.from(JSON.stringify({ status: "success", reference: tx })).toString("base64url"));

  if (path.endsWith("chat/completions")) {
    const body = (req.body ?? {}) as any;
    const ask = String(body.messages?.at(-1)?.content ?? "");
    const isReview = /review/i.test(String(body.messages?.[0]?.content ?? ""));
    const content = isReview
      ? JSON.stringify({ verdict: "pass", reasons: ["mock review"] })
      : "```json\n" + JSON.stringify({ files: [{ path: "src/feature.js", content: `// ${ask.replace(/\n/g, " ").slice(0, 80)}\nexport const ok = true;\n` }], summary: "mock patch" }) + "\n```";
    return { id: `mock-${Date.now()}`, model: body.model, choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 1200, completion_tokens: 300 } };
  }
  return { ok: true, seller: s.id, service: s.service, path, receipt: tx };
});

// ---- Relay bridge-mock ----
const relay = new Map<string, number>();
app.post("/bridge/quote", async (req) => {
  const b = req.body as any;
  const requestId = `0x${randomBytes(32).toString("hex")}`;
  relay.set(requestId, 0);
  const fee = (BigInt(b.amount ?? "0") / 1000n).toString(); // 0.1%
  return { requestId, depositAddress: `0x${randomBytes(20).toString("hex")}`, details: { currencyIn: { amount: b.amount }, currencyOut: { amount: (BigInt(b.amount ?? "0") - BigInt(fee)).toString() } }, fees: { relayer: { amount: fee } } };
});
app.get("/bridge/requests/v3", async (req) => {
  const id = (req.query as any).id;
  const n = (relay.get(id) ?? 0) + 1;
  relay.set(id, n);
  return { requests: [{ id, status: n >= 2 ? "success" : "pending", data: { inTxs: [{ hash: mockTx() }], outTxs: n >= 2 ? [{ hash: mockTx() }] : [] } }] };
});

// ---- 1Click mock ----
app.post("/oneclick/v0/quote", async (req) => {
  const b = req.body as any;
  const fee = (BigInt(b.amount ?? "0") / 2000n).toString();
  return { correlationId: randomBytes(8).toString("hex"), quote: { depositAddress: `0x${randomBytes(20).toString("hex")}`, amountIn: b.amount, amountOut: (BigInt(b.amount) - BigInt(fee)).toString() } };
});

// ---- near-email mock ----
app.post("/email/send", async (req) => {
  app.log.info({ to: (req.body as any)?.to, subject: (req.body as any)?.subject }, "mock email");
  return { ok: true, id: randomBytes(6).toString("hex") };
});

app.get("/health", async () => ({ ok: true, service: "seller-mesh", sellers: SELLERS.length, hireable: HIREABLE.length }));

app.listen({ port: PORT, host: "0.0.0.0" }).catch((e) => {
  app.log.error(e);
  process.exit(1);
});

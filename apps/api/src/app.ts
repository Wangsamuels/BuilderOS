import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { DEFAULT_ERROR_CODES, env, HttpError, type Logger } from "@builderos/shared";
import { and, eq, getDb, idempotencyKeys } from "@builderos/db";
import { loadSession } from "./auth.js";
import { normalizeCompanyId } from "@builderos/near";
import { SseHub } from "./sse.js";
import { authRoutes } from "./routes/auth.js";
import { coreRoutes } from "./routes/core.js";
import { moneyRoutes } from "./routes/money.js";
import { memberRoutes } from "./routes/members.js";
import { streamRoutes } from "./routes/stream.js";
import { extraRoutes } from "./routes/extra.js";

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), "invalid_request");
  return r.data;
}

/** Exact origins from WEB_ORIGIN (comma-separated) plus an optional regex for Vercel preview URLs. */
export function originAllowed(origin: string | undefined) {
  if (!origin) return true; // curl, server-to-server, same-origin
  const e = env();
  const exact = e.WEB_ORIGIN.split(",").map((s) => s.trim().replace(/\/$/, ""));
  if (exact.includes(origin)) return true;
  if (e.WEB_ORIGIN_PATTERN && new RegExp(e.WEB_ORIGIN_PATTERN).test(origin)) return true;
  return false;
}

/** Bump with every change to docs/API-CONTRACT.md. */
export const API_CONTRACT_VERSION = "2026-11-11";

/** Writes whose answer must be fresh every time (a replayed stream token would already be expired). */
const NO_REPLAY = new Set(["/v1/stream/token", "/v1/auth/logout"]);

export async function buildApp(opts: { log: Logger; hub?: SseHub }): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: opts.log as unknown as FastifyBaseLogger,
    trustProxy: true, // Heroku router sets X-Forwarded-For / -Proto
    bodyLimit: 1_000_000,
    genReqId: (req) => (req.headers["x-request-id"] as string) ?? crypto.randomUUID(),
  });
  const hub = opts.hub ?? new SseHub(opts.log);
  app.decorate("hub", hub);

  await app.register(cors, {
    origin: (origin, cb) => cb(null, originAllowed(origin)),
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization", "idempotency-key", "last-event-id", "x-request-id"],
    exposedHeaders: ["x-request-id"],
    maxAge: 86400,
  });
  await app.register(cookie, { secret: env().SESSION_SECRET });
  app.addHook("onRequest", loadSession);

  // One spelling per company: "demo" and "demo.<factory>" are the same company on every route
  // (query/body companyId, and the :id of /v1/companies/:id/...). Authorization still runs per route.
  app.addHook("preValidation", async (req) => {
    const q = req.query as Record<string, unknown> | undefined;
    if (q && typeof q.companyId === "string") q.companyId = normalizeCompanyId(q.companyId);
    const b = req.body as Record<string, unknown> | undefined;
    if (b && typeof b === "object" && !Array.isArray(b) && typeof b.companyId === "string") b.companyId = normalizeCompanyId(b.companyId);
    const p = req.params as Record<string, unknown> | undefined;
    const route = req.routeOptions.url ?? "";
    if (p && typeof p.id === "string" && route.startsWith("/v1/companies/:id")) p.id = normalizeCompanyId(p.id);
    if (p && typeof p.companyId === "string") p.companyId = normalizeCompanyId(p.companyId);
  });

  // 60 writes/minute per account (per IP when signed out). Reads are not limited.
  await app.register(rateLimit, {
    hook: "preHandler",
    max: 60,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.account ?? req.ip,
    allowList: (req) => req.method === "GET" || req.method === "OPTIONS",
  });

  // Idempotency-Key on writes: replay the stored response for the same account + route + key.
  app.addHook("preHandler", async (req, reply) => {
    const key = req.headers["idempotency-key"];
    if (!key || req.method === "GET" || !req.account || NO_REPLAY.has(req.routeOptions.url ?? "")) return;
    const [hit] = await getDb()
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.key, String(key)), eq(idempotencyKeys.accountId, req.account)));
    if (hit) {
      reply.header("idempotent-replay", "true");
      return reply.code(hit.status).send(hit.response);
    }
  });
  app.addHook("onSend", async (req, reply, payload) => {
    const key = req.headers["idempotency-key"];
    if (!key || req.method === "GET" || !req.account || reply.getHeader("idempotent-replay") || NO_REPLAY.has(req.routeOptions.url ?? "")) return payload;
    if (reply.statusCode < 500 && typeof payload === "string") {
      try {
        await getDb()
          .insert(idempotencyKeys)
          .values({ key: String(key), accountId: req.account, route: req.routeOptions.url ?? req.url, status: reply.statusCode, response: JSON.parse(payload) })
          .onConflictDoNothing();
      } catch {
        /* non-JSON payloads aren't cached */
      }
    }
    return payload;
  });

  // Write responses: always offer `transactions` (array, sign in order). Single-tx routes keep `transaction`.
  app.addHook("preSerialization", async (_req, _reply, payload: any) => {
    if (payload && typeof payload === "object" && !Array.isArray(payload) && payload.transaction && !payload.transactions)
      return { ...payload, transactions: [payload.transaction] };
    return payload;
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError)
      return reply.code(err.status).send({ error: err.code, code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
    if (err.statusCode && err.statusCode < 500) {
      const code = err.statusCode === 429 ? "rate_limited" : DEFAULT_ERROR_CODES[err.statusCode] ?? "error";
      return reply.code(err.statusCode).send({ error: code, code, message: err.message });
    }
    req.log.error({ err: err.message, stack: err.stack }, "unhandled");
    return reply.code(500).send({ error: "internal", message: "Internal error" });
  });

  app.get("/health", async () => ({
    ok: true,
    service: "api",
    network: env().NETWORK,
    /** Deployed commit (Heroku: `heroku labs:enable runtime-dyno-metadata`), and the API contract version. */
    commit: process.env.HEROKU_SLUG_COMMIT ?? process.env.SOURCE_VERSION ?? null,
    contract: API_CONTRACT_VERSION,
  }));

  await app.register(authRoutes, { prefix: "/v1/auth" });
  await app.register(coreRoutes, { prefix: "/v1" });
  await app.register(moneyRoutes, { prefix: "/v1" });
  await app.register(memberRoutes, { prefix: "/v1" });
  await app.register(streamRoutes, { prefix: "/v1" });
  await app.register(extraRoutes, { prefix: "/v1" });
  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    hub: SseHub;
  }
}

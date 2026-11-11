import type { FastifyPluginAsync } from "fastify";
import { HttpError } from "@builderos/shared";
import { getDb, sql } from "@builderos/db";
import { finalBlock } from "@builderos/near";
import { originAllowed } from "../app.js";
import { accessFor, issueStreamToken, requireAccount, visibleCompanies, type Access } from "../auth.js";
import type { StreamFilter } from "../sse.js";

// Upgrade proposals are shown to every member: code can only change after a public 24h wait.
const EVERYONE = ["company_created", "department_created", "frozen", "unfrozen", "upgrade_proposed", "upgrade_cancelled", "upgrade_applied"];
const MONEY = ["payment_signed", "receipt", "purchase_requested", "purchase_yielded", "purchase_approved", "purchase_rejected", "topup_requested", "topup_recorded", "withdrawal_requested", "withdrawal_recorded", "float_set", "deposit", "deposit_received", "revenue", "bounty_released", "bounty_voided"];
const BUILD = ["task_assigned", "agent_registered", "bounty_created", "agent_hired", "bounty_released", "bounty_voided"];

/** Founder/admin see every event; members see only the event kinds their scopes cover, for their team. */
export function streamFilter(a: Access): StreamFilter {
  if (a.admin) return { departments: null, events: null };
  const events = new Set(EVERYONE);
  if (a.scopes.has("view") || a.scopes.has("approve")) MONEY.forEach((e) => events.add(e));
  if (a.scopes.has("builder")) BUILD.forEach((e) => events.add(e));
  return { departments: a.departmentId ? [a.departmentId] : null, events };
}

export const streamRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Live events (SSE), resumable by Last-Event-ID (header, or ?lastEventId= for the first connect).
   * Browser: new EventSource(`${API}/v1/stream`, { withCredentials: true })
   * Safari / no third-party cookies: new EventSource(`${API}/v1/stream?token=${token}`)
   */
  app.get<{ Querystring: { companyId?: string; lastEventId?: string; token?: string } }>("/stream", async (req, reply) => {
    const account = requireAccount(req);
    // With companyId: checked on chain below (works before the indexer has cached the company).
    const companies = req.query.companyId ? [req.query.companyId] : await visibleCompanies(account);
    // Each company's events are filtered by what the founder granted this account (read live from chain).
    const filters = new Map<string, StreamFilter>();
    for (const c of companies) {
      const access = await accessFor(account, c).catch(() => null);
      if (access) filters.set(c, streamFilter(access));
    }
    if (req.query.companyId && !filters.size) throw new HttpError(403, "You don't have access to this company. Ask the founder for an invite.", "forbidden");
    const last = Number(req.headers["last-event-id"] ?? req.query.lastEventId ?? 0) || undefined;

    const origin = req.headers.origin;
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...(origin && originAllowed(origin) ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin" } : {}),
    });
    reply.raw.write(`retry: 3000\n\n`);
    reply.hijack();

    const expiresAt = req.sessionExpiresAt ?? null;
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ account, companies: [...filters.keys()], resumedAfter: last ?? null, expiresAt })}\n\n`);
    const lag = await indexerLag().catch(() => null);
    if (lag != null && lag > 30) reply.raw.write(`event: status\ndata: ${JSON.stringify({ catchingUp: true, lag })}\n\n`);
    // When the session/stream token expires: tell the client, then close. Reconnecting with the same
    // token now gets 401 — fetch a new one (POST /v1/stream/token) or sign in again.
    if (expiresAt) {
      const ms = Math.max(0, expiresAt.getTime() - Date.now());
      const t = setTimeout(() => {
        reply.raw.write(`event: reauth\ndata: ${JSON.stringify({ reason: "token_expired", expiresAt })}\n\n`);
        reply.raw.end();
      }, Math.min(ms, 2_147_000_000));
      reply.raw.on("close", () => clearTimeout(t));
    }
    await app.hub.add(account, filters, reply, last);
  });

  /** Short-lived token for `GET /v1/stream?token=` (valid on the stream only, ≤15 min, never longer than the session). */
  app.post("/stream/token", async (req) => {
    const account = requireAccount(req);
    const { token, expiresAt } = await issueStreamToken(account, req.sessionExpiresAt);
    return { token, expiresAt, url: `/v1/stream?token=${encodeURIComponent(token)}` };
  });

  /** Small status panel: indexer lag, queue depth, failed jobs, bridge transfers in flight, Tempo/MPP rails. */
  app.get("/status", async () => {
    const { env, network, relayBaseUrl } = await import("@builderos/shared");
    const e = env();
    const n = network();
    const db = getDb();
    const q = async (s: ReturnType<typeof sql>) => (await db.execute<any>(s).catch(() => ({ rows: [{}] }))).rows[0];
    const [lag, queue, failed, bridges, dead] = await Promise.all([
      indexerLag().catch(() => null),
      q(sql`select count(*)::int as n from pgboss.job where state in ('created','retry','active')`),
      q(sql`select count(*)::int as n from pgboss.job where state = 'failed' and completed_on > now() - interval '24 hours'`),
      q(sql`select count(*)::int as n from bridge_transfers where status in ('requested','bridging')`),
      q(sql`select count(*)::int as n from dead_letters where created_at > now() - interval '24 hours'`),
    ]);
    return {
      indexerLag: lag,
      queueDepth: queue?.n ?? null,
      failedJobs24h: failed?.n ?? null,
      bridgesInFlight: bridges?.n ?? 0,
      deadLetters24h: dead?.n ?? 0,
      sseClients: app.hub.size,
      tempo: {
        enabled: n.tempo.enabled,
        chainId: n.tempo.chainId,
        usdc: n.tempo.usdc,
        rpcUrl: n.tempo.rpcUrl,
        relayBaseUrl: relayBaseUrl(),
        relayApiKeySet: Boolean(e.RELAY_API_KEY),
        sellerMesh: Boolean(e.USE_SELLER_MESH),
      },
    };
  });
};

async function indexerLag() {
  const r = await getDb().execute<{ h: string }>(sql`select last_block_height::text as h from indexer_state where id = 'near'`);
  if (!r.rows[0]) return null;
  const head = (await finalBlock()).header.height as number;
  return head - Number(r.rows[0].h);
}

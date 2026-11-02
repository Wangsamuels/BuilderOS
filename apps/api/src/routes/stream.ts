import type { FastifyPluginAsync } from "fastify";
import { HttpError } from "@builderos/shared";
import { getDb, sql } from "@builderos/db";
import { finalBlock } from "@builderos/near";
import { originAllowed } from "../app.js";
import { requireAccount, visibleCompanies } from "../auth.js";

export const streamRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Live events (SSE), resumable by Last-Event-ID (header, or ?lastEventId= for the first connect).
   * Browser: new EventSource(`${API}/v1/stream`, { withCredentials: true })
   * Safari / no third-party cookies: new EventSource(`${API}/v1/stream?token=${token}`)
   */
  app.get<{ Querystring: { companyId?: string; lastEventId?: string; token?: string } }>("/stream", async (req, reply) => {
    const account = requireAccount(req);
    let companies = await visibleCompanies(account);
    if (req.query.companyId) {
      if (!companies.includes(req.query.companyId)) throw new HttpError(403, "not a member of this company");
      companies = [req.query.companyId];
    }
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

    const lag = await indexerLag().catch(() => null);
    if (lag != null && lag > 30) reply.raw.write(`event: status\ndata: ${JSON.stringify({ catchingUp: true, lag })}\n\n`);
    await app.hub.add(account, companies, reply, last);
  });

  /** Small status panel: indexer lag, queue depth, failed jobs, bridge transfers in flight. */
  app.get("/status", async () => {
    const db = getDb();
    const q = async (s: ReturnType<typeof sql>) => (await db.execute<any>(s).catch(() => ({ rows: [{}] }))).rows[0];
    const [lag, queue, failed, bridges, dead] = await Promise.all([
      indexerLag().catch(() => null),
      q(sql`select count(*)::int as n from pgboss.job where state in ('created','retry','active')`),
      q(sql`select count(*)::int as n from pgboss.job where state = 'failed' and completed_on > now() - interval '24 hours'`),
      q(sql`select count(*)::int as n from bridge_transfers where status in ('requested','bridging')`),
      q(sql`select count(*)::int as n from dead_letters where created_at > now() - interval '24 hours'`),
    ]);
    return { indexerLag: lag, queueDepth: queue?.n ?? null, failedJobs24h: failed?.n ?? null, bridgesInFlight: bridges?.n ?? 0, deadLetters24h: dead?.n ?? 0, sseClients: app.hub.size };
  });
};

async function indexerLag() {
  const r = await getDb().execute<{ h: string }>(sql`select last_block_height::text as h from indexer_state where id = 'near'`);
  if (!r.rows[0]) return null;
  const head = (await finalBlock()).header.height as number;
  return head - Number(r.rows[0].h);
}

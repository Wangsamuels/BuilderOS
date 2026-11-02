import pg from "pg";
import type { FastifyReply } from "fastify";
import { EVENTS_CHANNEL, getDb, pgConfig, sql } from "@builderos/db";
import type { Logger } from "@builderos/shared";

type Client = { id: number; account: string; companies: Set<string>; reply: FastifyReply };

/**
 * SSE fan-out. One dedicated Postgres connection LISTENs for event ids from the indexer;
 * each event is pushed to every connected client allowed to see that company.
 */
export class SseHub {
  private clients = new Map<number, Client>();
  private seq = 0;
  private listener?: pg.Client;
  private heartbeat?: NodeJS.Timeout;

  constructor(private log: Logger) {}

  async start() {
    await this.connect();
    // Heroku's router closes idle connections after 55s; ping every 20s.
    this.heartbeat = setInterval(() => {
      for (const c of this.clients.values()) c.reply.raw.write(`: ping ${Date.now()}\n\n`);
    }, 20_000);
  }

  private async connect() {
    const cfg = pgConfig();
    this.listener = new pg.Client({ connectionString: cfg.connectionString, ssl: cfg.ssl });
    this.listener.on("notification", (msg) => {
      if (msg.channel === EVENTS_CHANNEL && msg.payload) void this.dispatch(Number(msg.payload));
    });
    this.listener.on("error", (err) => {
      this.log.error({ err: err.message }, "SSE listener error; reconnecting");
      setTimeout(() => this.connect().catch(() => {}), 2000);
    });
    await this.listener.connect();
    await this.listener.query(`LISTEN ${EVENTS_CHANNEL}`);
  }

  async stop() {
    clearInterval(this.heartbeat);
    for (const c of this.clients.values()) c.reply.raw.end();
    await this.listener?.end().catch(() => {});
  }

  get size() {
    return this.clients.size;
  }

  private async dispatch(id: number) {
    if (!this.clients.size) return;
    const r = await getDb().execute<any>(sql`select id, event, company_id, department_id, data, near_tx, block_height, created_at from events where id = ${id}`);
    const ev = r.rows[0];
    if (!ev) return;
    for (const c of this.clients.values()) if (ev.company_id && c.companies.has(ev.company_id)) write(c.reply, ev);
  }

  /** Register a client and replay anything after lastEventId (resumable stream). */
  async add(account: string, companies: string[], reply: FastifyReply, lastEventId?: number) {
    const id = ++this.seq;
    const client: Client = { id, account, companies: new Set(companies), reply };
    reply.raw.on("close", () => this.clients.delete(id));
    if (lastEventId && companies.length) {
      const r = await getDb().execute<any>(
        sql`select id, event, company_id, department_id, data, near_tx, block_height, created_at from events
            where id > ${lastEventId} and company_id = any(${companies}) order by id limit 500`,
      );
      for (const ev of r.rows) write(reply, ev);
    }
    this.clients.set(id, client);
    return id;
  }

  /** Server-originated status (e.g. indexer catching up). */
  broadcastStatus(payload: unknown) {
    for (const c of this.clients.values()) c.reply.raw.write(`event: status\ndata: ${JSON.stringify(payload)}\n\n`);
  }
}

function write(reply: FastifyReply, ev: any) {
  const data = { id: Number(ev.id), event: ev.event, companyId: ev.company_id, departmentId: ev.department_id, data: ev.data, nearTx: ev.near_tx, blockHeight: Number(ev.block_height), at: ev.created_at };
  reply.raw.write(`id: ${ev.id}\nevent: ${ev.event}\ndata: ${JSON.stringify(data)}\n\n`);
}

import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import PgBoss from "pg-boss";
import { env } from "@builderos/shared";
import * as schema from "./schema.js";

export * from "./schema.js";
export { schema };
export { sql, eq, and, or, desc, asc, gt, lt, inArray, isNull } from "drizzle-orm";

export type DB = NodePgDatabase<typeof schema>;

let pool: pg.Pool | undefined;
let db: DB | undefined;

export function pgConfig(): pg.PoolConfig {
  const e = env();
  return {
    connectionString: e.DATABASE_URL,
    // Heroku Postgres uses self-signed certs.
    ssl: e.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
    // Essential-0 allows 20 connections total; web + worker + pg-boss share them.
    max: e.DB_POOL_MAX,
  };
}

export function getPool() {
  pool ??= new pg.Pool(pgConfig());
  return pool;
}

export function getDb(): DB {
  db ??= drizzle(getPool(), { schema });
  return db;
}

/** One pg-boss per process; its tables live in the `pgboss` schema (the `jobs` table in the data model). */
let boss: PgBoss | undefined;
export async function getBoss(): Promise<PgBoss> {
  if (!boss) {
    const e = env();
    boss = new PgBoss({
      connectionString: e.DATABASE_URL,
      ssl: e.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
      max: 3,
    });
    boss.on("error", (err) => console.error("pg-boss error", err));
    await boss.start();
    for (const q of Object.values(QUEUES)) await boss.createQueue(q);
  }
  return boss;
}

export const QUEUES = {
  task: "task.run",
  verify: "receipt.verify",
  notify: "notify.send",
  bridgeTopup: "bridge.topup",
  bridgeWithdraw: "bridge.withdraw",
  controller: "controller.sweep",
  leaderboard: "leaderboard.nightly",
} as const;

/** SSE fan-out channel (Postgres LISTEN/NOTIFY). Payload is the event row id. */
export const EVENTS_CHANNEL = "builderos_events";

export async function closeDb() {
  await boss?.stop({ graceful: true }).catch(() => {});
  await pool?.end().catch(() => {});
}

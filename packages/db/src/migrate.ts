import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { pgConfig } from "./index.js";

/** Runs on Heroku's release phase (Procfile `release:`) and locally via `pnpm db:migrate`. */
async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/../drizzle when run with tsx, dist/../drizzle when bundled.
  const migrationsFolder = [path.join(here, "../drizzle"), path.join(here, "../../drizzle")].find((p) => fs.existsSync(p));
  if (!migrationsFolder) throw new Error("migrations folder not found");
  const pool = new pg.Pool({ ...pgConfig(), max: 1 });
  await migrate(drizzle(pool), { migrationsFolder });
  await pool.end();
  console.log("migrations applied");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

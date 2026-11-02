import { createLogger, env } from "@builderos/shared";
import { closeDb } from "@builderos/db";
import { buildApp } from "./app.js";
import { SseHub } from "./sse.js";

const log = createLogger("api");

async function main() {
  const hub = new SseHub(log);
  await hub.start();
  const app = await buildApp({ log, hub });
  // Heroku assigns $PORT and requires binding 0.0.0.0 within 60s.
  await app.listen({ port: env().PORT, host: "0.0.0.0" });

  const shutdown = async (sig: string) => {
    log.info({ sig }, "shutting down");
    await hub.stop();
    await app.close();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM")); // Heroku sends SIGTERM on restart/deploy
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  log.fatal({ err: e?.message, stack: e?.stack }, "api failed to start");
  process.exit(1);
});

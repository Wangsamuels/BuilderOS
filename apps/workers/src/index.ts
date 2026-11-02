import { createLogger, env, network } from "@builderos/shared";
import { QUEUES, closeDb, companies, eq, getBoss, getDb, invites, sql, tasks } from "@builderos/db";
import { runIndexer, type IndexedEvent } from "@builderos/indexer";
import { readyTasks, markQueued, resumeForRequest, runTask } from "@builderos/orchestrator";
import { runTopup, runWithdrawal, scanFloats } from "@builderos/bridge";
import { alertFor, notify, type Alert } from "@builderos/notify";
import { onGrantRevoked } from "@builderos/keys";
import { submitVerdict, verifyReceipt } from "@builderos/verifier";
import { deserialize, openString, serverKey } from "@builderos/crypto";

/**
 * One Node process on the Heroku worker dyno. Each service is a module with its own loop:
 * indexer · orchestrator (scheduler + task jobs) · bridge worker · notify · verifier · controller.
 */
const log = createLogger("workers");
const abort = new AbortController();

async function main() {
  const boss = await getBoss();
  const retry = { retryLimit: 8, retryDelay: 15, retryBackoff: true }; // backoff up to ~30 min

  // ---------- event router (indexer → other services) ----------
  async function onEvent(e: IndexedEvent) {
    const d = e.data;
    switch (e.event) {
      case "task_assigned":
        await getDb().update(tasks).set({ status: "assigned", updatedAt: new Date() }).where(eq(tasks.id, d.task_id));
        break;
      case "purchase_approved":
        await resumeForRequest(d.request_id, log);
        break;
      case "withdrawal_requested":
        await boss.send(QUEUES.bridgeWithdraw, { withdrawalId: d.withdrawal_id, companyId: d.company_id, amount: String(d.amount), token: d.token, to: d.to, chain: d.chain }, { ...retry, singletonKey: d.withdrawal_id });
        break;
      case "grant_revoked": {
        if (!e.companyId) break;
        const [c] = await getDb().select().from(companies).where(eq(companies.id, e.companyId));
        await onGrantRevoked({ companyId: e.companyId, account: d.account_id, founder: c?.founderAccount });
        break;
      }
      case "member_invited": {
        // The founder confirmed on chain → now send the invite email.
        if (!d.invite_hash) break;
        const [inv] = await getDb().select().from(invites).where(eq(invites.codeHash, d.invite_hash));
        if (inv?.emailCiphertext && inv.status === "pending_confirmation") {
          const { email, code } = JSON.parse(await openString(deserialize(inv.emailCiphertext), serverKey(env().SESSION_SECRET), "invite"));
          const link = `${env().WEB_ORIGIN.split(",")[0]}/invite?code=${encodeURIComponent(code)}`;
          await boss.send(QUEUES.notify, {
            alert: { kind: "invite", companyId: inv.companyId, title: "You're invited", body: link, to: [], email: { to: email, subject: "You've been invited to a BuilderOS company", text: `Accept here: ${link}` } } satisfies Alert,
          }, retry);
          await getDb().update(invites).set({ status: "sent" }).where(eq(invites.id, inv.id));
        }
        break;
      }
    }
    if (e.receiptRowId && d.foreign_tx) await boss.send(QUEUES.verify, { receiptId: e.receiptRowId }, { ...retry, singletonKey: e.receiptRowId });
    const alert = alertFor(e.event, d, e.companyId, env().WEB_ORIGIN);
    if (alert) await boss.send(QUEUES.notify, { alert }, retry);
  }

  // ---------- workers ----------
  await boss.work<{ taskId: string }>(QUEUES.task, { batchSize: 1 }, async ([job]) => {
    const res = await runTask(job.data.taskId, log);
    if (res?.status === "review") {
      const [t] = await getDb().select().from(tasks).where(eq(tasks.id, job.data.taskId));
      if (t?.departmentId) {
        try {
          await submitVerdict({ departmentId: t.departmentId, taskId: t.id, verdict: "pass", logHash: res.logHash ?? "" });
        } catch (e: any) {
          log.warn({ err: e?.message, task: t.id }, "verdict not submitted (verifier key missing?)");
        }
      }
      await getDb().update(tasks).set({ status: "done", updatedAt: new Date() }).where(eq(tasks.id, job.data.taskId));
    }
  });
  await boss.work<{ receiptId: string }>(QUEUES.verify, async ([job]) => verifyReceipt(job.data.receiptId, log));
  await boss.work<{ alert: Alert }>(QUEUES.notify, async ([job]) => notify(job.data.alert, log));
  await boss.work<{ jobId: string; departmentId: string; amount: string }>(QUEUES.bridgeTopup, async ([job]) => {
    await runTopup(job.data, log);
  });
  await boss.work<any>(QUEUES.bridgeWithdraw, async ([job]) => {
    await runWithdrawal(job.data, log);
  });
  await boss.work(QUEUES.controller, async () => controllerSweep());
  await boss.work(QUEUES.leaderboard, async () => leaderboardNightly());
  await boss.schedule(QUEUES.controller, "*/15 * * * *");
  await boss.schedule(QUEUES.leaderboard, "30 2 * * *");

  // ---------- loops ----------
  // Orchestrator scheduler: hand ready DAG nodes to the queue.
  every(5_000, async () => {
    for (const id of await readyTasks()) {
      await boss.send(QUEUES.task, { taskId: id }, { retryLimit: 2, retryDelay: 30, singletonKey: `task:${id}`, expireInSeconds: 30 * 60 });
      await markQueued(id);
    }
  });
  // Bridge worker: every minute.
  every(60_000, async () => {
    await scanFloats(log, async (departmentId, amount) => {
      const jobId = `topup:${departmentId}:${Date.now()}`;
      await boss.send(QUEUES.bridgeTopup, { jobId, departmentId, amount: amount.toString() }, { ...retry, singletonKey: `topup:${departmentId}` });
    });
  });

  log.info({ network: network().id, factory: network().factory }, "workers started");
  await runIndexer({ log, onEvent }, abort.signal);
}

function every(ms: number, fn: () => Promise<void>) {
  let running = false;
  const t = setInterval(async () => {
    if (running || abort.signal.aborted) return;
    running = true;
    try {
      await fn();
    } catch (e: any) {
      log.error({ err: e?.message }, "loop error");
    } finally {
      running = false;
    }
  }, ms);
  abort.signal.addEventListener("abort", () => clearInterval(t));
}

/** Controller (every 15 min): match receipts to outcomes, mark refund candidates, flag unused services. */
async function controllerSweep() {
  const db = getDb();
  await db.execute(sql`
    update receipts r set payload = r.payload || '{"refund_candidate": true}'::jsonb
    where r.kind = 'purchase' and r.payload->>'stage' = 'settled'
      and r.payload->>'outcome' is not null and r.payload->>'outcome' <> 'ok'
      and not (r.payload ? 'refund_candidate')`);
  await db.execute(sql`update services set status = 'flagged_unused' where status = 'active' and (last_used_at is null or last_used_at < now() - interval '14 days')`);
}

/** Nightly: pass rate and cost per pass by tag × tier × model, from our own receipts. */
async function leaderboardNightly() {
  await getDb().execute(sql`
    insert into leaderboard_stats (tag, tier, model_or_seller, tasks, passed, cost_per_pass, pass_rate, updated_at)
    select t.tag, t.tier, mc.model,
      count(distinct t.id)::int,
      count(distinct t.id) filter (where t.status = 'done')::int,
      case when count(distinct t.id) filter (where t.status = 'done') > 0
        then round(sum(coalesce(mc.cost,0)) / count(distinct t.id) filter (where t.status = 'done')) end,
      (count(distinct t.id) filter (where t.status = 'done'))::real / greatest(count(distinct t.id), 1),
      now()
    from model_calls mc join tasks t on t.id = mc.task_id
    group by t.tag, t.tier, mc.model
    on conflict (tag, tier, model_or_seller) do update set tasks = excluded.tasks, passed = excluded.passed,
      cost_per_pass = excluded.cost_per_pass, pass_rate = excluded.pass_rate, updated_at = now()`);
}

const shutdown = async (sig: string) => {
  log.info({ sig }, "workers shutting down");
  abort.abort();
  await closeDb();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((e) => {
  log.fatal({ err: e?.message, stack: e?.stack }, "workers crashed");
  process.exit(1);
});

import { type Logger } from "@builderos/shared";
import { eq, getDb, sql, tasks } from "@builderos/db";

export * from "./keystore.js";
export * from "./planner.js";
export * from "./runner.js";

/**
 * Scheduler: an approved plan is a DAG in `tasks` (depends_on). Tasks whose deps are all done and that
 * the contract has accepted (status assigned/ready) go to the job queue for their role.
 */
export async function readyTasks(): Promise<string[]> {
  const r = await getDb().execute<{ id: string }>(sql`
    select t.id from tasks t
    where t.status in ('assigned','ready')
      and not exists (
        select 1 from jsonb_array_elements_text(t.depends_on) dep
        join tasks d on d.id = dep where d.status <> 'done'
      )
    order by t.created_at limit 50`);
  return r.rows.map((x) => x.id);
}

export async function markQueued(id: string) {
  await getDb().update(tasks).set({ status: "queued", updatedAt: new Date() }).where(eq(tasks.id, id));
}

/** Resume tasks parked on a purchase once its approval lands. */
export async function resumeForRequest(requestId: string, log: Logger) {
  const r = await getDb().execute<{ id: string }>(
    sql`update tasks set status = 'ready', pause_reason = null, updated_at = now() where status = 'paused' and pause_reason = ${`purchase:${requestId}`} returning id`,
  );
  if (r.rows.length) log.info({ requestId, tasks: r.rows.map((x) => x.id) }, "resumed tasks after approval");
}

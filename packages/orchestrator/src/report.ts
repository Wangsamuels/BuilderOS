import { and, eq, EVENTS_CHANNEL, events, getDb, gte, modelCalls, sql, taskReports, tasks } from "@builderos/db";

/**
 * Agent work reports. One per task attempt, written by the runner from records — the task row, the model
 * calls it paid for, the files it wrote, the checks, the cross-lab review and the commit. `summary` is the
 * agent's own short summary (labelled as such); every number in a report comes from `facts`, never a model.
 */

export type ReportOutcome = "done" | "needs_review" | "retrying" | "paused" | "failed";

export type ReportInput = {
  outcome: ReportOutcome;
  /** The agent's own summary of its change (from its reply), if it gave one. */
  summary?: string | null;
  files?: string[];
  checks?: { passed: boolean; errors: string[] } | null;
  review?: { verdict: "pass" | "fail" | "skipped"; model?: string | null; reasons?: string[] } | null;
  generator?: { model: string; provider: string; rail: string } | null;
  commitSha?: string | null;
  /** Why the task stopped (approval needed, purchase rejected, error). */
  reason?: string | null;
  error?: string | null;
  /** Attempt start (ms): model calls from here on are this attempt's. */
  startedAt?: number;
  hired?: { agentId: string; amount?: string | null } | null;
};

const clip = (s: string | null | undefined, n: number) => (s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null);

/** Facts about model spend for a task (this attempt when `since` is given). */
async function spendFacts(taskId: string, since?: number) {
  const db = getDb();
  const rows = await db
    .select()
    .from(modelCalls)
    .where(since ? and(eq(modelCalls.taskId, taskId), gte(modelCalls.createdAt, new Date(since - 1000))) : eq(modelCalls.taskId, taskId));
  const byModel = new Map<string, { model: string; provider: string; calls: number; failed: number; cost: bigint; tokensIn: number; tokensOut: number }>();
  for (const r of rows) {
    const m = byModel.get(r.model) ?? { model: r.model, provider: r.provider, calls: 0, failed: 0, cost: 0n, tokensIn: 0, tokensOut: 0 };
    m.calls++;
    if (r.outcome !== "ok") m.failed++;
    m.cost += BigInt(r.cost ?? "0");
    m.tokensIn += r.tokensIn ?? 0;
    m.tokensOut += r.tokensOut ?? 0;
    byModel.set(r.model, m);
  }
  const models = [...byModel.values()].map((m) => ({ ...m, cost: m.cost.toString() }));
  const cost = [...byModel.values()].reduce((a, m) => a + m.cost, 0n);
  const receiptIds = rows.map((r) => r.receiptId).filter(Boolean) as string[];
  return { models, cost, receiptIds };
}

/** "Rewrote the login API" — what to say when the agent gave no summary. */
function fallbackSummary(title: string, i: ReportInput) {
  switch (i.outcome) {
    case "done":
    case "needs_review":
      return `Finished "${title}"${i.files?.length ? ` (${i.files.length} file${i.files.length === 1 ? "" : "s"})` : ""}.`;
    case "retrying":
      return `"${title}" didn't pass ${i.checks && !i.checks.passed ? "its checks" : "review"}; the agent will try again.`;
    case "paused":
      return `"${title}" is waiting: ${i.reason ?? "paused"}.`;
    case "failed":
      return `"${title}" stopped: ${i.reason ?? i.error ?? "failed"}.`;
  }
}

/** Write (or update) the report for the task's current attempt and tell live dashboards. */
export async function recordTaskReport(taskId: string, input: ReportInput) {
  const db = getDb();
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t) return null;
  const attempt = Math.max(1, t.attempts);
  const spend = await spendFacts(taskId, input.startedAt);
  const total = input.startedAt ? await spendFacts(taskId) : spend;
  const facts = {
    files: input.files ?? [],
    checks: input.checks ?? null,
    review: input.review ?? null,
    generator: input.generator ?? null,
    commitSha: input.commitSha ?? null,
    reason: input.reason ?? null,
    error: clip(input.error, 300),
    models: spend.models,
    receipts: spend.receiptIds,
    hired: input.hired ?? null,
    attempt,
    attempts: t.attempts,
    tier: t.tier,
    size: t.size,
    estimate: { p50: t.estP50, p90: t.estP90, cap: t.cap },
    taskCostSoFar: total.cost.toString(),
    durationMs: input.startedAt ? Date.now() - input.startedAt : null,
  };
  const values = {
    taskId,
    attempt,
    planId: t.planId,
    companyId: t.companyId,
    departmentId: t.departmentId,
    title: t.title,
    tag: t.tag,
    outcome: input.outcome,
    agent: t.agent,
    summary: clip(input.summary?.trim() || fallbackSummary(t.title, input), 1200),
    facts,
    cost: spend.cost.toString(),
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(taskReports)
    .values(values)
    .onConflictDoUpdate({ target: [taskReports.taskId, taskReports.attempt], set: values })
    .returning();
  await publishReport(row.id, t.companyId, t.departmentId, { report_id: row.id, task_id: taskId, title: t.title, outcome: input.outcome, attempt, cost: values.cost });
  return row;
}

/** The task finished (verdict submitted): mark the latest report done, or write a minimal one (hired agents). */
export async function finalizeTaskReport(taskId: string, outcome: ReportOutcome = "done") {
  const db = getDb();
  const r = await db.execute<{ id: string; company_id: string; department_id: string | null; title: string; attempt: number; cost: string | null }>(sql`
    update task_reports set outcome = ${outcome}, updated_at = now()
    where id = (select id from task_reports where task_id = ${taskId} order by attempt desc limit 1)
    returning id, company_id, department_id, title, attempt, cost::text`);
  const row = r.rows[0];
  if (!row) return recordTaskReport(taskId, { outcome });
  await publishReport(row.id, row.company_id, row.department_id, { report_id: row.id, task_id: taskId, title: row.title, outcome, attempt: row.attempt, cost: row.cost });
  return row;
}

/** Live update: an off-chain `task_reported` event on the same stream as chain events (builder scope). */
async function publishReport(reportId: string, companyId: string, departmentId: string | null, data: Record<string, unknown>) {
  const db = getDb();
  const [ev] = await db
    .insert(events)
    .values({
      event: "task_reported",
      standard: "builderos",
      version: "1.0.0",
      contract: "builderos-api",
      companyId,
      departmentId,
      data: { ...data, company_id: companyId, department_id: departmentId },
      receiptId: `report:${reportId}:${Date.now()}`,
      logIndex: 0,
    })
    .returning({ id: events.id })
    .catch(() => [] as Array<{ id: number }>);
  if (ev) await db.execute(sql`select pg_notify(${EVENTS_CHANNEL}, ${String(ev.id)})`).catch(() => {});
}

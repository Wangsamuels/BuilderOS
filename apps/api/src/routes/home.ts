import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env, HttpError } from "@builderos/shared";
import { and, approvalCards, desc, eq, getDb, inArray, inboxReads, invites, isNull, notifications, plans, sql, taskReports } from "@builderos/db";
import { deserialize, openString, serverKey } from "@builderos/crypto";
import { companySlug, normalizeCompanyId, tx } from "@builderos/near";
import { accessFor, authorize, companiesFor, linkCompany, requireAccount, type Access } from "../auth.js";
import { parse } from "../app.js";
import { emailStatus, getPrefs, verifiedEmailHash } from "../account.js";
import { draftView } from "../drafts.js";
import { companySnapshot, forgetSnapshot, teamSnapshot } from "../snapshot.js";
import { demoBundle, demoReport } from "../demo.js";

/**
 * The signed-in home: portfolio overview, per-company analytics, agent reports grouped by team, and one inbox
 * across companies. Every company is re-checked on chain, and every section is cut to what the grant covers:
 * money for view/approve, work for builder, approvals for approve; founder/admin see all.
 */

const canMoney = (a: Access) => a.admin || a.scopes.has("view") || a.scopes.has("approve");
const canWork = (a: Access) => a.admin || a.scopes.has("builder") || a.scopes.has("code");
const canApprove = (a: Access) => a.admin || a.scopes.has("approve");
const role = (a: Access) => (a.founder ? "founder" : a.admin ? "admin" : "member");
const sum = (xs: Array<string | bigint | null | undefined>) => xs.reduce<bigint>((a, x) => a + BigInt(x ?? 0), 0n);
const DAY = 86_400_000;
/** `(a, b, c)` as bound parameters (never spliced into the SQL text). */
const list = (xs: string[]) => sql`(${sql.join(xs.map((x) => sql`${x}`), sql`, `)})`;

function rangeDays(r: string | undefined) {
  const m = /^(\d{1,3})d$/.exec(r ?? "30d");
  const n = m ? Number(m[1]) : 30;
  if (![7, 14, 30, 90].includes(n)) throw new HttpError(400, "range must be 7d, 14d, 30d or 90d", "invalid_request");
  return n;
}

/** Team filter for a request: the grant's own team for team-limited members, else the asked team (name or id). */
function teamFilter(access: Access, companyId: string, team?: string): string[] | null {
  const asked = team ? (team.includes(".") ? team.toLowerCase() : `${team.toLowerCase()}.${companyId}`) : null;
  if (access.departmentId) {
    if (asked && asked !== access.departmentId) throw new HttpError(403, "Your access covers another team.", "forbidden", { departmentId: access.departmentId });
    return [access.departmentId];
  }
  return asked ? [asked] : null;
}

/** Strip a report to what this grant may see: work detail for builders, money for view/approve. */
function reportFor(a: Access, r: typeof taskReports.$inferSelect) {
  const f = (r.facts ?? {}) as Record<string, any>;
  const money = canMoney(a);
  const work = canWork(a);
  return {
    id: r.id,
    taskId: r.taskId,
    attempt: r.attempt,
    planId: r.planId,
    departmentId: r.departmentId,
    team: r.departmentId ? r.departmentId.split(".")[0] : null,
    title: r.title,
    tag: r.tag,
    outcome: r.outcome,
    agent: r.agent,
    /** Written by the agent about its own work. Numbers below come from records, not the agent. */
    summary: r.summary,
    summarySource: "agent",
    cost: money ? (r.cost ?? "0") : null,
    facts: {
      ...(work
        ? { files: f.files ?? [], checks: f.checks ?? null, review: f.review ?? null, commitSha: f.commitSha ?? null, generator: f.generator ?? null, hired: f.hired ?? null }
        : {}),
      ...(money ? { models: f.models ?? [], receipts: f.receipts ?? [], estimate: f.estimate ?? null, taskCostSoFar: f.taskCostSoFar ?? null } : {}),
      reason: f.reason ?? null,
      error: work ? (f.error ?? null) : null,
      attempt: f.attempt ?? r.attempt,
      durationMs: f.durationMs ?? null,
      tier: f.tier ?? null,
    },
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function headline(c: { done: number; needsReview: number; retrying: number; paused: number; failed: number }, cost: bigint | null, days: number) {
  const parts = [
    c.done ? `${c.done} done` : null,
    c.needsReview ? `${c.needsReview} in review` : null,
    c.retrying ? `${c.retrying} retrying` : null,
    c.paused ? `${c.paused} waiting on you` : null,
    c.failed ? `${c.failed} failed` : null,
  ].filter(Boolean);
  const money = cost === null ? "" : ` · $${(Number(cost) / 1e6).toFixed(2)} spent`;
  return parts.length ? `${parts.join(" · ")}${money} in the last ${days} days` : `No agent work in the last ${days} days`;
}

export const homeRoutes: FastifyPluginAsync = async (app) => {
  // ---------- overview ----------
  /** Home screen: every company the account can open, with the numbers its grant covers, plus drafts and inbox count. */
  app.get<{ Querystring: { fresh?: string } }>("/overview", async (req) => {
    const account = requireAccount(req);
    const db = getDb();
    const memberships = await companiesFor(account);
    const ids = memberships.map((m) => m.companyId);
    // Chain numbers are cached ~8 s across companies; ?fresh=1 (e.g. right after signing) re-reads them.
    if (req.query.fresh === "1" || req.query.fresh === "true") for (const id of ids) forgetSnapshot(id);
    const since = new Date(Date.now() - 7 * DAY);

    const [taskCounts, reportRows, approvalRows] = ids.length
      ? await Promise.all([
          db.execute<{ company_id: string; department_id: string | null; status: string; n: number }>(
            sql`select company_id, department_id, status, count(*)::int as n from tasks where company_id in ${list(ids)} group by 1, 2, 3`,
          ),
          db.select().from(taskReports).where(and(inArray(taskReports.companyId, ids), sql`${taskReports.createdAt} > ${since}`)).orderBy(desc(taskReports.createdAt)).limit(500),
          db.select().from(approvalCards).where(and(inArray(approvalCards.companyId, ids), eq(approvalCards.status, "pending"))),
        ])
      : [{ rows: [] }, [], []];

    const companies = await Promise.all(
      memberships.map(async (m) => {
        const access = await accessFor(account, m.companyId);
        if (!access) return null;
        const [co, teams] = await Promise.all([companySnapshot(m.companyId), teamSnapshot(m.companyId)]);
        const mine = (d: string | null) => !access.departmentId || d === access.departmentId;
        const visibleTeams = teams.filter((t) => mine(t.departmentId));
        const tc = taskCounts.rows.filter((r) => r.company_id === m.companyId && mine(r.department_id));
        const tasksByStatus: Record<string, number> = {};
        for (const r of tc) tasksByStatus[r.status] = (tasksByStatus[r.status] ?? 0) + r.n;
        const reps = reportRows.filter((r) => r.companyId === m.companyId && mine(r.departmentId));
        const appr = approvalRows.filter(
          (c) => c.companyId === m.companyId && (!access.departmentId || (c.payload as any)?.department_id === access.departmentId || (c.payload as any)?.departmentId === access.departmentId),
        );
        return {
          companyId: m.companyId,
          slug: m.slug,
          name: m.name ?? co.name,
          role: role(access),
          scopes: [...access.scopes].sort(),
          departmentId: access.departmentId,
          frozen: co.frozen,
          teams: visibleTeams.map((t) => ({ name: t.name, departmentId: t.departmentId, frozen: t.frozen })),
          money: canMoney(access)
            ? {
                dailyCap: co.dailyCap,
                spentToday: co.spentToday,
                budget: sum(visibleTeams.map((t) => t.budget)).toString(),
                spent: sum(visibleTeams.map((t) => t.spent)).toString(),
                reserved: sum(visibleTeams.map((t) => t.reserved)).toString(),
                available: sum(visibleTeams.map((t) => t.available)).toString(),
              }
            : null,
          work: canWork(access)
            ? {
                tasks: tasksByStatus,
                reportsThisWeek: reps.length,
                needsAttention: reps.filter((r) => r.outcome === "paused" || r.outcome === "failed").length,
                lastReport: reps[0] ? reportFor(access, reps[0]) : null,
              }
            : null,
          approvals: canApprove(access) ? { pending: appr.length, oldestAt: appr.map((c) => c.createdAt).sort((a, b) => +a - +b)[0] ?? null } : null,
        };
      }),
    );
    const shown = companies.filter((c): c is NonNullable<typeof c> => c !== null);
    const draftRows = await db.select().from(plans).where(and(eq(plans.createdBy, account), isNull(plans.companyId))).orderBy(desc(plans.updatedAt)).limit(20);
    const prefs = await getPrefs(account);
    const openCompanyId = typeof prefs.lastCompanyId === "string" && ids.includes(prefs.lastCompanyId) ? prefs.lastCompanyId : (ids[0] ?? null);
    const money = shown.filter((c) => c.money);
    return {
      accountId: account,
      units: "micro-USDC",
      home: { view: shown.length ? "overview" : "welcome", openCompanyId, demo: env().DEMO_ENABLED ? "/v1/demo" : null },
      email: await emailStatus(account),
      totals: {
        companies: shown.length,
        founded: shown.filter((c) => c.role === "founder").length,
        spentToday: sum(money.map((c) => c.money!.spentToday)).toString(),
        budget: sum(money.map((c) => c.money!.budget)).toString(),
        spent: sum(money.map((c) => c.money!.spent)).toString(),
        pendingApprovals: shown.reduce((a, c) => a + (c.approvals?.pending ?? 0), 0),
        tasksRunning: shown.reduce((a, c) => a + (c.work ? (c.work.tasks.running ?? 0) + (c.work.tasks.queued ?? 0) : 0), 0),
        tasksDone: shown.reduce((a, c) => a + (c.work?.tasks.done ?? 0), 0),
        needsAttention: shown.reduce((a, c) => a + (c.work?.needsAttention ?? 0), 0),
      },
      companies: shown,
      drafts: await Promise.all(draftRows.map(async (d) => {
        const v = await draftView(d);
        return { id: v.id, title: v.title, status: v.status, estimate: v.estimate, features: v.features.length, updatedAt: v.updatedAt };
      })),
      inbox: { unread: (await inboxItems(account, 200)).filter((i) => !i.read).length },
    };
  });

  // ---------- analytics ----------
  app.get<{ Querystring: { companyId?: string; range?: string; team?: string } }>("/analytics", async (req) => {
    const account = requireAccount(req);
    const companyId = req.query.companyId;
    if (!companyId) throw new HttpError(400, "companyId required", "invalid_request");
    const access = await authorize(account, companyId, ["view", "approve", "builder", "code"]);
    const days = rangeDays(req.query.range);
    const depts = teamFilter(access, companyId, req.query.team);
    const db = getDb();
    forgetSnapshot(companyId); // one company: always read its numbers fresh from chain
    const from = new Date(Math.floor((Date.now() - (days - 1) * DAY) / DAY) * DAY); // start of the first day (UTC)
    const dayList = Array.from({ length: days }, (_, i) => new Date(from.getTime() + i * DAY).toISOString().slice(0, 10));
    const deptSql = depts ? sql` and department_id in ${list(depts)}` : sql``;
    const [co, allTeams] = await Promise.all([companySnapshot(companyId), teamSnapshot(companyId)]);
    const teams = allTeams.filter((t) => !depts || depts.includes(t.departmentId));
    const nameOf = (d: string | null) => (d ? (allTeams.find((t) => t.departmentId === d)?.name ?? d.split(".")[0]) : "company");

    let money = null;
    if (canMoney(access)) {
      // Signed payments (payment_signed → receipt kind purchase, stage signed) are what agents spent.
      const spend = (
        await db.execute<{ day: string; department_id: string | null; amount: string; model: string | null; seller: string | null; n: number }>(sql`
          select to_char(date_trunc('day', created_at at time zone 'UTC'), 'YYYY-MM-DD') as day, department_id,
                 coalesce(sum(amount), 0)::text as amount, payload->>'model' as model, payload->>'seller' as seller, count(*)::int as n
          from receipts where company_id = ${companyId} and kind = 'purchase' and payload->>'stage' = 'signed'
            and created_at >= ${from}${deptSql}
          group by 1, 2, 4, 5`)
      ).rows;
      const byDay = dayList.map((day) => {
        const rows = spend.filter((r) => r.day === day);
        return { day, total: sum(rows.map((r) => r.amount)).toString(), byTeam: Object.fromEntries(teams.map((t) => [t.name, sum(rows.filter((r) => r.department_id === t.departmentId).map((r) => r.amount)).toString()])) };
      });
      const group = (key: "model" | "seller") => {
        const m = new Map<string, { amount: bigint; purchases: number }>();
        for (const r of spend) {
          const k = r[key] ?? "unknown";
          const v = m.get(k) ?? { amount: 0n, purchases: 0 };
          v.amount += BigInt(r.amount);
          v.purchases += r.n;
          m.set(k, v);
        }
        return [...m.entries()].map(([k, v]) => ({ [key]: k, amount: v.amount.toString(), purchases: v.purchases })).sort((a, b) => Number(BigInt(b.amount) - BigInt(a.amount)));
      };
      const total = sum(spend.map((r) => r.amount));
      money = {
        total: total.toString(),
        byDay,
        byTeam: teams.map((t) => {
          const inRange = sum(spend.filter((r) => r.department_id === t.departmentId).map((r) => r.amount));
          const burnPerDay = inRange / BigInt(days);
          return {
            team: t.name,
            departmentId: t.departmentId,
            spentInRange: inRange.toString(),
            budget: t.budget,
            spent: t.spent,
            reserved: t.reserved,
            available: t.available,
            perTxLimit: t.perTxLimit,
            frozen: t.frozen,
            burnPerDay: burnPerDay.toString(),
            /** Days until this team's budget runs out at the range's average pace (null = no spending). */
            runwayDays: burnPerDay > 0n ? Number(BigInt(t.available) / burnPerDay) : null,
          };
        }),
        byModel: group("model"),
        bySeller: group("seller"),
        dailyCap: access.departmentId ? null : { cap: co.dailyCap, spentToday: co.spentToday, usedPct: BigInt(co.dailyCap) > 0n ? Math.round((Number(co.spentToday) / Number(co.dailyCap)) * 100) : null },
      };
    }

    let work = null;
    if (canWork(access)) {
      const statusRows = (
        await db.execute<{ department_id: string | null; status: string; n: number }>(
          sql`select department_id, status, count(*)::int as n from tasks where company_id = ${companyId}${deptSql} group by 1, 2`,
        )
      ).rows;
      const reports = await db
        .select()
        .from(taskReports)
        .where(
          and(
            eq(taskReports.companyId, companyId),
            sql`${taskReports.updatedAt} >= ${from}`,
            depts ? inArray(taskReports.departmentId, depts) : sql`true`,
          ),
        );
      const done = reports.filter((r) => r.outcome === "done");
      const reviewed = reports.map((r) => (r.facts as any)?.review?.verdict).filter((v) => v === "pass" || v === "fail");
      const doneTasks = done.length
        ? (await db.execute<{ id: string; est: string | null }>(sql`select id, est_p50::text as est from tasks where id in ${list([...new Set(done.map((r) => r.taskId))])}`)).rows
        : [];
      const actual = sum(done.map((r) => (r.facts as any)?.taskCostSoFar ?? r.cost ?? "0"));
      work = {
        tasksByTeam: teams.map((t) => ({ team: t.name, departmentId: t.departmentId, ...Object.fromEntries(statusRows.filter((r) => r.department_id === t.departmentId).map((r) => [r.status, r.n])) })),
        tasks: statusRows.reduce<Record<string, number>>((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + r.n }), {}),
        completedByDay: dayList.map((day) => ({ day, done: done.filter((r) => r.updatedAt.toISOString().slice(0, 10) === day).length })),
        reviewPassRate: reviewed.length ? reviewed.filter((v) => v === "pass").length / reviewed.length : null,
        reviewed: reviewed.length,
        ...(canMoney(access)
          ? {
              costPerDoneTask: done.length ? (actual / BigInt(done.length)).toString() : null,
              estimateVsActual: { estimated: sum(doneTasks.map((t) => t.est)).toString(), actual: actual.toString(), tasks: done.length },
            }
          : {}),
      };
    }

    let control = null;
    if (canApprove(access)) {
      const cards = await db.select().from(approvalCards).where(eq(approvalCards.companyId, companyId));
      const mineCard = (c: (typeof cards)[number]) => !depts || depts.includes((c.payload as any)?.department_id ?? (c.payload as any)?.departmentId ?? "");
      const pending = cards.filter((c) => c.status === "pending" && mineCard(c));
      const blocked = (
        await db.execute<{ n: number }>(sql`
          select count(*)::int as n from events where company_id = ${companyId} and event = 'purchase_rejected'
            and (data->>'reason' in ('payee_mismatch', 'attack') or data->>'blocked' = 'true') and created_at >= ${from}${deptSql}`)
      ).rows[0]?.n ?? 0;
      control = {
        approvals: {
          pending: pending.length,
          oldestPendingAt: pending.map((c) => c.createdAt).sort((a, b) => +a - +b)[0] ?? null,
          decidedInRange: cards.filter((c) => c.status !== "pending" && c.createdAt >= from && mineCard(c)).length,
        },
        blockedPurchases: blocked,
        pausedTeams: teams.filter((t) => t.frozen).map((t) => t.name),
        companyFrozen: co.frozen,
      };
    }

    return {
      companyId,
      slug: companySlug(companyId),
      range: { days, from: dayList[0], to: dayList[dayList.length - 1] },
      units: "micro-USDC",
      teams: teams.map((t) => ({ name: t.name, departmentId: t.departmentId })),
      /** Which sections this grant covers (the others are null). */
      sections: { money: money !== null, work: work !== null, control: control !== null },
      money,
      work,
      control,
      generatedAt: new Date().toISOString(),
      teamName: depts?.length === 1 ? nameOf(depts[0]) : null,
    };
  });

  // ---------- reports (grouped by team) ----------
  app.get<{ Querystring: { companyId?: string; team?: string; days?: string; limit?: string; outcome?: string } }>("/reports", async (req) => {
    const account = requireAccount(req);
    const companyId = req.query.companyId;
    if (!companyId) throw new HttpError(400, "companyId required", "invalid_request");
    const access = await authorize(account, companyId, ["view", "approve", "builder", "code"]);
    const depts = teamFilter(access, companyId, req.query.team);
    const days = Math.min(Math.max(Number(req.query.days ?? 7) || 7, 1), 90);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 20) || 20, 1), 100);
    const since = new Date(Date.now() - days * DAY);
    const outcomes = req.query.outcome?.split(",").filter(Boolean);
    const teams = (await teamSnapshot(companyId)).filter((t) => !depts || depts.includes(t.departmentId));
    const rows = await getDb()
      .select()
      .from(taskReports)
      .where(
        and(
          eq(taskReports.companyId, companyId),
          sql`${taskReports.updatedAt} >= ${since}`,
          depts ? inArray(taskReports.departmentId, depts) : sql`true`,
          outcomes?.length ? inArray(taskReports.outcome, outcomes) : sql`true`,
        ),
      )
      .orderBy(desc(taskReports.updatedAt))
      .limit(2000);
    const money = canMoney(access);
    const group = (deptId: string | null, name: string) => {
      const mine = rows.filter((r) => r.departmentId === deptId);
      const c = { done: 0, needsReview: 0, retrying: 0, paused: 0, failed: 0 };
      for (const r of mine) {
        if (r.outcome === "done") c.done++;
        else if (r.outcome === "needs_review") c.needsReview++;
        else if (r.outcome === "retrying") c.retrying++;
        else if (r.outcome === "paused") c.paused++;
        else if (r.outcome === "failed") c.failed++;
      }
      const cost = money ? sum(mine.map((r) => r.cost)) : null;
      return {
        team: name,
        departmentId: deptId,
        summary: { days, ...c, reports: mine.length, cost: cost?.toString() ?? null, headline: headline(c, cost, days) },
        reports: mine.slice(0, limit).map((r) => reportFor(access, r)),
      };
    };
    const out = teams.map((t) => group(t.departmentId, t.name));
    // Reports from a team that's no longer listed on chain (or tasks with no team) stay visible to company-wide grants.
    const known = new Set(teams.map((t) => t.departmentId));
    const strays = [...new Set(rows.map((r) => r.departmentId).filter((d) => !known.has(d as string)))];
    if (!depts) for (const d of strays) out.push(group(d, d ? d.split(".")[0] : "unassigned"));
    return { companyId, units: "micro-USDC", days, groupBy: "team", teams: out };
  });

  app.get<{ Params: { id: string } }>("/reports/:id", async (req) => {
    const account = requireAccount(req);
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, "report not found", "not_found");
    const [r] = await getDb().select().from(taskReports).where(eq(taskReports.id, req.params.id));
    if (!r) throw new HttpError(404, "report not found", "not_found");
    const access = await authorize(account, r.companyId, ["view", "approve", "builder", "code"], r.departmentId);
    if (access.departmentId && r.departmentId !== access.departmentId) throw new HttpError(403, "Your access covers another team.", "forbidden");
    const history = await getDb().select().from(taskReports).where(eq(taskReports.taskId, r.taskId)).orderBy(desc(taskReports.attempt));
    return { report: reportFor(access, r), attempts: history.map((h) => ({ id: h.id, attempt: h.attempt, outcome: h.outcome, at: h.updatedAt })), units: "micro-USDC" };
  });

  // ---------- demo (public, read-only, invented data) ----------
  const demoOn = () => {
    if (!env().DEMO_ENABLED) throw new HttpError(404, "demo is off", "not_found");
  };
  app.get<{ Querystring: { range?: string } }>("/demo", async (req, reply) => {
    demoOn();
    reply.header("cache-control", "public, max-age=60");
    return demoBundle(rangeDays(req.query.range));
  });
  app.get<{ Querystring: { range?: string } }>("/demo/analytics", async (req, reply) => {
    demoOn();
    reply.header("cache-control", "public, max-age=60");
    return demoBundle(rangeDays(req.query.range)).analytics;
  });
  app.get<{ Params: { id: string } }>("/demo/reports/:id", async (req) => {
    demoOn();
    const r = demoReport(req.params.id);
    if (!r) throw new HttpError(404, "report not found", "not_found");
    return { report: r, attempts: [{ id: r.id, attempt: r.attempt, outcome: r.outcome, at: r.updatedAt }], units: "micro-USDC", demo: true };
  });

  // ---------- inbox ----------
  app.get<{ Querystring: { limit?: string } }>("/inbox", async (req) => {
    const account = requireAccount(req);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const items = await inboxItems(account, limit);
    return { items, unread: items.filter((i) => !i.read).length };
  });

  app.post("/inbox/read", async (req) => {
    const account = requireAccount(req);
    const b = parse(z.object({ ids: z.array(z.string().max(80)).max(200).optional(), all: z.boolean().optional() }), req.body);
    const ids = b.all ? (await inboxItems(account, 200)).map((i) => i.id) : (b.ids ?? []);
    const db = getDb();
    for (const id of ids) {
      if (id.startsWith("notification:")) {
        const nid = id.slice("notification:".length);
        if (/^[0-9a-f-]{36}$/i.test(nid)) await db.update(notifications).set({ read: true }).where(and(eq(notifications.id, nid), eq(notifications.account, account)));
      } else await db.insert(inboxReads).values({ account, itemId: id }).onConflictDoNothing();
    }
    return { ok: true, marked: ids.length };
  });

  /**
   * An invite sent to this account's verified email: accept it from the inbox (the email proves it's for you,
   * so you don't need the code from the email). Returns the same accept_invite transaction.
   */
  app.post<{ Params: { id: string } }>("/inbox/invites/:id/accept", async (req) => {
    const account = requireAccount(req);
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, "invite not found", "not_found");
    const hash = await verifiedEmailHash(account);
    const [inv] = await getDb().select().from(invites).where(eq(invites.id, req.params.id));
    if (!inv || !hash || inv.emailHash !== hash) throw new HttpError(404, "invite not found", "not_found");
    if (inv.expiresAt < new Date() || inv.status !== "sent") throw new HttpError(410, "This invite is no longer valid. Ask the founder for a new one.", "invite_expired");
    const { code } = JSON.parse(await openString(deserialize(inv.emailCiphertext!), serverKey(env().SESSION_SECRET), "invite"));
    await linkCompany(account, inv.companyId, "invite");
    return { companyId: inv.companyId, transaction: { ...tx.acceptInvite(inv.companyId, code), signerId: account } };
  });
};

type InboxItem = {
  id: string;
  kind: "approval" | "report" | "invite" | "alert";
  companyId: string | null;
  slug: string | null;
  title: string;
  body: string;
  at: Date;
  read: boolean;
  urgent: boolean;
  action: { type: string; [k: string]: unknown } | null;
};

/** Everything that wants the person's attention, across companies, each re-checked against their grant. */
export async function inboxItems(account: string, limit: number): Promise<InboxItem[]> {
  const db = getDb();
  const memberships = await companiesFor(account);
  const access = new Map<string, Access>();
  for (const m of memberships) {
    const a = await accessFor(account, m.companyId);
    if (a) access.set(m.companyId, a);
  }
  const ids = [...access.keys()];
  const items: InboxItem[] = [];
  const week = new Date(Date.now() - 7 * DAY);

  const notes = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.account, account), eq(notifications.channel, "in-app")))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
  for (const n of notes) {
    const p = n.payload as any;
    if (n.companyId && !access.has(n.companyId)) continue; // lost access since
    items.push({ id: `notification:${n.id}`, kind: "alert", companyId: n.companyId, slug: n.companyId ? companySlug(n.companyId) : null, title: p?.title ?? n.kind, body: p?.body ?? "", at: n.createdAt, read: n.read, urgent: n.kind === "blocked_attack" || n.kind === "paused", action: p?.url ? { type: "open", url: p.url } : null });
  }

  const approvers = ids.filter((c) => canApprove(access.get(c)!));
  if (approvers.length) {
    const cards = await db.select().from(approvalCards).where(and(inArray(approvalCards.companyId, approvers), eq(approvalCards.status, "pending"))).orderBy(desc(approvalCards.createdAt)).limit(limit);
    for (const c of cards) {
      const a = access.get(c.companyId)!;
      const dept = (c.payload as any)?.department_id ?? (c.payload as any)?.departmentId ?? null;
      if (a.departmentId && dept !== a.departmentId) continue;
      if (a.departmentId && c.kind === "daily-cap") continue; // daily-cap cards need a company-wide grant
      const amount = c.amount ? `$${(Number(c.amount) / 1e6).toFixed(2)}` : null;
      const title = c.kind === "daily-cap" ? "Daily spending cap reached" : c.kind === "seller" ? "New seller wants to be paid" : (c.payload as any)?.type === "task_review" ? "A task needs your decision" : "Purchase needs approval";
      items.push({ id: `approval:${c.id}`, kind: "approval", companyId: c.companyId, slug: companySlug(c.companyId), title, body: [(c.payload as any)?.title, amount].filter(Boolean).join(" · "), at: c.createdAt, read: false, urgent: true, action: { type: "approve", cardId: c.id, route: `POST /v1/approvals/${c.id}` } });
    }
  }

  const builders = ids.filter((c) => canWork(access.get(c)!));
  if (builders.length) {
    const reps = await db
      .select()
      .from(taskReports)
      .where(and(inArray(taskReports.companyId, builders), sql`${taskReports.updatedAt} >= ${week}`, inArray(taskReports.outcome, ["done", "paused", "failed"])))
      .orderBy(desc(taskReports.updatedAt))
      .limit(limit);
    for (const r of reps) {
      const a = access.get(r.companyId)!;
      if (a.departmentId && r.departmentId !== a.departmentId) continue;
      const team = r.departmentId?.split(".")[0] ?? "team";
      const title = r.outcome === "done" ? `${team}: finished "${r.title}"` : r.outcome === "paused" ? `${team}: "${r.title}" is waiting on you` : `${team}: "${r.title}" stopped`;
      items.push({ id: `report:${r.id}:${r.outcome}`, kind: "report", companyId: r.companyId, slug: companySlug(r.companyId), title, body: r.summary ?? "", at: r.updatedAt, read: false, urgent: r.outcome !== "done", action: { type: "report", reportId: r.id } });
    }
  }

  const emailHash = await verifiedEmailHash(account);
  if (emailHash) {
    const invs = await db.select().from(invites).where(and(eq(invites.emailHash, emailHash), eq(invites.status, "sent"))).limit(20);
    for (const inv of invs) {
      if (inv.expiresAt < new Date() || access.has(inv.companyId)) continue;
      const co = await companySnapshot(inv.companyId);
      items.push({ id: `invite:${inv.id}`, kind: "invite", companyId: inv.companyId, slug: companySlug(inv.companyId), title: `You're invited to ${co.name ?? companySlug(inv.companyId)}`, body: `Role: ${inv.template}${inv.departments.length ? ` · team: ${inv.departments.join(", ")}` : ""}`, at: inv.createdAt, read: false, urgent: false, action: { type: "accept_invite", route: `POST /v1/inbox/invites/${inv.id}/accept` } });
    }
  }

  const derived = items.filter((i) => !i.id.startsWith("notification:")).map((i) => i.id);
  if (derived.length) {
    const reads = await db.select().from(inboxReads).where(and(eq(inboxReads.account, account), inArray(inboxReads.itemId, derived)));
    const r = new Set(reads.map((x) => x.itemId));
    for (const i of items) if (r.has(i.id)) i.read = true;
  }
  return items.sort((a, b) => +b.at - +a.at).slice(0, limit);
}

void normalizeCompanyId;

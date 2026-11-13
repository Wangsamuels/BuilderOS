import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { CreateDraftBody, HttpError, Tier } from "@builderos/shared";
import { and, desc, eq, getDb, isNotNull, isNull, plans, sql, tasks } from "@builderos/db";
import { planEstimate, plan as runPlanner, topoOrder } from "@builderos/orchestrator";
import type { Tier as RouterTier } from "@builderos/router";
import { authorize, requireAccount } from "../auth.js";
import { parse } from "../app.js";
import { bindDraft, createDraft, draftAad, draftView, loadPlan, sealFor } from "../drafts.js";

const FeatureList = z
  .array(
    z.object({
      key: z.string().min(1).max(40),
      title: z.string().min(1).max(200),
      tag: z.string().min(1).max(40),
      size: z.enum(["xs", "s", "m", "l", "xl"]),
      dependsOn: z.array(z.string()).default([]),
    }),
  )
  .min(1)
  .max(60);

const PatchDraftBody = z
  .object({
    title: z.string().trim().min(2).max(80).optional(),
    /** New description → the plan is made again from it (features you edited are replaced). */
    description: z.string().trim().min(10).max(20_000).optional(),
    features: FeatureList.optional(),
    removeKeys: z.array(z.string()).optional(),
    tier: Tier.optional(),
  })
  .strict();

/** Check a feature list: unique keys, known dependencies, no loops. */
export function checkFeatures(features: Array<{ key: string; dependsOn: string[] }>) {
  if (!features.length) throw new HttpError(400, "a plan needs at least one step", "invalid_request");
  const keys = new Set(features.map((f) => f.key));
  if (keys.size !== features.length) throw new HttpError(400, "feature keys must be unique", "invalid_request");
  for (const f of features) for (const d of f.dependsOn) if (!keys.has(d)) throw new HttpError(400, `${f.key} depends on unknown step ${d}`, "invalid_request");
  try {
    topoOrder(features as any);
  } catch {
    throw new HttpError(400, "steps depend on each other in a loop", "invalid_request");
  }
}

export const draftRoutes: FastifyPluginAsync = async (app) => {
  /** The account's drafts (not yet launched, or launching), newest first. */
  app.get("/drafts", async (req) => {
    const account = requireAccount(req);
    const rows = await getDb()
      .select()
      .from(plans)
      .where(and(eq(plans.createdBy, account), isNull(plans.companyId)))
      .orderBy(desc(plans.updatedAt))
      .limit(100);
    return { drafts: await Promise.all(rows.map((r) => draftView(r))), units: "micro-USDC" };
  });

  /** Describe → plan + estimate + suggested company setup. No company, no chain, no money. */
  app.post("/drafts", { config: { rateLimit: { max: 20, timeWindow: "1 hour", keyGenerator: (r: any) => `${r.account ?? r.ip}:drafts` } } }, async (req) => {
    const account = requireAccount(req);
    const body = parse(CreateDraftBody, req.body);
    const row = await createDraft(account, body);
    return { draft: await draftView(row, { withDescription: true }) };
  });

  app.get<{ Params: { id: string } }>("/drafts/:id", async (req) => {
    const account = requireAccount(req);
    const { plan } = await loadPlan(account, req.params.id);
    if (plan.companyId) throw new HttpError(409, "This draft was launched; open it in its company.", "draft_already_launched", { companyId: plan.companyId, planId: plan.id });
    return { draft: await draftView(plan, { withDescription: true }) };
  });

  app.patch<{ Params: { id: string } }>("/drafts/:id", async (req) => {
    const account = requireAccount(req);
    const b = parse(PatchDraftBody, req.body);
    const { plan: p } = await loadPlan(account, req.params.id);
    if (p.companyId) throw new HttpError(409, "This draft was launched; edit the plan in its company.", "draft_already_launched", { companyId: p.companyId });
    const tier = (b.tier ?? p.tier) as RouterTier;
    let features = p.features;
    let description: string | undefined;
    if (b.description) {
      description = await sealFor(b.description, draftAad(account));
      features = (await runPlanner(b.description, tier)).features;
    }
    if (b.features) features = b.features;
    if (b.removeKeys?.length) {
      const drop = new Set(b.removeKeys);
      features = features.filter((f) => !drop.has(f.key)).map((f) => ({ ...f, dependsOn: f.dependsOn.filter((d) => !drop.has(d)) }));
    }
    checkFeatures(features);
    const [row] = await getDb()
      .update(plans)
      .set({ features, tier, estimate: planEstimate(features, tier), updatedAt: new Date(), ...(b.title ? { title: b.title } : {}), ...(description ? { description } : {}) })
      .where(and(eq(plans.id, p.id), isNull(plans.companyId)))
      .returning();
    if (!row) throw new HttpError(409, "This draft was launched meanwhile.", "draft_already_launched");
    return { draft: await draftView(row, { withDescription: true }) };
  });

  app.delete<{ Params: { id: string } }>("/drafts/:id", async (req) => {
    const account = requireAccount(req);
    const { plan: p } = await loadPlan(account, req.params.id);
    if (p.companyId) throw new HttpError(409, "A launched plan belongs to its company and can't be deleted.", "draft_already_launched");
    await getDb().delete(plans).where(and(eq(plans.id, p.id), isNull(plans.companyId)));
    return { ok: true, deleted: p.id };
  });

  /**
   * Put a draft into a company you founded or administer (checked on chain). For a new company, send
   * `planId` with POST /v1/companies instead: the draft joins it as soon as the chain shows the company.
   */
  app.post<{ Params: { id: string } }>("/drafts/:id/launch", async (req) => {
    const account = requireAccount(req);
    const { companyId } = parse(z.object({ companyId: z.string().min(2) }), req.body);
    await loadPlan(account, req.params.id); // 404 unless it's yours
    const row = await bindDraft(account, req.params.id, companyId);
    return { plan: { id: row.id, companyId: row.companyId, launchedAt: row.launchedAt }, next: `POST /v1/plans/${row.id}/approve` };
  });

  /** Plans of a company (Work tab): launched drafts and plans made inside the company. */
  app.get<{ Querystring: { companyId?: string } }>("/plans", async (req) => {
    const account = requireAccount(req);
    const companyId = req.query.companyId;
    if (!companyId) throw new HttpError(400, "companyId required", "invalid_request");
    await authorize(account, companyId, ["builder"]);
    const rows = await getDb().select().from(plans).where(and(eq(plans.companyId, companyId), isNotNull(plans.companyId))).orderBy(desc(plans.createdAt)).limit(100);
    const counts = rows.length
      ? (
          await getDb().execute<{ plan_id: string; status: string; n: number }>(
            sql`select plan_id::text, status, count(*)::int as n from tasks where company_id = ${companyId} group by 1, 2`,
          )
        ).rows
      : [];
    void tasks;
    return {
      companyId,
      units: "micro-USDC",
      plans: rows.map((p) => ({
        id: p.id,
        title: p.title,
        tier: p.tier,
        estimate: { p50: (p.estimate as any).p50, p90: (p.estimate as any).p90, cap: (p.estimate as any).cap },
        features: p.features.length,
        approvedAt: p.approvedAt,
        createdAt: p.createdAt,
        createdBy: p.createdBy,
        tasks: Object.fromEntries(counts.filter((c) => c.plan_id === p.id).map((c) => [c.status, c.n])),
      })),
    };
  });
};

import { env, HttpError } from "@builderos/shared";
import { and, eq, getDb, isNull, plans, type PlanFeature } from "@builderos/db";
import { deserialize, openString, seal, serialize, serverKey } from "@builderos/crypto";
import { companyCreateFunding, normalizeCompanyId } from "@builderos/near";
import { plan as runPlanner, suggestSetup, teamKindForTag, topoOrder } from "@builderos/orchestrator";
import type { Tier } from "@builderos/router";
import { authorize } from "./auth.js";

/**
 * Drafts: a product idea with a plan and estimate that belongs to one account and no company. Nothing touches
 * the chain and nothing costs money. The text is sealed to its author; it's re-sealed to the company when the
 * draft is launched. Drafts carry no permissions — they are just the author's notes until launched.
 */

type PlanRow = typeof plans.$inferSelect;

export const draftAad = (account: string) => `draft:${account}`;
const key = () => serverKey(env().SESSION_SECRET);

export async function sealFor(text: string, aad: string) {
  return serialize(await seal(text, key(), 0, aad));
}

/** Plan text for its author (draft) or for the company (launched). Falls back for rows sealed before drafts existed. */
export async function openPlanText(p: PlanRow): Promise<string | null> {
  const aads = p.companyId ? [p.companyId, draftAad(p.createdBy)] : [draftAad(p.createdBy)];
  for (const aad of aads) {
    try {
      return await openString(deserialize(p.description), key(), aad);
    } catch {
      /* try next */
    }
  }
  return null;
}

export function draftStatus(p: PlanRow): "draft" | "launching" | "launched" {
  if (p.companyId) return "launched";
  return p.launchCompanyId ? "launching" : "draft";
}

/** What the drafts list and the draft screen show. `description` only for the author. */
export async function draftView(p: PlanRow, opts: { withDescription?: boolean } = {}) {
  const est = p.estimate as { p50: string; p90: string; cap: string; perFeature: Array<{ key: string; p50: string; p90: string; cap: string }> };
  const title = p.title ?? "Untitled product";
  const setup = suggestSetup(p.features, est.perFeature ?? [], title);
  const teamOf = (tag: string) => {
    const k = teamKindForTag(tag);
    return k === "support" ? "growth" : k;
  };
  return {
    id: p.id,
    title,
    status: draftStatus(p),
    companyId: p.companyId,
    launchCompanyId: p.launchCompanyId,
    tier: p.tier,
    features: p.features.map((f) => ({ ...f, team: teamOf(f.tag), estimate: est.perFeature?.find((x) => x.key === f.key) ?? null })),
    estimate: { tier: p.tier, p50: est.p50, p90: est.p90, cap: est.cap, units: "micro-USDC" },
    /** Pre-filled company setup for "Launch this" (name, slug, teams with budgets, daily cap). */
    suggestedSetup: { ...setup, funding: companyCreateFunding(setup.teams.length) },
    approvedAt: p.approvedAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    ...(opts.withDescription ? { description: await openPlanText(p) } : {}),
  };
}

export async function createDraft(account: string, d: { title: string; description: string; tier: string }) {
  const result = await runPlanner(d.description, d.tier as Tier);
  topoOrder(result.features);
  const [row] = await getDb()
    .insert(plans)
    .values({
      companyId: null,
      title: d.title,
      description: await sealFor(d.description, draftAad(account)),
      keyVersion: 0,
      features: result.features,
      estimate: result.estimate,
      tier: d.tier,
      createdBy: account,
    })
    .returning();
  return row;
}

/** Load a plan for its reader: a draft only for its author; a launched plan for the company's builders. */
export async function loadPlan(account: string, id: string, scopes: Array<"builder" | "admin"> = ["builder"]) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "plan not found", "not_found");
  const [p] = await getDb().select().from(plans).where(eq(plans.id, id));
  if (!p) throw new HttpError(404, "plan not found", "not_found");
  if (!p.companyId) {
    // A draft is private to its author. Same 404 as a missing plan, so ids can't be probed.
    if (p.createdBy !== account) throw new HttpError(404, "plan not found", "not_found");
    return { plan: p, access: null };
  }
  const access = await authorize(account, p.companyId, scopes);
  return { plan: p, access };
}

/**
 * Attach a draft to a company the caller founded or administers (checked on chain), and re-seal its text to
 * the company. Idempotent for the same company.
 */
export async function bindDraft(account: string, planId: string, rawCompanyId: string) {
  const companyId = normalizeCompanyId(rawCompanyId);
  await authorize(account, companyId, ["admin"]);
  const db = getDb();
  const [p] = await db.select().from(plans).where(eq(plans.id, planId));
  if (!p || p.createdBy !== account) throw new HttpError(404, "draft not found", "not_found");
  if (p.companyId) {
    if (p.companyId === companyId) return p;
    throw new HttpError(409, "This draft already belongs to another company.", "draft_already_launched", { companyId: p.companyId });
  }
  const text = await openPlanText(p);
  const [row] = await db
    .update(plans)
    .set({
      companyId,
      launchCompanyId: companyId,
      launchedAt: new Date(),
      updatedAt: new Date(),
      ...(text !== null ? { description: await sealFor(text, companyId) } : {}),
    })
    .where(and(eq(plans.id, planId), isNull(plans.companyId)))
    .returning();
  if (!row) {
    const [again] = await db.select().from(plans).where(eq(plans.id, planId));
    if (again?.companyId === companyId) return again;
    throw new HttpError(409, "This draft already belongs to another company.", "draft_already_launched");
  }
  return row;
}

/**
 * Drafts this account asked to launch as `companyId`: bind them once the chain shows the company. Called from
 * the creation poll, the company read and plan approval, so the draft appears in the company without an extra
 * step. Silent: a company that isn't on chain yet just leaves them "launching".
 */
export async function bindPendingDrafts(account: string, companyId: string) {
  const db = getDb();
  const pending = await db
    .select({ id: plans.id })
    .from(plans)
    .where(and(eq(plans.createdBy, account), eq(plans.launchCompanyId, companyId), isNull(plans.companyId)));
  const bound: string[] = [];
  for (const p of pending) {
    const ok = await bindDraft(account, p.id, companyId).catch(() => null);
    if (ok) bound.push(p.id);
  }
  return bound;
}

export type { PlanFeature };

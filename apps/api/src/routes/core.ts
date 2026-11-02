import type { FastifyPluginAsync } from "fastify";
import { createHash } from "node:crypto";
import {
  CreateCompanyBody,
  CreatePlanBody,
  EstimateQuery,
  HttpError,
  PatchTaskBody,
  SellerOptionsQuery,
  env,
  type UnsignedTx,
} from "@builderos/shared";
import { companies, departments, desc, eq, getDb, inArray, plans, sellerOptions, tasks } from "@builderos/db";
import { companyAccount, tx, views } from "@builderos/near";
import { estimate, type Tier } from "@builderos/router";
import { plan as runPlanner, topoOrder, ROLE_FOR_TAG } from "@builderos/orchestrator";
import { parseChallenges, challengeAmount } from "@builderos/rails";
import { seal, serialize, serverKey } from "@builderos/crypto";
import { authorize, requireAccount, requireFounder, visibleCompanies } from "../auth.js";
import { parse } from "../app.js";

const DEPT_FOR_TAG: Record<string, string> = { growth: "growth", support: "growth", devops: "ops" };

export const coreRoutes: FastifyPluginAsync = async (app) => {
  // ---------- companies ----------
  app.get("/companies", async (req) => {
    const account = requireAccount(req);
    const ids = await visibleCompanies(account);
    if (!ids.length) return { companies: [] };
    const rows = await getDb().select().from(companies).where(inArray(companies.id, ids));
    return { companies: rows };
  });

  app.get<{ Params: { id: string } }>("/companies/:id", async (req) => {
    const account = requireAccount(req);
    await authorize(account, req.params.id, ["view"]);
    const db = getDb();
    const [c] = await db.select().from(companies).where(eq(companies.id, req.params.id));
    const depts = await db.select().from(departments).where(eq(departments.companyId, req.params.id));
    const onChain = await views.getCompany(req.params.id).catch(() => null); // budget is read from chain
    return { company: c ?? null, departments: depts, chain: onChain };
  });

  /** Create a company from a preset → unsigned create_company + department + caps transactions. */
  app.post("/companies", async (req) => {
    requireAccount(req);
    const body = parse(CreateCompanyBody, req.body);
    const companyId = companyAccount(body.slug);
    const presetHash = createHash("sha256").update(body.preset).digest("hex");
    const transactions: UnsignedTx[] = [
      tx.createCompany({ slug: body.slug, name: body.name, preset: body.preset, dailyCap: body.dailyCap, presetHash }),
      ...body.departments.map((d) => tx.createDepartment(companyId, d)),
      tx.setCaps(companyId, { dailyCap: body.dailyCap }),
    ];
    return { companyId, transactions };
  });

  // ---------- planner ----------
  app.post("/plans", async (req) => {
    const account = requireAccount(req);
    const body = parse(CreatePlanBody, req.body);
    await authorize(account, body.companyId, ["builder"]);
    const result = await runPlanner(body.description, body.tier as Tier);
    topoOrder(result.features); // rejects cycles
    // Private by default: the plan text is sealed before it's written.
    const sealed = serialize(await seal(body.description, serverKey(env().SESSION_SECRET), 0, body.companyId));
    const [row] = await getDb()
      .insert(plans)
      .values({ companyId: body.companyId, description: sealed, keyVersion: 0, features: result.features, estimate: result.estimate, tier: body.tier, createdBy: account })
      .returning();
    return { plan: { id: row.id, companyId: row.companyId, features: row.features, estimate: row.estimate, tier: row.tier } };
  });

  app.get<{ Params: { id: string } }>("/plans/:id", async (req) => {
    const account = requireAccount(req);
    const [p] = await getDb().select().from(plans).where(eq(plans.id, req.params.id));
    if (!p) throw new HttpError(404, "plan not found");
    await authorize(account, p.companyId, ["view"]);
    const t = await getDb().select().from(tasks).where(eq(tasks.planId, p.id));
    const { description: _sealed, ...rest } = p;
    return { plan: rest, tasks: t };
  });

  /** Approve a plan → task rows (DAG) + assign_task transactions. Tasks start once the contract emits task_assigned. */
  app.post<{ Params: { id: string } }>("/plans/:id/approve", async (req) => {
    const account = requireAccount(req);
    const db = getDb();
    const [p] = await db.select().from(plans).where(eq(plans.id, req.params.id));
    if (!p) throw new HttpError(404, "plan not found");
    await authorize(account, p.companyId, ["admin"]);
    if (p.approvedAt) throw new HttpError(409, "plan already approved");

    const depts = await db.select().from(departments).where(eq(departments.companyId, p.companyId));
    if (!depts.length) throw new HttpError(409, "company has no departments indexed yet");
    const deptFor = (tag: string) => {
      const want = DEPT_FOR_TAG[tag] ?? "build";
      return (depts.find((d) => d.name === want) ?? depts[0]).id;
    };
    const order = topoOrder(p.features);
    const short = p.id.slice(0, 8);
    const idOf = (key: string) => `${short}-${key}`;
    const est = (p.estimate as any).perFeature as Array<{ key: string; p50: string; p90: string; cap: string }>;
    const transactions: UnsignedTx[] = [];
    const rows = order.map((key) => {
      const f = p.features.find((x) => x.key === key)!;
      const e = est.find((x) => x.key === key) ?? estimate(f.tag, f.size, p.tier as Tier);
      const departmentId = deptFor(f.tag);
      transactions.push(
        tx.assignTask(departmentId, { taskId: idOf(key), tier: p.tier, cap: e.cap, tag: f.tag, agentRole: ROLE_FOR_TAG[f.tag] ?? "backend", dependsOn: f.dependsOn.map(idOf) }),
      );
      return {
        id: idOf(key),
        planId: p.id,
        companyId: p.companyId,
        departmentId,
        title: f.title,
        tag: f.tag,
        size: f.size,
        tier: p.tier,
        dependsOn: f.dependsOn.map(idOf),
        estP50: e.p50,
        estP90: e.p90,
        cap: e.cap,
        status: "pending",
      };
    });
    await db.transaction(async (t) => {
      await t.insert(tasks).values(rows).onConflictDoNothing();
      await t.update(plans).set({ approvedAt: new Date() }).where(eq(plans.id, p.id));
    });
    return { tasks: rows, transactions };
  });

  app.get("/estimate", async (req) => {
    const q = parse(EstimateQuery, req.query);
    if (q.tier) return estimate(q.tag, q.size, q.tier as Tier);
    return { tiers: (["economy", "standard", "premium", "private"] as Tier[]).map((t) => estimate(q.tag, q.size, t)) };
  });

  app.get<{ Querystring: { planId?: string; companyId?: string } }>("/tasks", async (req) => {
    const account = requireAccount(req);
    const companyId = req.query.companyId;
    if (!companyId) throw new HttpError(400, "companyId required");
    await authorize(account, companyId, ["view"]);
    const rows = await getDb()
      .select()
      .from(tasks)
      .where(req.query.planId ? eq(tasks.planId, req.query.planId) : eq(tasks.companyId, companyId))
      .orderBy(desc(tasks.createdAt));
    return { tasks: rows };
  });

  /** Change tier or pin a model → set_task_tier transaction. Never moves up a tier without the founder signing. */
  app.patch<{ Params: { id: string } }>("/tasks/:id", async (req) => {
    const account = requireAccount(req);
    const body = parse(PatchTaskBody, req.body);
    const [t] = await getDb().select().from(tasks).where(eq(tasks.id, req.params.id));
    if (!t || !t.departmentId) throw new HttpError(404, "task not found");
    await authorize(account, t.companyId, ["admin"], t.departmentId);
    const tier = body.tier ?? t.tier;
    const pinned = body.pinnedModel === undefined ? t.pinnedModel : body.pinnedModel;
    return { transaction: tx.setTaskTier(t.departmentId, t.id, tier, pinned) };
  });

  /** Up to 3 sellers for one service with live 402 price and a quality note from the registry. */
  app.get("/sellers/options", async (req) => {
    requireAccount(req);
    const { service } = parse(SellerOptionsQuery, req.query);
    let sellers: any[] = await views.listSellers(service).catch(() => []);
    if (!sellers.length && env().USE_SELLER_MESH) {
      const r = await fetch(`${env().SELLER_MESH_URL}/registry?service=${encodeURIComponent(service)}`).catch(() => null);
      sellers = r?.ok ? ((await r.json()) as any[]) : [];
    }
    const priced = await Promise.all(
      sellers.slice(0, 8).map(async (s) => {
        let price: string | null = null;
        let rail: string = s.rail ?? "x402-evm";
        try {
          const res = await fetch(s.probe_url ?? s.endpoint, { method: "GET", signal: AbortSignal.timeout(5_000) });
          if (res.status === 402) {
            const ch = (await parseChallenges(res))[0];
            if (ch) {
              price = challengeAmount(ch);
              rail = ch.rail;
            }
          }
        } catch {
          /* seller down: still listed without a live price */
        }
        return { service, sellerId: s.seller_id ?? s.id, rail, price, qualityNote: s.quality_note ?? null, endpoint: s.endpoint };
      }),
    );
    const top = priced
      .sort((a, b) => (a.price == null ? 1 : b.price == null ? -1 : Number(BigInt(a.price) - BigInt(b.price))))
      .slice(0, 3);
    for (const o of top)
      await getDb()
        .insert(sellerOptions)
        .values({ ...o, fetchedAt: new Date() })
        .onConflictDoUpdate({ target: [sellerOptions.service, sellerOptions.sellerId], set: { price: o.price, rail: o.rail, qualityNote: o.qualityNote, fetchedAt: new Date() } });
    return { options: top };
  });

  void requireFounder;
};

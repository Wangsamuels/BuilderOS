import type { FastifyPluginAsync } from "fastify";
import { createHash } from "node:crypto";
import {
  AgentStatusBody,
  AllowSellerBody,
  CreateCompanyBody,
  CreatePlanBody,
  RegisterAgentBody,
  EstimateQuery,
  HireOptionsQuery,
  HttpError,
  PatchTaskBody,
  SellerOptionsQuery,
  env,
  type UnsignedTx,
} from "@builderos/shared";
import { agents, and, companies, departments, desc, eq, getDb, hires, inArray, plans, sellerOptions, tasks } from "@builderos/db";
import { batchLimits, companyAccount, companyCreateFunding, departmentAccount, teamEvmConfig, tx, viewAccount, views, yoctoToNear } from "@builderos/near";
import { estimate, type Tier } from "@builderos/router";
import { listHireableAgents, nicheNecessity, HIRE_NECESSITY_MIN, plan as runPlanner, rankHireCandidates, ROLE_FOR_TAG, topoOrder } from "@builderos/orchestrator";
import { parseChallenges, challengeAmount } from "@builderos/rails";
import { seal, serialize, serverKey } from "@builderos/crypto";
import { authorize, departmentScope, requireAccount, requireFounder, visibleCompanies, type Access } from "../auth.js";
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
    const access = await authorize(account, req.params.id, ["view", "approve", "builder", "code"]);
    const db = getDb();
    const [c] = await db.select().from(companies).where(eq(companies.id, req.params.id));
    const allowed = departmentScope(access);
    const depts = (await db.select().from(departments).where(eq(departments.companyId, req.params.id))).filter(
      (d) => !allowed || allowed.includes(d.id),
    );
    const onChain = await views.getCompany(req.params.id).catch(() => null); // budget is read from chain
    return { company: c ?? null, departments: depts, chain: onChain, access: accessSummary(access) };
  });

  /**
   * Create a company from a preset → unsigned create_company + department + caps transactions.
   * Reads the chain first so a retry never hits "slug taken": if the caller already owns this slug,
   * only the missing steps are returned (resume after a partial create). Refuses to hand out a bundle
   * the wallet can't pay for, so a create can't stop half way for lack of NEAR.
   */
  app.post("/companies", async (req) => {
    const account = requireAccount(req);
    const body = parse(CreateCompanyBody, req.body);
    const companyId = companyAccount(body.slug);
    for (const d of body.departments)
      if (departmentAccount(companyId, d.name).length > 64) throw new HttpError(400, `"${d.name}" + slug is too long for a NEAR account id`, "invalid_request");

    const state = await creationState(body.slug, account);
    if (state.slugTaken && !state.founderIsYou) throw new HttpError(409, `"${body.slug}" is taken — pick another company name`, "slug_taken");
    if (state.slugTaken && !state.companyExists)
      throw new HttpError(409, "This company is still being created on chain. Check again in a few seconds.", "create_in_progress");
    if (!state.slugTaken && state.companyExists) throw new HttpError(409, `"${body.slug}" is taken — pick another company name`, "slug_taken");

    const presetHash = createHash("sha256").update(body.preset).digest("hex");
    const have = new Set(state.departments.map((d) => d.name));
    const missingDepts = body.departments.filter((d) => !have.has(d.name));
    // Each team's Base payment address is derived by Chain Signatures from the team account id,
    // so it's known before the account exists. Only that team's contract can sign for it.
    const evm = await Promise.all(missingDepts.map((d) => teamEvmConfig(departmentAccount(companyId, d.name)))).catch(() => {
      throw new HttpError(503, "Couldn't reach the Chain Signatures contract to derive team payment addresses. Try again.", "mpc_unavailable");
    });
    const transactions: UnsignedTx[] = [
      ...(state.slugTaken ? [] : [tx.createCompany({ slug: body.slug, name: body.name, preset: body.preset, dailyCap: body.dailyCap, presetHash })]),
      ...missingDepts.map((d, i) => tx.createDepartment(companyId, { ...d, evm: evm[i] })),
      ...(state.dailyCap === body.dailyCap ? [] : [tx.setCaps(companyId, { dailyCap: body.dailyCap })]),
    ];

    // Exact cost of what's left to sign: storage deposits + ~0.05 NEAR gas per tx.
    const deposits = transactions.reduce((sum, t) => sum + BigInt(t.actions[0].params.deposit), 0n);
    const required = deposits + BigInt(transactions.length) * 50_000_000_000_000_000_000_000n;
    const bal = await viewAccount(account).catch(() => ({ availableYocto: "0" }));
    const available = BigInt(bal.availableYocto);
    if (transactions.length && available < required)
      throw new HttpError(
        402,
        `Add ${nearUp(required - available)} more testnet NEAR first — creating this company needs ~${nearUp(required)} NEAR and the wallet has ${nearUp(available)}. Insufficient balance; nothing was signed.`,
        "insufficient_funds",
        { requiredYocto: required.toString(), availableYocto: available.toString(), funding: companyCreateFunding(missingDepts.length) },
      );

    return {
      companyId,
      transactions,
      resumed: state.slugTaken,
      complete: transactions.length === 0,
      missing: { company: !state.slugTaken, departments: missingDepts.map((d) => d.name), caps: state.dailyCap !== body.dailyCap },
      /** Poll after signing: confirms the company + teams exist on chain (a failed create is refunded, not "success"). */
      verify: `/v1/companies/creation/${body.slug}`,
      funding: companyCreateFunding(body.departments.length),
      requiredYocto: required.toString(),
    };
  });

  /** On-chain creation status for a slug (no indexer needed). Details only for the founder. */
  app.get<{ Params: { slug: string } }>("/companies/creation/:slug", async (req) => {
    const account = requireAccount(req);
    if (!/^[a-z0-9-]{2,32}$/.test(req.params.slug)) throw new HttpError(400, "invalid slug", "invalid_request");
    const st = await creationState(req.params.slug, account);
    if (st.slugTaken && !st.founderIsYou) return { slug: req.params.slug, slugTaken: true, founderIsYou: false };
    return st;
  });

  /** Factory couldn't refund a failed create right away → founder signs claim_refund. */
  app.post("/companies/claim-refund", async (req) => {
    const account = requireAccount(req);
    const owed = BigInt(await views.getPendingRefund(account).catch(() => "0"));
    if (owed === 0n) throw new HttpError(404, "no pending refund", "not_found");
    return { amountYocto: owed.toString(), amountNear: yoctoToNear(owed), transaction: tx.claimRefund() };
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
    const access = await authorize(account, p.companyId, ["builder"]);
    const allowed = departmentScope(access);
    const t = (await getDb().select().from(tasks).where(eq(tasks.planId, p.id))).filter((x) => !allowed || (x.departmentId && allowed.includes(x.departmentId)));
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
    // Approval is recorded before the founder signs. If signing was cancelled or refused, the tasks are still
    // "pending" (no task_assigned seen yet), so hand back the same assign_task calls instead of a dead-end 409.
    // Re-sending is safe: assign_task overwrites the task with identical values.
    if (p.approvedAt) {
      const existing = await db.select().from(tasks).where(eq(tasks.planId, p.id));
      const pending = existing.filter((r) => r.status === "pending");
      if (!pending.length) throw new HttpError(409, "plan already approved and assigned on chain", "plan_already_approved");
      const byId = new Map(existing.map((r) => [r.id, r]));
      const order = topoOrder(pending.map((r) => ({ key: r.id, dependsOn: r.dependsOn.filter((d) => byId.get(d)?.status === "pending") })) as any);
      const calls = order.map((id) => {
        const r = byId.get(id)!;
        return tx.assignTaskCall(r.departmentId ?? `build.${p.companyId}`, { taskId: r.id, tier: r.tier ?? p.tier, cap: r.cap ?? "0", tag: r.tag, agentRole: ROLE_FOR_TAG[r.tag] ?? "backend", dependsOn: r.dependsOn });
      });
      const { deptCallsPerTx } = await batchLimits(p.companyId);
      const transactions = tx.deptCalls(p.companyId, calls, deptCallsPerTx).map((t) => ({ ...t, signerId: account }));
      return { tasks: pending, transactions, resumed: true };
    }

    let depts = await db.select().from(departments).where(eq(departments.companyId, p.companyId));
    if (!depts.length) {
      await syncCompanyFromChain(p.companyId);
      depts = await db.select().from(departments).where(eq(departments.companyId, p.companyId));
    }
    if (!depts.length) throw new HttpError(409, "company has no teams on chain yet — finish company setup first", "no_teams");
    const deptFor = (tag: string) => {
      const want = DEPT_FOR_TAG[tag] ?? "build";
      return (depts.find((d) => d.name === want) ?? depts[0]).id;
    };
    const order = topoOrder(p.features);
    const short = p.id.slice(0, 8);
    const idOf = (key: string) => `${short}-${key}`;
    const est = (p.estimate as any).perFeature as Array<{ key: string; p50: string; p90: string; cap: string }>;
    const calls: ReturnType<typeof tx.assignTaskCall>[] = [];
    const rows = order.map((key) => {
      const f = p.features.find((x) => x.key === key)!;
      const e = est.find((x) => x.key === key) ?? estimate(f.tag, f.size, p.tier as Tier);
      const departmentId = deptFor(f.tag);
      calls.push(
        tx.assignTaskCall(departmentId, { taskId: idOf(key), tier: p.tier, cap: e.cap, tag: f.tag, agentRole: ROLE_FOR_TAG[f.tag] ?? "backend", dependsOn: f.dependsOn.map(idOf) }),
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
        // Hint only — runtime still runs decideHire (necessity + cheaper/more-efficient). Never random.
        hireRequired: nicheNecessity(f.title, f.tag) >= HIRE_NECESSITY_MIN,
        status: "pending",
      };
    });
    await db.transaction(async (t) => {
      await t.insert(tasks).values(rows).onConflictDoNothing();
      await t.update(plans).set({ approvedAt: new Date() }).where(eq(plans.id, p.id));
    });
    // assign_task goes through company.dept_call (departments only accept the company as caller).
    const { deptCallsPerTx } = await batchLimits(p.companyId);
    const transactions: UnsignedTx[] = tx.deptCalls(p.companyId, calls, deptCallsPerTx).map((t) => ({ ...t, signerId: account }));
    return { tasks: rows, transactions, resumed: false };
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
    const access = await authorize(account, companyId, ["builder"]);
    const allowed = departmentScope(access);
    const rows = (
      await getDb()
        .select()
        .from(tasks)
        .where(req.query.planId ? and(eq(tasks.planId, req.query.planId), eq(tasks.companyId, companyId)) : eq(tasks.companyId, companyId))
        .orderBy(desc(tasks.createdAt))
    ).filter((x) => !allowed || (x.departmentId && allowed.includes(x.departmentId)));
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

  /** Ranked hireable niche agents for a brief, filtered to what the department budget can afford. */
  app.get("/hires/options", async (req) => {
    requireAccount(req);
    const q = parse(HireOptionsQuery, req.query);
    const agents = await listHireableAgents(q.service);
    const brief = { title: q.q ?? "", tag: q.tag ?? "niche" };
    const ranked = rankHireCandidates(brief, agents, new Map(), BigInt(Number.MAX_SAFE_INTEGER));
    return {
      options: ranked.slice(0, 5).map((c) => ({
        agentId: c.agentId,
        service: c.service,
        description: c.description,
        skills: c.skills,
        rating: c.rating,
        alignment: c.alignment,
        score: c.score,
        price: c.price,
        currency: c.currency,
        rail: c.rail,
        payTo: c.payTo,
        endpoint: c.endpoint,
        qualityNote: c.qualityNote ?? null,
      })),
    };
  });

  app.get<{ Querystring: { companyId?: string; taskId?: string } }>("/hires", async (req) => {
    const account = requireAccount(req);
    const companyId = req.query.companyId;
    if (!companyId) throw new HttpError(400, "companyId required");
    const access = await authorize(account, companyId, ["builder"]);
    const allowed = departmentScope(access);
    const rows = (
      await getDb()
        .select()
        .from(hires)
        .where(req.query.taskId ? and(eq(hires.taskId, req.query.taskId), eq(hires.companyId, companyId)) : eq(hires.companyId, companyId))
        .orderBy(desc(hires.createdAt))
    ).filter((h) => !allowed || allowed.includes(h.departmentId));
    return { hires: rows };
  });

  // ---------- agents (keys are added/removed by the team contract, never by a person's key) ----------

  /** Founder/admin: register an agent key on a team → company.register_agent (team adds a limited key). */
  app.post("/agents", async (req) => {
    const account = requireAccount(req);
    const body = parse(RegisterAgentBody, req.body);
    if (!body.departmentId.endsWith(`.${body.companyId}`)) throw new HttpError(400, "departmentId is not a team of companyId", "invalid_request");
    await authorize(account, body.companyId, ["admin"]);
    return { transaction: tx.registerAgent(body.departmentId, body.publicKey, body.role) };
  });

  /** Founder/admin: pause/resume (off-chain, the orchestrator stops giving it tasks) or fire (on-chain key delete). */
  app.post<{ Params: { agentId: string } }>("/agents/:agentId/status", async (req) => {
    const account = requireAccount(req);
    const body = parse(AgentStatusBody, req.body);
    const [a] = await getDb().select().from(agents).where(eq(agents.publicKey, req.params.agentId));
    if (!a || !a.departmentId.endsWith(`.${body.companyId}`)) throw new HttpError(404, "agent not found", "not_found");
    await authorize(account, body.companyId, ["admin"]);
    if (body.status === "fired") return { transaction: tx.fireAgent(a.departmentId, a.publicKey) };
    await getDb().update(agents).set({ status: body.status === "paused" ? "paused" : "active" }).where(eq(agents.publicKey, a.publicKey));
    return { ok: true, status: body.status };
  });

  // ---------- payments: team addresses + seller allow-list ----------

  /** Where each team's USDC lives on Base (Chain Signatures address) — fund these to let agents pay. */
  app.get<{ Params: { id: string } }>("/companies/:id/payments", async (req) => {
    const account = requireAccount(req);
    const access = await authorize(account, req.params.id, ["view", "approve"]);
    const allowed = departmentScope(access);
    const teams = (await views.getDepartments(req.params.id).catch(() => [])).filter((d) => !allowed || allowed.includes(d.department_id));
    const out = await Promise.all(
      teams.map(async (d) => {
        const [onChain, derived] = await Promise.all([views.getDepartment(d.department_id).catch(() => null), teamEvmConfig(d.department_id).catch(() => null)]);
        return {
          name: d.name,
          departmentId: d.department_id,
          chainId: onChain?.evm_chain_id || derived?.chain_id || null,
          usdc: onChain?.evm_usdc ?? derived?.usdc ?? null,
          address: onChain?.base_address ?? null,
          derivedAddress: derived?.from ?? null,
          configured: Boolean(onChain?.base_address && derived && onChain.base_address.toLowerCase() === derived.from.toLowerCase()),
        };
      }),
    );
    return { teams: out };
  });

  /** Founder/admin: (re)set each team's payment config to its Chain Signatures address (for teams created before it existed). */
  app.post<{ Params: { id: string } }>("/companies/:id/payments/configure", async (req) => {
    const account = requireAccount(req);
    await authorize(account, req.params.id, ["admin"]);
    const teams = await views.getDepartments(req.params.id).catch(() => []);
    if (!teams.length) throw new HttpError(409, "company has no teams on chain yet", "no_teams");
    const transactions = await Promise.all(teams.map(async (d) => tx.setEvmConfig(d.department_id, await teamEvmConfig(d.department_id))));
    return { transactions };
  });

  /** Founder/admin: allow-list a seller for a team at one payee address (or remove it with payTo: null). */
  app.post("/sellers/allow", async (req) => {
    const account = requireAccount(req);
    const body = parse(AllowSellerBody, req.body);
    if (!body.departmentId.endsWith(`.${body.companyId}`)) throw new HttpError(400, "departmentId is not a team of companyId", "invalid_request");
    await authorize(account, body.companyId, ["admin"]);
    return { transaction: tx.allowSeller(body.departmentId, body.sellerId, body.payTo) };
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

/** What the dashboard may show this account (the founder decides via grants). */
export function accessSummary(a: Access) {
  return {
    founder: a.founder,
    admin: a.admin,
    scopes: [...a.scopes],
    departmentId: a.departmentId,
    expiresAtMs: a.grant?.expires_at_ms ?? null,
  };
}

type CreationState = {
  slug: string;
  companyId: string;
  slugTaken: boolean;
  founderIsYou: boolean;
  companyExists: boolean;
  departments: Array<{ name: string; departmentId: string }>;
  dailyCap: string | null;
  pendingRefundYocto: string;
};

/**
 * Write the company and its teams into the read cache straight from chain. The indexer normally does this
 * from `company_created` / `department_created`, but if an event was missed (or a callback failed after
 * the account was created), the dashboard and plan approval would never see the company.
 */
export async function syncCompanyFromChain(
  companyId: string,
  company?: { founder: string; name: string } | null,
  list?: Array<{ name: string; department_id: string }>,
) {
  const c = company ?? (await views.getCompany(companyId).catch(() => null));
  if (!c) return false;
  const teams = list ?? (await views.getDepartments(companyId).catch(() => []));
  const db = getDb();
  await db
    .insert(companies)
    .values({ id: companyId, accountId: companyId, name: c.name, network: process.env.NETWORK ?? "testnet", founderAccount: c.founder })
    .onConflictDoNothing();
  for (const d of teams)
    await db.insert(departments).values({ id: d.department_id, companyId, accountId: d.department_id, name: d.name }).onConflictDoNothing();
  return true;
}

/** Everything about a create, read from chain: factory slug record, company account, its departments, refunds. */
async function creationState(slug: string, account: string): Promise<CreationState> {
  const companyId = companyAccount(slug);
  const [meta, acct, pending] = await Promise.all([
    views.getFactoryCompany(slug).catch(() => null),
    viewAccount(companyId).catch(() => ({ exists: false })),
    views.getPendingRefund(account).catch(() => "0"),
  ]);
  const companyExists = Boolean((acct as any).exists);
  let depts: Array<{ name: string; departmentId: string }> = [];
  let dailyCap: string | null = null;
  if (companyExists) {
    const [list, company] = await Promise.all([views.getDepartments(companyId).catch(() => []), views.getCompany(companyId).catch(() => null)]);
    depts = (list ?? []).map((d) => ({ name: d.name, departmentId: d.department_id }));
    dailyCap = company?.daily_cap ?? null;
    if (company) await syncCompanyFromChain(companyId, company, list ?? []).catch(() => {});
  }
  return {
    slug,
    companyId,
    slugTaken: Boolean(meta),
    founderIsYou: meta?.founder === account,
    companyExists,
    departments: depts,
    dailyCap,
    pendingRefundYocto: pending ?? "0",
  };
}

/** Yocto → NEAR rounded up to 2 decimals, for messages. */
function nearUp(yocto: bigint): string {
  const cents = (yocto + 10n ** 22n - 1n) / 10n ** 22n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

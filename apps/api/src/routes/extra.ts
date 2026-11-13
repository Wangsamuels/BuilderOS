import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { HttpError, network } from "@builderos/shared";
import { agents, and, desc, eq, getDb, hires, inArray, invites, plans, receipts, sql, tasks, viewKeys } from "@builderos/db";
import {
  baseUsdcBalance,
  batchLimits,
  companySlug,
  splitDepartment,
  teamEvmConfig,
  tx,
  txStatus,
  views,
  parseEventLog,
  type DeptCall,
} from "@builderos/near";
import { estimate, estimateForModel, type Tier } from "@builderos/router";
import { planEstimate, topoOrder } from "@builderos/orchestrator";
import { sha256Hex } from "@builderos/crypto";
import { accessFor, authorize, departmentScope, requireAccount, requireFounder } from "../auth.js";
import { parse } from "../app.js";
import { loadPlan } from "../drafts.js";

/**
 * Routes added for the web app's interior screens. Everything that the contracts can't do yet answers
 * 501 `not_implemented` with `details.feature`, `details.status` and, when there is one, `details.replacement`
 * — so the UI can show an honest "not available yet" state instead of guessing.
 */
export function unsupported(feature: string, reason: string, extra: { status?: "unsupported" | "planned"; replacement?: string } = {}): never {
  throw new HttpError(501, reason, "not_implemented", { feature, status: extra.status ?? "unsupported", ...(extra.replacement ? { replacement: extra.replacement } : {}) });
}

/** Team-policy calls that need company contract_version ≥ 3 (they panicked when forwarded with a deposit). */
export async function requireZeroDepositForwarding(companyId: string, feature: string) {
  const lim = await batchLimits(companyId);
  if (!lim.zeroDepositForwarding)
    throw new HttpError(409, `This company runs contract version ${lim.version}; ${feature} needs version 3. The founder must upgrade the company contract first.`, "contract_upgrade_required", {
      feature,
      currentVersion: lim.version,
      requiredVersion: 3,
      how: "propose_upgrade(target \"company\", sha256 of contracts/wasm/company.wasm) → wait 24 h → apply_upgrade with the wasm as raw input",
    });
}

const Tiers = ["economy", "standard", "premium", "private"] as const;

const PolicyBody = z
  .object({
    companyId: z.string(),
    /** Team name ("eng") or team account id. Required for team-level fields. */
    team: z.string().optional(),
    /** Company daily spending cap, micro-USDC integer string. Founder only. */
    dailyCap: z.string().regex(/^\d+$/).optional(),
    /** Raise a team's budget to this total (micro-USDC). Budgets can only grow on chain. */
    monthlyCap: z.string().regex(/^\d+$/).optional(),
    /** Add this much to a team's budget (micro-USDC). */
    budgetIncrease: z.string().regex(/^\d+$/).optional(),
    tempo: z.object({ target: z.string().regex(/^\d+$/), enabled: z.boolean() }).optional(),
    perTxLimit: z.string().optional(),
    autoApproveLimit: z.string().optional(),
    tier: z.enum(Tiers).optional(),
  })
  .strict();

const PatchPlanBody = z
  .object({
    /** Replace the feature list (keys must stay unique; dependsOn may only name keys in the list). */
    features: z
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
      .max(60)
      .optional(),
    /** Remove steps by key (their dependents lose that dependency). */
    removeKeys: z.array(z.string()).optional(),
    tier: z.enum(Tiers).optional(),
  })
  .strict();

export const extraRoutes: FastifyPluginAsync = async (app) => {
  // ---------- teams ----------
  /** Team budgets, spending and agents, read live from each team contract. Members see only their team. */
  app.get<{ Querystring: { companyId?: string } }>("/teams", async (req) => {
    const account = requireAccount(req);
    const companyId = req.query.companyId;
    if (!companyId) throw new HttpError(400, "companyId required", "invalid_request");
    const access = await authorize(account, companyId, ["view", "approve", "builder", "code"]);
    const allowed = departmentScope(access);
    const list = (await views.getDepartments(companyId).catch(() => [])).filter((d) => !allowed || allowed.includes(d.department_id));
    const ids = list.map((d) => d.department_id);
    const agentRows = ids.length ? await getDb().select().from(agents).where(inArray(agents.departmentId, ids)) : [];
    const taskCounts = ids.length
      ? (
          await getDb().execute<{ department_id: string; status: string; n: number }>(
            sql`select department_id, status, count(*)::int as n from tasks where company_id = ${companyId} group by 1, 2`,
          )
        ).rows
      : [];
    const teams = await Promise.all(
      list.map(async (d) => {
        const v = await views.getDepartment(d.department_id).catch(() => null);
        const budget = BigInt(v?.budget ?? "0");
        const spent = BigInt(v?.spent ?? "0");
        const reserved = BigInt(v?.reserved ?? "0");
        const left = budget - spent - reserved;
        return {
          name: d.name,
          departmentId: d.department_id,
          budget: budget.toString(),
          spent: spent.toString(),
          reserved: reserved.toString(),
          available: (left > 0n ? left : 0n).toString(),
          perTxLimit: v?.per_tx_limit ?? null,
          frozen: v?.frozen ?? null,
          paymentAddress: v?.base_address ?? null,
          chainId: v?.evm_chain_id || null,
          agents: agentRows
            .filter((a) => a.departmentId === d.department_id)
            .map((a) => ({ publicKey: a.publicKey, accountId: a.accountId, role: a.role, status: a.status, maxTier: a.maxTier })),
          tasks: Object.fromEntries(taskCounts.filter((t) => t.department_id === d.department_id).map((t) => [t.status, t.n])),
          chainReadOk: v !== null,
        };
      }),
    );
    return { companyId, units: "micro-USDC", teams };
  });

  // ---------- deposit ----------
  /**
   * How money gets into this company. Agents pay from each team's Base USDC address (only that team
   * contract can sign for it). A single company-level deposit address needs NEAR Intents, which isn't
   * deployed on testnet — so on testnet `address` is null and `teams` is the way to fund.
   */
  app.get<{ Querystring: { companyId?: string } }>("/deposit", async (req) => {
    const account = requireAccount(req);
    const companyId = req.query.companyId;
    if (!companyId) throw new HttpError(400, "companyId required", "invalid_request");
    const access = await authorize(account, companyId, ["view", "approve"]);
    const allowed = departmentScope(access);
    const n = network();
    const list = (await views.getDepartments(companyId).catch(() => [])).filter((d) => !allowed || allowed.includes(d.department_id));
    const teams = await Promise.all(
      list.map(async (d) => {
        const v = await views.getDepartment(d.department_id).catch(() => null);
        const address = v?.base_address ?? (await teamEvmConfig(d.department_id).catch(() => null))?.from ?? null;
        const balance = address ? await baseUsdcBalance(address).catch(() => null) : null;
        return { team: d.name, departmentId: d.department_id, address, chainId: n.base.chainId, token: n.base.usdc, balance };
      }),
    );
    const total = teams.reduce((a, t) => a + BigInt(t.balance ?? "0"), 0n);
    const mainnet = n.id === "mainnet";
    return {
      companyId,
      supported: mainnet,
      address: mainnet ? companyId : null,
      method: mainnet ? "near_intents" : null,
      reason: mainnet ? null : "company_deposit_unavailable_on_testnet",
      message: mainnet
        ? "Deposit USDC to this company's NEAR Intents account (ft_transfer_call to intents.near with msg = the company id)."
        : "NEAR Intents isn't on testnet, so there's no single company deposit address. Fund a team's Base Sepolia USDC address instead.",
      tokens: [
        { symbol: "USDC", network: mainnet ? "base" : "base-sepolia", chainId: n.base.chainId, address: n.base.usdc, decimals: 6, use: "team payment addresses" },
        ...(mainnet ? [{ symbol: "USDC", network: "near", tokenId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", decimals: 6, use: "company deposit (NEAR Intents)" }] : []),
      ],
      units: "micro-USDC",
      /** Spendable by agents now: sum of the team addresses' USDC balances (null balances excluded). */
      balance: total.toString(),
      teams,
      event: "deposit_received",
    };
  });

  // ---------- policy ----------
  /**
   * Change limits → unsigned transactions. Supported on chain: company daily cap (founder), raising a team
   * budget, Tempo float. Not supported by the contracts (501): changing per-purchase / auto-approve limits
   * or a company default tier.
   */
  app.post("/policy", async (req) => {
    const account = requireAccount(req);
    const b = parse(PolicyBody, req.body);
    const cantDo = (["perTxLimit", "autoApproveLimit", "tier"] as const).filter((k) => b[k] !== undefined);
    if (cantDo.length)
      unsupported("policy." + cantDo.join(","), `The contracts can't change ${cantDo.join(", ")} after a team is created.`, {
        replacement: cantDo.includes("tier") ? "PATCH /v1/tasks/:id { tier } per task" : undefined,
      });
    const transactions = [];
    if (b.dailyCap !== undefined) {
      await requireFounder(account, b.companyId);
      transactions.push(tx.setCaps(b.companyId, { dailyCap: b.dailyCap }));
    }
    const teamFields = b.monthlyCap !== undefined || b.budgetIncrease !== undefined || b.tempo !== undefined;
    if (teamFields) {
      if (!b.team) throw new HttpError(400, "team is required for monthlyCap, budgetIncrease and tempo", "invalid_request");
      const departmentId = b.team.includes(".") ? b.team : `${b.team.toLowerCase()}.${b.companyId}`;
      if (!departmentId.endsWith(`.${b.companyId}`)) throw new HttpError(400, `${b.team} is not a team of ${b.companyId}`, "invalid_request");
      await authorize(account, b.companyId, ["admin"]);
      const name = splitDepartment(departmentId).name;
      const calls: DeptCall[] = [];
      let increase = b.budgetIncrease ? BigInt(b.budgetIncrease) : 0n;
      if (b.monthlyCap !== undefined) {
        const v = await views.getDepartment(departmentId).catch(() => null);
        if (!v) throw new HttpError(404, "team not found on chain", "not_found");
        const delta = BigInt(b.monthlyCap) - BigInt(v.budget);
        if (delta < 0n)
          throw new HttpError(409, "Team budgets can only be raised on chain. To stop spending, pause the team instead.", "budget_decrease_unsupported", {
            current: v.budget,
            requested: b.monthlyCap,
            replacement: "POST /v1/freeze { companyId, departments: [team] }",
          });
        increase += delta;
      }
      if (increase > 0n) {
        await requireZeroDepositForwarding(b.companyId, "raising a team budget");
        calls.push({ department: name, method: "top_up_budget", args: { amount: increase.toString() } });
      }
      if (b.tempo) calls.push({ department: name, method: "set_rail_float", args: { rail: "tempo", target: b.tempo.target, enabled: b.tempo.enabled } });
      if (calls.length) {
        const { deptCallsPerTx } = await batchLimits(b.companyId);
        transactions.push(...tx.deptCalls(b.companyId, calls, deptCallsPerTx));
      }
    }
    if (!transactions.length) throw new HttpError(400, "nothing to change", "invalid_request");
    return { transactions: transactions.map((t) => ({ ...t, signerId: account })), transaction: transactions[0] };
  });

  // ---------- plans / tasks ----------
  /** Edit a draft plan (features, removed steps, tier). Approved plans are fixed: 409 plan_already_approved. */
  app.patch<{ Params: { id: string } }>("/plans/:id", async (req) => {
    const account = requireAccount(req);
    const body = parse(PatchPlanBody, req.body);
    const db = getDb();
    const { plan: p } = await loadPlan(account, req.params.id); // drafts: author only; launched: builders
    if (p.approvedAt) throw new HttpError(409, "This plan is already approved; its steps are on chain.", "plan_already_approved");
    let features = body.features ?? p.features;
    if (body.removeKeys?.length) {
      const drop = new Set(body.removeKeys);
      features = features.filter((f) => !drop.has(f.key)).map((f) => ({ ...f, dependsOn: f.dependsOn.filter((d) => !drop.has(d)) }));
    }
    if (!features.length) throw new HttpError(400, "a plan needs at least one step", "invalid_request");
    const keys = new Set(features.map((f) => f.key));
    if (keys.size !== features.length) throw new HttpError(400, "feature keys must be unique", "invalid_request");
    for (const f of features)
      for (const d of f.dependsOn) if (!keys.has(d)) throw new HttpError(400, `${f.key} depends on unknown step ${d}`, "invalid_request");
    try {
      topoOrder(features);
    } catch {
      throw new HttpError(400, "steps depend on each other in a loop", "invalid_request");
    }
    const tier = (body.tier ?? p.tier) as Tier;
    const est = planEstimate(features, tier);
    const [row] = await db.update(plans).set({ features, estimate: est, tier, updatedAt: new Date() }).where(eq(plans.id, p.id)).returning();
    return { plan: { id: row.id, companyId: row.companyId, title: row.title, features: row.features, estimate: row.estimate, tier: row.tier, approvedAt: row.approvedAt, status: row.companyId ? "launched" : "draft" } };
  });

  app.get<{ Params: { id: string } }>("/tasks/:id", async (req) => {
    const account = requireAccount(req);
    const [t] = await getDb().select().from(tasks).where(eq(tasks.id, req.params.id));
    if (!t) throw new HttpError(404, "task not found", "not_found");
    const access = await authorize(account, t.companyId, ["builder"], t.departmentId);
    const allowed = departmentScope(access);
    if (allowed && (!t.departmentId || !allowed.includes(t.departmentId))) throw new HttpError(403, "not your team", "forbidden");
    const taskHires = await getDb().select().from(hires).where(eq(hires.taskId, t.id)).orderBy(desc(hires.createdAt));
    return { task: t, hires: taskHires, units: "micro-USDC" };
  });

  /** Price one task: its tag/size on a tier (default: the task's tier), or on one specific model. */
  app.post("/estimate", async (req) => {
    const account = requireAccount(req);
    const b = parse(z.object({ taskId: z.string(), model: z.string().optional(), tier: z.enum(Tiers).optional() }).strict(), req.body);
    const [t] = await getDb().select().from(tasks).where(eq(tasks.id, b.taskId));
    if (!t) throw new HttpError(404, "task not found", "not_found");
    await authorize(account, t.companyId, ["builder"], t.departmentId);
    if (b.model) {
      const e = estimateForModel(t.tag, t.size, b.model);
      if (!e) throw new HttpError(404, `unknown model ${b.model}`, "not_found");
      return { taskId: t.id, units: "micro-USDC", estimate: e, current: { tier: t.tier, cap: t.cap } };
    }
    const tier = (b.tier ?? t.tier) as Tier;
    return {
      taskId: t.id,
      units: "micro-USDC",
      estimate: estimate(t.tag, t.size, tier),
      tiers: Tiers.map((x) => estimate(t.tag, t.size, x)),
      current: { tier: t.tier, cap: t.cap },
    };
  });

  // ---------- invites ----------
  /** Invite preview for the accept screen. Needs the secret code; never returns the invitee's email. */
  app.get<{ Params: { code: string } }>("/invites/:code", async (req) => {
    requireAccount(req);
    const [inv] = await getDb().select().from(invites).where(eq(invites.codeHash, sha256Hex(req.params.code)));
    if (!inv) throw new HttpError(404, "invite not found", "not_found");
    const expired = inv.expiresAt < new Date();
    const company = await views.getCompany(inv.companyId).catch(() => null);
    return {
      companyId: inv.companyId,
      slug: companySlug(inv.companyId),
      companyName: company?.name ?? null,
      role: inv.template,
      departments: inv.departments,
      expiresAt: inv.expiresAt,
      status: expired ? "expired" : inv.status, // pending_confirmation (founder hasn't signed) | sent | accepted | revoked | expired
      canAccept: !expired && inv.status === "sent",
    };
  });

  /** Grants can't be edited on chain: revoke, then invite again with the new role. */
  app.post<{ Params: { accountId: string } }>("/members/:accountId/grants", async (req) => {
    requireAccount(req);
    unsupported("members.grants.update", "Grants can't be edited on chain. Revoke the member, then send a new invite with the new role.", {
      replacement: "DELETE /v1/members/:accountId?companyId= then POST /v1/members/invite",
    });
  });

  // ---------- device keys ----------
  /** After signing register_view_key: record it now (checked against the transaction on chain), no indexer wait. */
  app.post("/keys/view/confirm", async (req) => {
    const account = requireAccount(req);
    const b = parse(z.object({ companyId: z.string(), txHash: z.string().min(40).max(60) }), req.body);
    const status = await txStatus(b.txHash, account).catch(() => null);
    if (!status) throw new HttpError(404, "transaction not found yet — retry in a few seconds", "tx_not_found");
    let found: { key: string; height: number | null } | null = null;
    for (const o of status.receipts_outcome ?? []) {
      if (o.outcome?.executor_id !== b.companyId) continue;
      for (const log of o.outcome.logs ?? []) {
        const p = parseEventLog(log);
        if (p?.ok && p.value.event === "view_key_registered")
          for (const d of p.value.data as any[]) if (d.account_id === account) found = { key: d.x25519_public_key, height: null };
      }
    }
    if (!found) throw new HttpError(409, "that transaction didn't register a view key for you on this company", "tx_mismatch");
    await getDb()
      .insert(viewKeys)
      .values({ accountId: account, companyId: b.companyId, x25519PublicKey: found.key, nearTx: b.txHash })
      .onConflictDoUpdate({ target: [viewKeys.accountId, viewKeys.companyId], set: { x25519PublicKey: found.key, nearTx: b.txHash, updatedAt: new Date() } });
    return { ok: true, companyId: b.companyId, accountId: account, x25519PublicKey: found.key };
  });

  /**
   * Founder/admin: public view keys of everyone who may hold the code key now (founder + live grants with
   * code/admin scope; log keys: any live grant), re-checked on chain. Use these to wrap a rotated key.
   */
  app.get<{ Querystring: { companyId?: string; kind?: string } }>("/keys/devices", async (req) => {
    const account = requireAccount(req);
    const companyId = req.query.companyId;
    if (!companyId) throw new HttpError(400, "companyId required", "invalid_request");
    const kind = req.query.kind === "log" ? "log" : "code";
    await authorize(account, companyId, ["admin"]);
    const rows = await getDb().select().from(viewKeys).where(eq(viewKeys.companyId, companyId));
    const company = await views.getCompany(companyId).catch(() => null);
    const devices = (
      await Promise.all(
        rows.map(async (r) => {
          const a = await accessFor(r.accountId, companyId).catch(() => null);
          if (!a) return null;
          const may = kind === "code" ? a.founder || a.admin || a.scopes.has("code") : true;
          if (!may) return null;
          return { accountId: r.accountId, x25519PublicKey: r.x25519PublicKey, founder: a.founder, scopes: [...a.scopes], departmentId: a.departmentId, registeredTx: r.nearTx, updatedAt: r.updatedAt };
        }),
      )
    ).filter(Boolean);
    return { companyId, kind, codeKeyVersion: company?.code_key_version ?? null, devices };
  });

  // ---------- revenue ----------
  app.get<{ Querystring: { companyId?: string; limit?: string } }>("/revenue", async (req) => {
    const account = requireAccount(req);
    const companyId = req.query.companyId;
    if (!companyId) throw new HttpError(400, "companyId required", "invalid_request");
    await authorize(account, companyId, ["admin"]);
    const rows = await getDb()
      .select()
      .from(receipts)
      .where(and(eq(receipts.companyId, companyId), eq(receipts.kind, "revenue")))
      .orderBy(desc(receipts.createdAt))
      .limit(Math.min(Number(req.query.limit ?? 100), 500));
    const total = rows.reduce((a, r) => a + BigInt(r.amount ?? "0"), 0n);
    return { companyId, units: "micro-USDC", total: total.toString(), receipts: rows };
  });

  // ---------- explicitly not available yet (stable 501 contract) ----------
  app.get("/private", async (req) => {
    requireAccount(req);
    unsupported("private.ciphertext", "Encrypted file storage (code, logs, plan text) isn't shipped. Only wrapped keys are served.", {
      status: "planned",
      replacement: "GET /v1/keys/wrapped?companyId=&kind=code|log",
    });
  });
  app.post("/floats/top-up", async (req) => {
    requireAccount(req);
    unsupported("floats.topup", "Instant Tempo top-ups aren't available; the bridge worker tops up automatically toward the target.", {
      replacement: "PATCH /v1/floats/tempo { departmentId, target, enabled }",
    });
  });
  app.post("/withdraw/quote", async (req) => {
    requireAccount(req);
    unsupported("withdrawals.quote", "There's no separate quote step; POST /v1/withdrawals returns the plan (sources, fees) with the transaction.", {
      replacement: "POST /v1/withdrawals",
    });
  });
  app.get("/services", async (req) => {
    requireAccount(req);
    unsupported("services.list", "Service subscriptions aren't tracked yet.", { status: "planned" });
  });
  app.post("/services/:serviceId/cancel", async (req) => {
    requireAccount(req);
    unsupported("services.cancel", "Service subscriptions aren't tracked yet.", { status: "planned" });
  });
  app.get("/provenance", async (req) => {
    requireAccount(req);
    unsupported("provenance", "Provenance view isn't shipped.", { status: "planned", replacement: "GET /v1/ledger and GET /v1/receipts/:id (nearTx, foreignTx, verifiedOnChain)" });
  });
  app.get("/leaderboard", async (req) => {
    requireAccount(req);
    unsupported("leaderboard", "Leaderboard isn't shipped.", { status: "planned" });
  });
};

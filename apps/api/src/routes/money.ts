import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { DecideApprovalBody, FreezeBody, HttpError, LedgerQuery, MONEY_RECEIPT_KINDS, TempoFloatBody, WithdrawalBody, toBig, type UnsignedTx } from "@builderos/shared";
import { and, approvalCards, departments, desc, eq, getDb, inArray, keyAccessLog, lt, railFloats, receipts, sql } from "@builderos/db";
import { batchLimits, tx, view, views } from "@builderos/near";
import { authorize, departmentScope, requireAccount, requireFounder } from "../auth.js";
import { parse } from "../app.js";

const csvCell = (v: unknown) => {
  const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const moneyRoutes: FastifyPluginAsync = async (app) => {
  // ---------- approvals ----------
  app.get<{ Querystring: { companyId: string; status?: string } }>("/approvals", async (req) => {
    const account = requireAccount(req);
    const { companyId, status = "pending" } = req.query;
    if (!companyId) throw new HttpError(400, "companyId required");
    // Approval cards are for people the founder made approvers (or admins).
    await authorize(account, companyId, ["approve"]);
    const cards = await getDb()
      .select()
      .from(approvalCards)
      .where(and(eq(approvalCards.companyId, companyId), eq(approvalCards.status, status)))
      .orderBy(desc(approvalCards.createdAt));
    return { cards };
  });

  /** Approve / reject a card → one batched transaction for all its requests (the daily card covers many). */
  app.post<{ Params: { id: string } }>("/approvals/:id", async (req) => {
    const account = requireAccount(req);
    const { decision, alwaysAllow } = parse(DecideApprovalBody, req.body);
    const [card] = await getDb().select().from(approvalCards).where(eq(approvalCards.id, req.params.id));
    if (!card) throw new HttpError(404, "card not found");
    if (card.status !== "pending") throw new HttpError(409, `card is ${card.status}`);
    await authorize(account, card.companyId, ["approve"]);
    // The contract re-checks the approver's grant; approving tells each team to let its agent get the
    // Chain Signatures signature. Big daily cards are split into ≤20 requests per tx.
    const { approvalsPerTx } = await batchLimits(card.companyId);
    const transactions: UnsignedTx[] =
      decision === "approve"
        ? tx.approve(card.companyId, card.requestIds, card.id, approvalsPerTx)
        : tx.reject(card.companyId, card.requestIds, card.id, approvalsPerTx);
    const p = (card.payload ?? {}) as { department_id?: string; seller_id?: string; pay_to?: string };
    if (decision === "approve" && alwaysAllow) {
      // Allow-listing changes team policy: founder/admin only.
      if (!p.department_id || !p.seller_id || !p.pay_to) throw new HttpError(400, "this card has no seller to allow-list", "invalid_request");
      await authorize(account, card.companyId, ["admin"]);
      transactions.push(tx.allowSeller(p.department_id, p.seller_id, p.pay_to));
    }
    return { card, transaction: transactions[0], transactions };
  });

  // ---------- ledger / audit / receipts ----------
  app.get("/ledger", async (req, reply) => {
    const account = requireAccount(req);
    const q = parse(LedgerQuery, req.query);
    const access = await authorize(account, q.companyId, ["view", "approve"]);
    const conds = [eq(receipts.companyId, q.companyId), inArray(receipts.kind, MONEY_RECEIPT_KINDS)];
    if (q.kind) conds.push(eq(receipts.kind, q.kind));
    if (q.departmentId) conds.push(eq(receipts.departmentId, q.departmentId));
    // Members only see money receipts for the team the founder granted them (read live from chain).
    const allowed = departmentScope(access);
    if (allowed) conds.push(inArray(receipts.departmentId, allowed));
    if (q.before) conds.push(lt(receipts.blockHeight, q.before));
    const rows = await getDb()
      .select()
      .from(receipts)
      .where(and(...conds))
      .orderBy(desc(receipts.createdAt))
      .limit(q.limit);
    if (q.format === "csv") {
      const cols = ["id", "createdAt", "kind", "departmentId", "actor", "amount", "token", "rail", "chainId", "nearTx", "foreignTx", "verifiedOnChain", "payload"] as const;
      const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell((r as any)[c])).join(","))].join("\n");
      reply.header("content-type", "text/csv").header("content-disposition", `attachment; filename="ledger-${q.companyId}.csv"`);
      return csv;
    }
    return { receipts: rows };
  });

  app.get<{ Querystring: { companyId: string; limit?: string } }>("/audit", async (req) => {
    const account = requireAccount(req);
    const { companyId } = req.query;
    if (!companyId) throw new HttpError(400, "companyId required");
    await authorize(account, companyId, ["admin"]);
    const limit = Math.min(Number(req.query.limit ?? 200), 500);
    const db = getDb();
    const rows = await db
      .select()
      .from(receipts)
      .where(and(eq(receipts.companyId, companyId), inArray(receipts.kind, ["membership", "keys_policy"])))
      .orderBy(desc(receipts.createdAt))
      .limit(limit);
    const keyAccess = await db.select().from(keyAccessLog).where(eq(keyAccessLog.companyId, companyId)).orderBy(desc(keyAccessLog.createdAt)).limit(limit);
    return { receipts: rows, keyAccess };
  });

  app.get<{ Params: { id: string } }>("/receipts/:id", async (req) => {
    const account = requireAccount(req);
    const [r] = await getDb().select().from(receipts).where(eq(receipts.id, req.params.id));
    if (!r || !r.companyId) throw new HttpError(404, "receipt not found");
    const access = await authorize(account, r.companyId, ["view", "approve"]);
    if (!access.admin && !MONEY_RECEIPT_KINDS.includes(r.kind as any)) throw new HttpError(403, "members see money receipts only", "forbidden");
    const allowed = departmentScope(access);
    if (allowed && (!r.departmentId || !allowed.includes(r.departmentId))) throw new HttpError(403, "not your team", "forbidden");
    return { receipt: r };
  });

  // ---------- Tempo pocket ----------
  app.get<{ Querystring: { companyId: string } }>("/floats/tempo", async (req) => {
    const account = requireAccount(req);
    const { companyId } = req.query;
    if (!companyId) throw new HttpError(400, "companyId required");
    const access = await authorize(account, companyId, ["view"]);
    const allowed = departmentScope(access);
    const r = await getDb().execute(sql`
      select d.id as department_id, d.name, f.target, f.balance, f.reserved, f.enabled, f.paused, f.topups_today, f.updated_at,
        (select count(*) from bridge_transfers b where b.department_id = d.id and b.status in ('requested','bridging'))::int as in_flight
      from departments d left join rail_floats f on f.department_id = d.id and f.rail = 'tempo'
      where d.company_id = ${companyId}`);
    return { floats: allowed ? r.rows.filter((row: any) => allowed.includes(row.department_id)) : r.rows };
  });

  app.patch("/floats/tempo", async (req) => {
    const account = requireAccount(req);
    const body = parse(TempoFloatBody, req.body);
    const [d] = await getDb().select().from(departments).where(eq(departments.id, body.departmentId));
    if (!d) throw new HttpError(404, "department not found");
    await authorize(account, d.companyId, ["admin"], d.id);
    return { transaction: tx.setRailFloat(d.id, "tempo", body.target, body.enabled) };
  });

  // ---------- withdrawals ----------
  /** Plan a withdrawal (sources, quote, fees) → request_withdrawal transaction. Founder only. */
  app.post("/withdrawals", async (req) => {
    const account = requireAccount(req);
    const body = parse(WithdrawalBody, req.body);
    await requireFounder(account, body.companyId);
    const db = getDb();
    const intents = toBig(
      await view<string>(process.env.NETWORK === "mainnet" ? "intents.near" : "intents.testnet", "mt_balance_of", {
        account_id: body.companyId,
        token_id: process.env.NETWORK === "mainnet" ? "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" : "nep141:usdc.fakes.testnet",
      }).catch(() => "0"),
    );
    const floats = await db
      .select()
      .from(railFloats)
      .where(and(eq(railFloats.rail, "tempo"), inArray(railFloats.departmentId, sql`(select id from departments where company_id = ${body.companyId})`)));
    const tempoFree = floats.reduce((a, f) => a + (toBig(f.balance) - toBig(f.reserved) > 0n ? toBig(f.balance) - toBig(f.reserved) : 0n), 0n);
    const want = toBig(body.amount);
    if (want > intents + tempoFree) throw new HttpError(409, `only ${intents + tempoFree} available (reserved funds are excluded)`, "insufficient_funds");
    const sources = [
      { from: "intents", amount: (want < intents ? want : intents).toString() },
      ...(want > intents ? [{ from: "tempo", amount: (want - intents).toString(), estFee: ((want - intents) / 200n).toString() }] : []),
    ];
    const withdrawalId = randomUUID();
    return {
      plan: { withdrawalId, amount: body.amount, token: body.token, to: body.to, chain: body.chain, sources, available: { intents: intents.toString(), tempoUnreserved: tempoFree.toString() } },
      transaction: tx.requestWithdrawal(body.companyId, { withdrawalId, amount: body.amount, token: body.token, to: body.to, chain: body.chain }),
    };
  });

  // ---------- freeze ----------
  /** Pause all spending → freeze transactions per team (and the company). */
  app.post("/freeze", async (req) => {
    const account = requireAccount(req);
    const body = parse(FreezeBody, req.body);
    await authorize(account, body.companyId, ["admin"]);
    // Whole company: one tx, the company contract freezes every department itself.
    // Selected teams: forwarded through company.dept_call (departments only obey the company).
    for (const d of body.departments ?? [])
      if (!d.endsWith(`.${body.companyId}`)) throw new HttpError(400, `${d} is not a team of ${body.companyId}`, "invalid_request");
    const lim = await batchLimits(body.companyId);
    if (body.departments?.length) return { transactions: tx.freezeDepartments(body.companyId, body.departments, lim.deptCallsPerTx) };
    if (lim.legacy) {
      // Older company code can't cascade to 2+ teams (joint promise). Freeze every team, one tx each.
      const ids = (await views.getDepartments(body.companyId).catch(() => [])).map((d) => d.department_id);
      if (ids.length > 1) return { transactions: tx.freezeDepartments(body.companyId, ids, 1), legacy: true };
    }
    return { transactions: [tx.freeze(body.companyId)] };
  });

  app.post("/unfreeze", async (req) => {
    const account = requireAccount(req);
    const body = parse(FreezeBody, req.body);
    await requireFounder(account, body.companyId);
    // Resuming spend is founder-only; the company contract unfreezes every department.
    return { transactions: [tx.unfreeze(body.companyId)] };
  });

  void views;
};

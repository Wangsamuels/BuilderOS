import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { HttpError, InviteBody, PushSubscriptionBody, env } from "@builderos/shared";
import { and, desc, eq, getDb, invites, notifications, pushSubscriptions } from "@builderos/db";
import { tx, views } from "@builderos/near";
import { releaseWrapped, uploadWrapped } from "@builderos/keys";
import { hmacHex, randomToken, seal, serialize, serverKey, sha256Hex } from "@builderos/crypto";
import { authorize, linkCompany, requireAccount, requireFounder } from "../auth.js";
import { parse } from "../app.js";

const SCOPES: Record<string, string[]> = {
  viewer: ["view"],
  approver: ["view", "approve"],
  builder: ["view", "builder", "code"],
  admin: ["admin"],
};

export const memberRoutes: FastifyPluginAsync = async (app) => {
  // ---------- invites ----------
  /** Creates the invite + `invite` transaction. The email is sent only after the founder signs (member_invited event). */
  app.post("/members/invite", async (req) => {
    const account = requireAccount(req);
    const body = parse(InviteBody, req.body);
    await requireFounder(account, body.companyId);
    const code = randomToken(18);
    const codeHash = sha256Hex(code);
    const expiresAt = new Date(Date.now() + body.expiresInDays * 86400_000);
    const key = serverKey(env().SESSION_SECRET);
    const [row] = await getDb()
      .insert(invites)
      .values({
        companyId: body.companyId,
        emailHash: hmacHex(env().SESSION_SECRET, body.email.toLowerCase()),
        emailCiphertext: serialize(await seal(JSON.stringify({ email: body.email, code }), key, 0, "invite")),
        codeHash,
        departments: body.departments,
        template: body.template,
        limit: body.limit ?? null,
        expiresAt,
        createdBy: account,
      })
      .returning({ id: invites.id });
    return {
      inviteId: row.id,
      transaction: tx.invite(body.companyId, { inviteHash: codeHash, departments: body.departments.map((d) => (d.includes(".") ? d.split(".")[0] : d)), scopes: SCOPES[body.template], limit: body.limit ?? null, expiresAtMs: expiresAt.getTime() }),
    };
  });

  /** Invitee (signed in with their own NEAR account) accepts → accept_invite transaction. */
  app.post("/invites/accept", async (req) => {
    const account = requireAccount(req);
    const { code } = parse(z.object({ code: z.string().min(10) }), req.body);
    const [inv] = await getDb().select().from(invites).where(eq(invites.codeHash, sha256Hex(code)));
    if (!inv || inv.expiresAt < new Date() || inv.status === "revoked") throw new HttpError(404, "invite not found or expired");
    // Hint only: /auth/me lists the company once the accept_invite grant is live on chain.
    await linkCompany(account, inv.companyId, "invite");
    return { companyId: inv.companyId, transaction: tx.acceptInvite(inv.companyId, code) };
  });

  app.delete<{ Params: { account: string }; Querystring: { companyId: string } }>("/members/:account", async (req) => {
    const account = requireAccount(req);
    const { companyId } = req.query;
    if (!companyId) throw new HttpError(400, "companyId required");
    await requireFounder(account, companyId);
    // Wrapped keys are deleted when the indexer sees grant_revoked; founder is then prompted to rotate.
    return { transaction: tx.revoke(companyId, req.params.account) };
  });

  app.get<{ Querystring: { companyId: string } }>("/members", async (req) => {
    const account = requireAccount(req);
    const access = await authorize(account, req.query.companyId, ["view", "approve", "builder", "code"]);
    const { sql } = await import("@builderos/db");
    // Only the founder (or an admin the founder appointed) sees who else is in the company.
    const r = access.admin
      ? await getDb().execute(sql`select account_id, department_id, scopes, "limit", expires_at, revoked, (view_key is not null) as has_view_key
          from members_cache where company_id = ${req.query.companyId} order by account_id`)
      : await getDb().execute(sql`select account_id, department_id, scopes, "limit", expires_at, revoked, (view_key is not null) as has_view_key
          from members_cache where company_id = ${req.query.companyId} and account_id = ${account}`);
    return { members: r.rows, canManage: access.founder };
  });

  // ---------- keys ----------
  app.post("/keys/code/rotate", async (req) => {
    const account = requireAccount(req);
    const body = parse(z.object({ companyId: z.string(), newVersion: z.number().int().positive().optional() }), req.body);
    await requireFounder(account, body.companyId);
    const current = (await views.getCompany(body.companyId).catch(() => null))?.code_key_version ?? 0;
    const newVersion = body.newVersion ?? current + 1;
    if (newVersion <= current) throw new HttpError(409, `newVersion must be above the current version ${current}`, "version_conflict", { currentVersion: current });
    return {
      currentVersion: current,
      newVersion,
      transaction: { ...tx.rotateCodeKey(body.companyId, newVersion), signerId: account },
      // Order: 1) sign this tx  2) GET /v1/keys/devices?companyId=&kind=code  3) wrap the new key to each
      // device in the browser  4) POST /v1/keys/wrapped { kind:"code", version:newVersion, keys:[...] }
      // (refused with 409 until the contract shows newVersion).
      next: ["sign transaction", "GET /v1/keys/devices?companyId=&kind=code", "POST /v1/keys/wrapped"],
    };
  });

  app.post("/keys/wrapped", async (req) => {
    const account = requireAccount(req);
    const body = parse(
      z.object({
        companyId: z.string(),
        kind: z.enum(["code", "log"]),
        departmentId: z.string().nullable().optional(),
        version: z.number().int().nonnegative(),
        keys: z.array(z.object({ memberAccount: z.string(), ciphertext: z.string() })).min(1),
      }),
      req.body,
    );
    return uploadWrapped({ caller: account, ...body });
  });

  app.get<{ Querystring: { companyId: string; kind: "code" | "log"; departmentId?: string; version?: string } }>("/keys/wrapped", async (req) => {
    const account = requireAccount(req);
    const q = req.query;
    if (!q.companyId || !["code", "log"].includes(q.kind)) throw new HttpError(400, "companyId and kind required");
    return releaseWrapped({ caller: account, companyId: q.companyId, kind: q.kind, departmentId: q.departmentId, version: q.version ? Number(q.version) : undefined });
  });

  /** Register the x25519 view key on chain (keys are wrapped to it). */
  app.post("/keys/view", async (req) => {
    const account = requireAccount(req);
    const body = parse(z.object({ companyId: z.string(), x25519PublicKey: z.string().min(40).max(60) }), req.body);
    // Then POST /v1/keys/view/confirm { companyId, txHash } so the founder can wrap keys to it right away.
    return { transaction: { ...tx.registerViewKey(body.companyId, body.x25519PublicKey), signerId: account }, next: "POST /v1/keys/view/confirm" };
  });

  // ---------- notifications ----------
  app.get("/push/vapid", async () => ({ publicKey: env().VAPID_PUBLIC_KEY ?? null }));

  app.post("/push/subscribe", async (req) => {
    const account = requireAccount(req);
    const body = parse(PushSubscriptionBody, req.body);
    await getDb()
      .insert(pushSubscriptions)
      .values({ endpoint: body.endpoint, account, p256dh: body.keys.p256dh, auth: body.keys.auth })
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { account, p256dh: body.keys.p256dh, auth: body.keys.auth } });
    return { ok: true };
  });

  app.get("/notifications", async (req) => {
    const account = requireAccount(req);
    const rows = await getDb()
      .select()
      .from(notifications)
      .where(and(eq(notifications.account, account), eq(notifications.channel, "in-app")))
      .orderBy(desc(notifications.createdAt))
      .limit(100);
    return { notifications: rows };
  });

  app.post<{ Params: { id: string } }>("/notifications/:id/read", async (req) => {
    const account = requireAccount(req);
    await getDb().update(notifications).set({ read: true }).where(and(eq(notifications.id, req.params.id), eq(notifications.account, account)));
    return { ok: true };
  });
};

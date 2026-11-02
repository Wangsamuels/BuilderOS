import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { HttpError, InviteBody, PushSubscriptionBody, env } from "@builderos/shared";
import { accountEmails, and, desc, eq, getDb, invites, notifications, pushSubscriptions } from "@builderos/db";
import { tx } from "@builderos/near";
import { releaseWrapped, uploadWrapped } from "@builderos/keys";
import { hmacHex, randomToken, seal, serialize, serverKey, sha256Hex } from "@builderos/crypto";
import { authorize, requireAccount, requireFounder } from "../auth.js";
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
      transaction: tx.invite(body.companyId, { inviteHash: codeHash, departments: body.departments, scopes: SCOPES[body.template], limit: body.limit ?? null, expiresAtMs: expiresAt.getTime() }),
    };
  });

  /** Invitee (signed in with their own NEAR account) accepts → accept_invite transaction. */
  app.post("/invites/accept", async (req) => {
    requireAccount(req);
    const { code } = parse(z.object({ code: z.string().min(10) }), req.body);
    const [inv] = await getDb().select().from(invites).where(eq(invites.codeHash, sha256Hex(code)));
    if (!inv || inv.expiresAt < new Date() || inv.status === "revoked") throw new HttpError(404, "invite not found or expired");
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
    await authorize(account, req.query.companyId, ["view"]);
    const { sql } = await import("@builderos/db");
    const r = await getDb().execute(sql`select account_id, department_id, scopes, "limit", expires_at, revoked, (view_key is not null) as has_view_key
      from members_cache where company_id = ${req.query.companyId} order by account_id`);
    return { members: r.rows };
  });

  // ---------- keys ----------
  app.post("/keys/code/rotate", async (req) => {
    const account = requireAccount(req);
    const body = parse(z.object({ companyId: z.string(), newVersion: z.number().int().positive() }), req.body);
    await requireFounder(account, body.companyId);
    // After this tx lands, upload the new wrapped keys with POST /v1/keys/wrapped (version must match the contract).
    return { transaction: tx.rotateCodeKey(body.companyId, body.newVersion), next: "POST /v1/keys/wrapped" };
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
    requireAccount(req);
    const body = parse(z.object({ companyId: z.string(), x25519PublicKey: z.string() }), req.body);
    return { transaction: tx.registerViewKey(body.companyId, body.x25519PublicKey) };
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

  app.post("/me/email", async (req) => {
    const account = requireAccount(req);
    const { email } = parse(z.object({ email: z.string().email() }), req.body);
    const sealed = serialize(await seal(email, serverKey(env().SESSION_SECRET), 0));
    const emailHash = hmacHex(env().SESSION_SECRET, email.toLowerCase());
    await getDb().insert(accountEmails).values({ account, emailCiphertext: sealed, emailHash }).onConflictDoUpdate({ target: accountEmails.account, set: { emailCiphertext: sealed, emailHash } });
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

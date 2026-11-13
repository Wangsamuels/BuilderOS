import { env, type Logger } from "@builderos/shared";
import { QUEUES, companies, eq, getDb, invites, tasks } from "@builderos/db";
import type { IndexedEvent } from "@builderos/indexer";
import { resumeForRequest } from "@builderos/orchestrator";
import { alertFor, type Alert } from "@builderos/notify";
import { onGrantRevoked } from "@builderos/keys";
import { deserialize, openString, serverKey } from "@builderos/crypto";

export type EventDeps = {
  /** Queue a job (pg-boss in the worker; tests can run it inline). */
  send: (queue: string, data: object, opts?: Record<string, unknown>) => Promise<unknown>;
  log: Logger;
};

/** Indexed chain event → other services (task state, invites, keys, alerts, receipt verification). */
export async function handleEvent(e: IndexedEvent, deps: EventDeps) {
  const d = e.data;
  const { send, log } = deps;
  switch (e.event) {
    case "company_create_failed":
    case "refund_pending":
      // Tell the founder in-app; a pending refund is pulled with POST /v1/companies/claim-refund.
      await send(QUEUES.notify, {
        alert: {
          kind: "info",
          companyId: null,
          to: [d.founder],
          title: e.event === "refund_pending" ? "Refund ready to claim" : "Company creation failed",
          body:
            e.event === "refund_pending"
              ? "Your create-company deposit is waiting. Open BuilderOS and claim it."
              : `"${d.slug}" could not be created. Your deposit is refunded and the name is free again.`,
        } satisfies Alert,
      });
      break;
    case "task_assigned":
      await getDb().update(tasks).set({ status: "assigned", updatedAt: new Date() }).where(eq(tasks.id, d.task_id));
      break;
    case "purchase_approved":
      await resumeForRequest(d.request_id, log);
      break;
    case "withdrawal_requested":
      await send(QUEUES.bridgeWithdraw, { withdrawalId: d.withdrawal_id, companyId: d.company_id, amount: String(d.amount), token: d.token, to: d.to, chain: d.chain }, { singletonKey: d.withdrawal_id });
      break;
    case "grant_revoked": {
      if (!e.companyId) break;
      const [c] = await getDb().select().from(companies).where(eq(companies.id, e.companyId));
      await onGrantRevoked({ companyId: e.companyId, account: d.account_id, founder: c?.founderAccount });
      break;
    }
    case "member_invited": {
      // The founder confirmed on chain → now send the invite email.
      if (!d.invite_hash) break;
      const [inv] = await getDb().select().from(invites).where(eq(invites.codeHash, d.invite_hash));
      if (inv?.emailCiphertext && inv.status === "pending_confirmation") {
        const { email, code } = JSON.parse(await openString(deserialize(inv.emailCiphertext), serverKey(env().SESSION_SECRET), "invite"));
        const link = `${env().WEB_ORIGIN.split(",")[0]}/invite?code=${encodeURIComponent(code)}`;
        await send(QUEUES.notify, {
          alert: { kind: "invite", companyId: inv.companyId, title: "You're invited", body: link, to: [], email: { to: email, subject: "You've been invited to a BuilderOS company", text: `Accept here: ${link}` } } satisfies Alert,
        });
        await getDb().update(invites).set({ status: "sent" }).where(eq(invites.id, inv.id));
      }
      break;
    }
  }
  if (e.receiptRowId && d.foreign_tx) await send(QUEUES.verify, { receiptId: e.receiptRowId }, { singletonKey: e.receiptRowId });
  const alert = alertFor(e.event, d, e.companyId, env().WEB_ORIGIN);
  if (alert) await send(QUEUES.notify, { alert });
}

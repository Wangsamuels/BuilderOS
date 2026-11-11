import { network, type Logger } from "@builderos/shared";
import { EVENTS_CHANNEL, departments, getDb, sql } from "@builderos/db";
import { baseUsdcBalance, views } from "@builderos/near";

/**
 * Team Base USDC addresses aren't NEAR accounts, so the NEAR indexer never sees money arrive there.
 * This sweep reads each team's balance and, when it went up, writes a `deposit_received` event
 * (same table, same SSE path as chain events). The first reading of an address only records a baseline.
 */
export async function sweepTeamDeposits(log: Logger) {
  const db = getDb();
  const n = network();
  const teams = await db.select({ id: departments.id, companyId: departments.companyId }).from(departments);
  let emitted = 0;
  for (const t of teams) {
    try {
      const v = await views.getDepartment(t.id).catch(() => null);
      const address = v?.base_address;
      if (!address) continue;
      const balance = BigInt(await baseUsdcBalance(address, n.base.usdc));
      const key = `${n.base.chainId}:${n.base.usdc}:${address}`.toLowerCase();
      const prev = (await db.execute<{ balance: string }>(sql`select balance from address_balances where address = ${key}`)).rows[0];
      await db.execute(sql`insert into address_balances (address, company_id, department_id, balance, updated_at)
        values (${key}, ${t.companyId}, ${t.id}, ${balance.toString()}, now())
        on conflict (address) do update set balance = excluded.balance, updated_at = now()`);
      if (!prev || balance <= BigInt(prev.balance)) continue;
      const amount = balance - BigInt(prev.balance);
      const data = { company_id: t.companyId, department_id: t.id, address, chain_id: n.base.chainId, token: n.base.usdc, amount: amount.toString(), balance: balance.toString() };
      const r = await db.execute<{ id: string }>(sql`insert into events (event, standard, version, contract, company_id, department_id, data, receipt_id, log_index, block_height, near_tx)
        values ('deposit_received', 'builderos', '1.0.0', ${`base:${n.base.chainId}`}, ${t.companyId}, ${t.id}, ${JSON.stringify(data)}::jsonb,
          ${`deposit:${key}:${balance.toString()}`}, 0, 0, '')
        on conflict do nothing returning id`);
      const id = r.rows[0]?.id;
      if (id) {
        await db.execute(sql`select pg_notify(${EVENTS_CHANNEL}, ${String(id)})`);
        emitted++;
      }
    } catch (e: any) {
      log.warn({ team: t.id, err: e?.message }, "deposit sweep failed for team");
    }
  }
  return { teams: teams.length, emitted };
}

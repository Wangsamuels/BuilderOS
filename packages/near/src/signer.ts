import { Account, KeyPair, connect, keyStores } from "near-api-js";
import type { KeyPairString } from "near-api-js/lib/utils/key_pair";
import { network } from "@builderos/shared";

/**
 * Service-side signer for request-only / record-only function-call keys.
 * These keys cannot transfer NEAR or call payout methods; the contract enforces that.
 */
const accounts = new Map<string, Account>();

export async function serviceAccount(accountId: string, privateKey: string): Promise<Account> {
  const cacheKey = `${accountId}:${privateKey.slice(-8)}`;
  const hit = accounts.get(cacheKey);
  if (hit) return hit;
  const n = network();
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(n.id, accountId, KeyPair.fromString(privateKey as KeyPairString));
  const near = await connect({ networkId: n.id, nodeUrl: n.rpcUrl, keyStore });
  const acc = await near.account(accountId);
  accounts.set(cacheKey, acc);
  return acc;
}

export type ServiceCall = { contractId: string; methodName: string; args: Record<string, unknown>; gas: bigint; attachedDeposit?: bigint };

export async function callAs(account: Account, c: ServiceCall) {
  const outcome = await account.functionCall({
    contractId: c.contractId,
    methodName: c.methodName,
    args: c.args,
    gas: c.gas,
    attachedDeposit: c.attachedDeposit ?? 0n,
  });
  const status = outcome.status as any;
  const value = status?.SuccessValue ? JSON.parse(Buffer.from(status.SuccessValue, "base64").toString("utf8") || "null") : null;
  return { txHash: outcome.transaction.hash as string, value, outcome };
}

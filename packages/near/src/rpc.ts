import { network, sleep } from "@builderos/shared";

export class RpcError extends Error {
  constructor(message: string, public data?: unknown) {
    super(message);
  }
}

let id = 0;
/** Minimal JSON-RPC client with a fallback URL and retry on 429/5xx. */
export async function rpc<T = any>(method: string, params: unknown, attempt = 0): Promise<T> {
  const n = network();
  const url = attempt % 2 === 0 ? n.rpcUrl : n.rpcFallbackUrl;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429 || res.status >= 500) throw new RpcError(`rpc ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message: string; data?: unknown; cause?: { name: string } } };
    if (body.error) {
      const name = body.error.cause?.name ?? body.error.message;
      // Non-retryable semantic errors bubble up immediately.
      throw Object.assign(new RpcError(name, body.error.data), { fatal: true });
    }
    return body.result as T;
  } catch (e: any) {
    if (e?.fatal || attempt >= 4) throw e;
    await sleep(300 * 2 ** attempt);
    return rpc<T>(method, params, attempt + 1);
  }
}

/** Call a view method and JSON-decode the result. */
export async function view<T = any>(contractId: string, methodName: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await rpc<{ result: number[] }>("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contractId,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  const text = Buffer.from(res.result).toString("utf8");
  return (text ? JSON.parse(text) : null) as T;
}

export type AccessKey = { public_key: string; access_key: { nonce: number; permission: "FullAccess" | { FunctionCall: { receiver_id: string; method_names: string[]; allowance: string | null } } } };

export async function accessKeys(accountId: string): Promise<AccessKey[]> {
  const res = await rpc<{ keys: AccessKey[] }>("query", { request_type: "view_access_key_list", finality: "final", account_id: accountId });
  return res.keys;
}

export type AccountView = {
  exists: boolean;
  /** Liquid balance in yoctoNEAR (amount − locked when present). */
  availableYocto: string;
  amountYocto: string;
  lockedYocto: string;
};

/** view_account; nonexistent / unfunded implicit accounts → exists:false, zeros. */
export async function viewAccount(accountId: string): Promise<AccountView> {
  try {
    const res = await rpc<{ amount: string; locked: string }>("query", {
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    });
    const amount = BigInt(res.amount ?? "0");
    const locked = BigInt(res.locked ?? "0");
    const available = amount > locked ? amount - locked : 0n;
    return {
      exists: true,
      availableYocto: available.toString(),
      amountYocto: amount.toString(),
      lockedYocto: locked.toString(),
    };
  } catch (e: any) {
    const msg = String(e?.message ?? e ?? "");
    if (/does not exist|UNKNOWN_ACCOUNT|InvalidAccount|AccountDoesNotExist/i.test(msg)) {
      return { exists: false, availableYocto: "0", amountYocto: "0", lockedYocto: "0" };
    }
    throw e;
  }
}

export async function finalBlock() {
  return rpc<any>("block", { finality: "final" });
}
export async function blockAt(height: number) {
  return rpc<any>("block", { block_id: height });
}
export async function chunk(chunkHash: string) {
  return rpc<any>("chunk", { chunk_id: chunkHash });
}
export async function txStatus(txHash: string, senderId: string) {
  return rpc<any>("EXPERIMENTAL_tx_status", { tx_hash: txHash, sender_account_id: senderId, wait_until: "FINAL" });
}

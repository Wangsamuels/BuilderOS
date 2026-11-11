import bs58 from "bs58";
import { keccak_256 } from "@noble/hashes/sha3";
import { network } from "@builderos/shared";
import { view } from "./rpc.js";
import type { EvmConfig } from "./contracts.js";

/** Must match `MPC_PATH` in contracts/department: the team's Base address derivation path. */
export const TEAM_PAYMENT_PATH = "builderos-base";

/** EVM address of a secp256k1 key given as "secp256k1:<base58 of the 64-byte uncompressed point>". */
export function evmAddressFromMpcKey(key: string): string {
  const raw = bs58.decode(key.replace(/^secp256k1:/, ""));
  const xy = raw.length === 65 ? raw.slice(1) : raw;
  if (xy.length !== 64) throw new Error("unexpected secp256k1 key length");
  return `0x${Buffer.from(keccak_256(xy).slice(12)).toString("hex")}`;
}

/**
 * The Base address Chain Signatures controls for a team account. Only that team's contract can ask
 * v1.signer to sign for it (the derivation uses the caller's account id), so nobody else can spend from it.
 */
export async function teamPaymentAddress(departmentAccount: string): Promise<string> {
  const key = await view<string>(network().mpcSigner, "derived_public_key", { path: TEAM_PAYMENT_PATH, predecessor: departmentAccount, domain_id: 0 });
  return evmAddressFromMpcKey(key);
}

export async function teamEvmConfig(departmentAccount: string): Promise<EvmConfig> {
  const n = network();
  return { chain_id: n.base.chainId, usdc: n.base.usdc, from: await teamPaymentAddress(departmentAccount) };
}

/** ERC-20 balanceOf on Base (atomic units; USDC = micro-USDC). Plain JSON-RPC, no wallet library. */
export async function baseUsdcBalance(holder: string, token = network().base.usdc): Promise<string> {
  const data = `0x70a08231${holder.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
  const res = await fetch(network().base.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data }, "latest"] }),
    signal: AbortSignal.timeout(10_000),
  });
  const j: any = await res.json();
  if (j.error || typeof j.result !== "string") throw new Error(`base balanceOf failed: ${j.error?.message ?? "no result"}`);
  return BigInt(j.result === "0x" ? 0 : j.result).toString();
}

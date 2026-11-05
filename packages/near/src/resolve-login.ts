import { isFullAccessKey, matchesImplicitAccount, publicKeyToImplicitAccountId } from "./nep413.js";

/** FE-invented names that are not on-chain (Privy email/Google flow). */
export function isSyntheticPrivyAccountId(accountId: string): boolean {
  return /^bos-[a-z0-9_-]+\.(testnet|near)$/i.test(accountId);
}

/**
 * Resolve the account id for a session after NEP-413 verified key ownership.
 * Prefer the key's implicit hex id for Privy; only keep a named id when it has FullAccess on-chain.
 */
export async function resolveLoginAccountId(
  claimed: string,
  publicKey: string,
  log?: { warn: (obj: object, msg: string) => void },
): Promise<string> {
  const implicit = publicKeyToImplicitAccountId(publicKey);
  if (claimed === implicit || matchesImplicitAccount(claimed, publicKey)) return implicit;

  // Never RPC for synthetic bos-* names — they do not exist and slow login / hang UIs.
  if (isSyntheticPrivyAccountId(claimed) || isLikelyUnregistered(claimed)) {
    log?.warn({ claimed, implicit }, "auth: synthetic/unregistered → Privy implicit");
    return implicit;
  }

  try {
    const ok = await Promise.race([
      isFullAccessKey(claimed, publicKey),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_500)),
    ]);
    if (ok) return claimed;
  } catch {
    /* fall through */
  }
  log?.warn({ claimed, implicit }, "auth: named FullAccess miss → Privy implicit");
  return implicit;
}

function isLikelyUnregistered(accountId: string): boolean {
  // Pure hex implicit already handled; bare strings without a TLA are not NEAR named accounts.
  return !accountId.includes(".");
}

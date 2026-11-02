import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import bs58 from "bs58";
import { nep413Payload, verifyNep413 } from "../../packages/near/src/nep413.js";
import { parseEventLog } from "../../packages/near/src/events.js";
import { buildReceipt, scopeOf } from "../../packages/indexer/src/receipts.js";
import { estimate, classifyTag } from "../../packages/router/src/index.js";
import { feeOk, needsTopup, topupAmount, MIN_TOPUP } from "../../packages/bridge/src/index.js";
import { parseMppHeader, canonicalJson } from "../../packages/rails/src/index.js";
import { heuristicPlan, topoOrder } from "../../packages/orchestrator/src/planner.js";
import { seal, openString } from "../../packages/crypto/src/index.js";

describe("NEP-413 sign-in", () => {
  it("verifies a wallet signMessage signature and rejects tampering", () => {
    const sk = ed25519.utils.randomPrivateKey();
    const pk = `ed25519:${bs58.encode(ed25519.getPublicKey(sk))}`;
    const nonce = new Uint8Array(32).fill(7);
    const message = "Sign in to BuilderOS";
    const sig = Buffer.from(ed25519.sign(sha256(nep413Payload({ message, nonce, recipient: "builderos" })), sk)).toString("base64");
    expect(verifyNep413({ publicKey: pk, signature: sig, message, nonce, recipient: "builderos" })).toBe(true);
    expect(verifyNep413({ publicKey: pk, signature: sig, message: message + "!", nonce, recipient: "builderos" })).toBe(false);
    expect(verifyNep413({ publicKey: pk, signature: sig, message, nonce, recipient: "evil" })).toBe(false);
  });
});

describe("events and receipts", () => {
  it("parses NEP-297 builderos events and dead-letters unknown ones", () => {
    const ok = parseEventLog('EVENT_JSON:{"standard":"builderos","version":"1.0.0","event":"payment_signed","data":[{"request_id":"r1","seller_id":"s","rail":"x402-evm","amount":"100"}]}');
    expect(ok && ok.ok).toBe(true);
    const bad = parseEventLog('EVENT_JSON:{"standard":"builderos","version":"1.0.0","event":"nope","data":[]}');
    expect(bad && !bad.ok).toBe(true);
    expect(parseEventLog("plain log")).toBeNull();
    expect(parseEventLog('EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[]}')).toBeNull();
  });
  it("builds a receipt for every money and permission event", () => {
    expect(buildReceipt("payment_signed", { request_id: "r", amount: "5", rail: "x402-evm", seller_id: "s" }, "a")?.kind).toBe("purchase");
    expect(buildReceipt("grant_revoked", { account_id: "bob" }, "a")?.kind).toBe("membership");
    expect(buildReceipt("code_key_rotated", { company_id: "c", version: 2 }, "a")?.kind).toBe("keys_policy");
  });
  it("derives company / department from the contract account", () => {
    expect(scopeOf("acme.builderos.testnet", "builderos.testnet")).toEqual({ companyId: "acme.builderos.testnet", departmentId: null });
    expect(scopeOf("build.acme.builderos.testnet", "builderos.testnet")).toEqual({ companyId: "acme.builderos.testnet", departmentId: "build.acme.builderos.testnet" });
  });
});

describe("router", () => {
  it("estimates p50 <= p90 and cap = p90 × 1.5", () => {
    const e = estimate("backend", "m", "standard");
    expect(BigInt(e.p50) <= BigInt(e.p90)).toBe(true);
    expect(BigInt(e.cap)).toBe((BigInt(e.p90) * 3n) / 2n);
  });
  it("classifies tags", () => {
    expect(classifyTag("Write the NEAR contract for escrow")).toBe("contract");
    expect(classifyTag("Landing page component")).toBe("frontend");
  });
});

describe("bridge rules", () => {
  it("tops up below 25% or when a purchase exceeds the pocket", () => {
    expect(needsTopup(100n, 20n, 0n)).toBe(true);
    expect(needsTopup(100n, 30n, 0n)).toBe(false);
    expect(needsTopup(100n, 30n, 40n)).toBe(true);
  });
  it("tops up to 50% of target, min $10", () => {
    expect(topupAmount(100_000_000n, 20_000_000n)).toBe(30_000_000n);
    expect(topupAmount(20_000_000n, 5_000_000n)).toBe(MIN_TOPUP);
  });
  it("fee guard is 1%", () => {
    expect(feeOk(1_000_000n, 10_000n)).toBe(true);
    expect(feeOk(1_000_000n, 10_001n)).toBe(false);
  });
});

describe("rails + planner + crypto", () => {
  it("parses MPP challenges", () => {
    const req = Buffer.from(JSON.stringify({ amount: "100", recipient: "0xabc" })).toString("base64url");
    const c = parseMppHeader(`Payment id="x1", method="tempo", intent="charge", request="${req}"`);
    expect(c?.request.amount).toBe("100");
  });
  it("canonical json is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
  });
  it("plans are DAGs; cycles are rejected", () => {
    const f = heuristicPlan("Build the API endpoint for signups.\nBuild the landing page UI.\nWrite tests for signup.");
    expect(topoOrder(f).length).toBe(f.length);
    expect(() => topoOrder([{ key: "a", title: "", tag: "", size: "", dependsOn: ["b"] }, { key: "b", title: "", tag: "", size: "", dependsOn: ["a"] }])).toThrow();
  });
  it("seals and opens with XChaCha20-Poly1305", async () => {
    const key = new Uint8Array(32).fill(1);
    const s = await seal("secret plan", key, 1);
    expect(await openString(s, key)).toBe("secret plan");
    await expect(openString(s, new Uint8Array(32).fill(2))).rejects.toThrow();
  });
});

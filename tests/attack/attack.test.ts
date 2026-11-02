import { describe, expect, it } from "vitest";
import { buildPaymentHeaders, PayeeMismatch, challengeHash, type Challenge, type SignedPurchase } from "../../packages/rails/src/index.js";
import { pickChallenge } from "../../packages/fetch/src/index.js";

/**
 * Off-chain attack cases (the contract-side cases — overspend, daily cap, revoked member, replayed
 * challenge — run in the integration suite against near-workspaces contracts).
 */
const req = { scheme: "exact" as const, network: "base-sepolia", maxAmountRequired: "1000", resource: "r", payTo: "0x1111111111111111111111111111111111111111", maxTimeoutSeconds: 60, asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" };
const ch: Challenge = { rail: "x402-evm", requirement: req, raw: {} };
const signed: SignedPurchase = {
  rail: "x402-evm",
  request_id: "r1",
  authorization: { from: "0x9999999999999999999999999999999999999999", to: req.payTo, value: "1000", validAfter: "0", validBefore: "9999999999", nonce: `0x${"00".repeat(32)}` },
  signature: { big_r: { affine_point: `02${"11".repeat(32)}` }, s: { scalar: "22".repeat(32) }, recovery_id: 1 },
};

describe("attack: injected payee / wrong payTo", () => {
  it("refuses when the seller's payTo differs from what the contract authorised", () => {
    const evil: Challenge = { ...ch, requirement: { ...req, payTo: "0x000000000000000000000000000000000000dEaD" } } as Challenge;
    expect(() => buildPaymentHeaders(evil, signed)).toThrow(PayeeMismatch);
  });
  it("refuses when the authorised value exceeds the challenge", () => {
    expect(() => buildPaymentHeaders(ch, { ...signed, authorization: { ...signed.authorization, value: "1001" } } as SignedPurchase)).toThrow(PayeeMismatch);
  });
  it("builds a valid X-PAYMENT header otherwise", () => {
    const h = buildPaymentHeaders(ch, signed);
    const p = JSON.parse(Buffer.from(h["X-PAYMENT"], "base64").toString());
    expect(p.payload.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });
});

describe("attack: replayed challenge", () => {
  it("same challenge hashes identically (the contract keys purchases by challenge_hash, so a replay can't pay twice)", () => {
    expect(challengeHash(ch)).toBe(challengeHash({ ...ch, requirement: { ...req } } as Challenge));
  });
});

describe("rail selection", () => {
  it("prefers the configured rail, then the cheaper price", () => {
    const cheap: Challenge = { ...ch, requirement: { ...req, maxAmountRequired: "500" } } as Challenge;
    expect(pickChallenge([ch, cheap])).toBe(cheap);
  });
});

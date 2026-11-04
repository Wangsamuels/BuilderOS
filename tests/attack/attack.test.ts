import { describe, expect, it } from "vitest";
import {
  buildPaymentHeaders,
  PayeeMismatch,
  challengeHash,
  parsePaymentRequiredHeader,
  normalizeX402Requirement,
  isBaseX402Network,
  type Challenge,
  type SignedPurchase,
} from "../../packages/rails/src/index.js";
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
  it("builds PAYMENT-SIGNATURE for x402 v2 (PingPay)", () => {
    const v2: Challenge = { rail: "x402-evm", requirement: { ...req, network: "eip155:8453", x402Version: 2 }, raw: {} };
    const h = buildPaymentHeaders(v2, signed);
    expect(h["PAYMENT-SIGNATURE"]).toBeTruthy();
    const p = JSON.parse(Buffer.from(h["PAYMENT-SIGNATURE"], "base64").toString());
    expect(p.x402Version).toBe(2);
  });
});

describe("x402 v2 PAYMENT-REQUIRED (PingPay)", () => {
  it("decodes CAIP-2 Base accepts into an x402-evm challenge", () => {
    const payload = {
      x402Version: 2,
      error: "PAYMENT-SIGNATURE header is required",
      resource: { url: "https://x402.pingpay.io/inference/near-ai/chat/completions" },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: "1000",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1321223B9bA9673974356B3fE286fB81E1747469",
          maxTimeoutSeconds: 60,
          extra: { name: "USDC", version: "2" },
        },
      ],
    };
    const header = Buffer.from(JSON.stringify(payload)).toString("base64");
    const chs = parsePaymentRequiredHeader(header);
    expect(chs).toHaveLength(1);
    expect(chs[0].rail).toBe("x402-evm");
    if (chs[0].rail !== "x402-evm") return;
    expect(chs[0].requirement.maxAmountRequired).toBe("1000");
    expect(chs[0].requirement.x402Version).toBe(2);
    expect(chs[0].requirement.payTo.toLowerCase()).toBe("0x1321223b9ba9673974356b3fe286fb81e1747469");
  });
  it("normalizes v2 amount field and recognizes Base CAIP-2 networks", () => {
    expect(isBaseX402Network("eip155:8453")).toBe(true);
    expect(isBaseX402Network("eip155:84532")).toBe(true);
    const n = normalizeX402Requirement({ scheme: "exact", network: "eip155:8453", amount: "42", asset: "0x1", payTo: "0x2", maxTimeoutSeconds: 60 }, 2);
    expect(n?.maxAmountRequired).toBe("42");
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

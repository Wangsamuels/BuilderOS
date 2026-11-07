/**
 * `pnpm demo` — offline walk-through against the seller mesh (no internet):
 * 1) plan estimate
 * 2) x402 model payment (Base USDC)
 * 3) MPP Tempo-only seller (outside x402)
 * 4) Relay mock quote Base → Tempo USDC.e
 * 5) bridge fee rules
 */
import { buildPaymentHeaders, challengeHash, parseChallenges, settlementTx, type SignedPurchase } from "../packages/rails/src/index.js";
import { estimate } from "../packages/router/src/index.js";
import { heuristicPlan, topoOrder } from "../packages/orchestrator/src/planner.js";
import { bridgeClients, feeOk, topupAmount } from "../packages/bridge/src/index.js";

const MESH = process.env.SELLER_MESH_URL ?? "http://localhost:4100";
process.env.USE_SELLER_MESH ??= "true";
process.env.TEMPO_ENABLED ??= "true";
process.env.BRIDGE_MOCK_URL ??= `${MESH}/bridge`;

async function main() {
  const health = await fetch(`${MESH}/health`).catch(() => null);
  if (!health?.ok) throw new Error(`seller mesh not running at ${MESH} — run: pnpm --filter @builderos/seller-mesh start`);

  console.log("\n1) Plan + estimate");
  const feats = heuristicPlan("Build a landing page with waitlist signup.\nAdd an API endpoint that stores emails in the database.\nWrite tests for the signup flow.");
  console.log(topoOrder(feats).map((k) => `${k}: ${feats.find((f) => f.key === k)!.title} [${feats.find((f) => f.key === k)!.tag}]`).join("\n"));
  console.log("standard tier, backend m:", estimate("backend", "m", "standard"));

  console.log("\n2) x402 model seller (Base USDC)");
  const url = `${MESH}/sellers/near-ai.x402/v1/chat/completions`;
  const body = JSON.stringify({ model: "gpt-5-mini", messages: [{ role: "user", content: "hello" }] });
  const r1 = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  const [ch] = await parseChallenges(r1);
  console.log(`status ${r1.status}, rail ${ch.rail}, hash ${challengeHash(ch).slice(0, 16)}…`);

  console.log("\n3) request_purchase → contract approves → v1.signer signs (simulated signature)");
  const req = (ch as any).requirement;
  const signed: SignedPurchase = {
    rail: "x402-evm",
    request_id: "demo-1",
    authorization: { from: "0x9999999999999999999999999999999999999999", to: req.payTo, value: req.maxAmountRequired, validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 60), nonce: `0x${"ab".repeat(32)}` },
    signature: { big_r: { affine_point: `02${"11".repeat(32)}` }, s: { scalar: "22".repeat(32) }, recovery_id: 0 },
  };
  const headers = buildPaymentHeaders(ch, signed);
  const r2 = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  console.log(`retry status ${r2.status}, settlement tx ${settlementTx(r2)}`);

  console.log("\n4) MPP-only seller (Tempo — outside x402)");
  const mppUrl = `${MESH}/sellers/tempo-mpp.demo/v1/run`;
  const m1 = await fetch(mppUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const mppChs = await parseChallenges(m1);
  const mpp = mppChs[0];
  console.log(`status ${m1.status}, rail ${mpp.rail}, amount ${(mpp as any).mpp?.request?.amount}`);
  const mppSigned: SignedPurchase = {
    rail: "mpp-tempo-charge",
    request_id: "demo-mpp-1",
    signed_tx: "0xmock_tempo_signed",
    source: "department-tempo-pocket",
  };
  const mppHeaders = buildPaymentHeaders(mpp, mppSigned);
  const m2 = await fetch(mppUrl, { method: "POST", headers: { "content-type": "application/json", ...mppHeaders }, body: "{}" });
  console.log(`MPP retry status ${m2.status}, receipt ${settlementTx(m2) ?? m2.headers.get("payment-receipt")?.slice(0, 24)}`);

  console.log("\n5) Relay mock: Base USDC → Tempo USDC.e (funds MPP pocket)");
  const quote = await bridgeClients.relayQuote({
    amount: "10000000",
    user: "0x9999999999999999999999999999999999999999",
    recipient: "0x9999999999999999999999999999999999999999",
  });
  console.log(`relay request ${quote.quoteId.slice(0, 18)}… out ${quote.amountOut} fees ${quote.fees} deposit ${quote.depositAddress.slice(0, 12)}…`);
  const st1 = await bridgeClients.relayStatus(quote.quoteId);
  const st2 = await bridgeClients.relayStatus(quote.quoteId);
  console.log(`relay status poll: ${st1.status} → ${st2.status}`);

  console.log("\n6) Attack: injected payee is refused before paying");
  try {
    buildPaymentHeaders(ch, { ...signed, authorization: { ...signed.authorization, to: "0x000000000000000000000000000000000000dEaD" } } as SignedPurchase);
  } catch (e: any) {
    console.log(`refused: ${e.message}`);
  }

  console.log("\n7) Bridge rules");
  console.log("top-up for target $100, balance $20:", Number(topupAmount(100_000_000n, 20_000_000n)) / 1e6, "USDC; fee 0.5% ok?", feeOk(1_000_000n, 5_000n));
  console.log("\ndone.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

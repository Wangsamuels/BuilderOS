import { env, network } from "@builderos/shared";

/**
 * Storage deposits attached on create txs (must cover wasm storage on NEAR).
 * company.wasm ≈ 670KB → ~6.7 NEAR; department.wasm ≈ 340KB → ~3.4 NEAR (+ agent gas).
 * Contract mins: create_company ≥ 7.5 NEAR, create_department ≥ 4.5 NEAR.
 */
export const CREATE_COMPANY_DEPOSIT_YOCTO = 7_500_000_000_000_000_000_000_000n; // 7.5 NEAR
export const CREATE_DEPARTMENT_DEPOSIT_YOCTO = 4_500_000_000_000_000_000_000_000n; // 4.5 NEAR
/** Extra headroom for gas after create (not attached as deposit). */
export const CREATE_COMPANY_GAS_BUFFER_YOCTO = 1_000_000_000_000_000_000_000_000n; // 1 NEAR

const YOCTO_PER_NEAR = 10n ** 24n;

export function yoctoToNear(yocto: bigint): string {
  const whole = yocto / YOCTO_PER_NEAR;
  const frac = yocto % YOCTO_PER_NEAR;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(24, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

export function nearToYocto(near: string): bigint {
  const [w, f = ""] = near.split(".");
  const frac = (f + "0".repeat(24)).slice(0, 24);
  return BigInt(w || "0") * YOCTO_PER_NEAR + BigInt(frac || "0");
}

/**
 * NEAR the founder must cover to sign the default company create bundle.
 * Default 3 teams → 7.5 + 4.5×3 + 1 = 22 NEAR recommended.
 */
export function companyCreateFunding(departmentCount = 3) {
  const depts = BigInt(Math.max(0, departmentCount));
  const deposits = CREATE_COMPANY_DEPOSIT_YOCTO + depts * CREATE_DEPARTMENT_DEPOSIT_YOCTO;
  const recommended = deposits + CREATE_COMPANY_GAS_BUFFER_YOCTO;
  const n = network();
  const e = env();
  const sponsor = e.TESTNET_SPONSOR_ACCOUNT_ID;
  // The factory/registry/worker/verifier balances back storage and refunds — never drip from them.
  const sponsorSafe = Boolean(sponsor) && ![n.factory, n.registry, e.WORKER_ACCOUNT_ID, e.VERIFIER_ACCOUNT_ID].includes(sponsor);
  const autoFundAvailable = n.id === "testnet" && sponsorSafe && Boolean(e.TESTNET_SPONSOR_PRIVATE_KEY);
  return {
    network: n.id,
    currency: "NEAR",
    departmentCount: Number(depts),
    createCompanyYocto: CREATE_COMPANY_DEPOSIT_YOCTO.toString(),
    createCompanyNear: yoctoToNear(CREATE_COMPANY_DEPOSIT_YOCTO),
    perDepartmentYocto: CREATE_DEPARTMENT_DEPOSIT_YOCTO.toString(),
    perDepartmentNear: yoctoToNear(CREATE_DEPARTMENT_DEPOSIT_YOCTO),
    totalDepositYocto: deposits.toString(),
    totalDepositNear: yoctoToNear(deposits),
    recommendedYocto: recommended.toString(),
    recommendedNear: yoctoToNear(recommended),
    breakdown: [
      { action: "create_company", near: yoctoToNear(CREATE_COMPANY_DEPOSIT_YOCTO) },
      ...Array.from({ length: Number(depts) }, (_, i) => ({
        action: `create_department_${i + 1}`,
        near: yoctoToNear(CREATE_DEPARTMENT_DEPOSIT_YOCTO),
      })),
      { action: "gas_buffer", near: yoctoToNear(CREATE_COMPANY_GAS_BUFFER_YOCTO) },
    ],
    faucetUrl: n.id === "testnet" ? "https://near-faucet.io/" : null,
    autoFundAvailable,
    userMustDeposit: !autoFundAvailable,
    hint: autoFundAvailable
      ? `Testnet will auto-fund ~${yoctoToNear(recommended)} NEAR so you can create a company without a faucet wall.`
      : n.id === "testnet"
        ? `Need ~${yoctoToNear(recommended)} testnet NEAR to create a company (${yoctoToNear(CREATE_COMPANY_DEPOSIT_YOCTO)} NEAR company + ${yoctoToNear(CREATE_DEPARTMENT_DEPOSIT_YOCTO)} NEAR × ${depts} teams + gas).`
        : `Fund about ${yoctoToNear(recommended)} NEAR before creating a company.`,
  };
}

import { env, network } from "@builderos/shared";

/**
 * Storage deposits attached on create txs (must be ≥ contract minimums).
 * Factory: ≥ 2.5 NEAR · Department: ≥ 1 NEAR each.
 */
export const CREATE_COMPANY_DEPOSIT_YOCTO = 2_500_000_000_000_000_000_000_000n; // 2.5 NEAR
export const CREATE_DEPARTMENT_DEPOSIT_YOCTO = 1_000_000_000_000_000_000_000_000n; // 1 NEAR
/** Extra headroom for gas after create (not attached as deposit). */
export const CREATE_COMPANY_GAS_BUFFER_YOCTO = 500_000_000_000_000_000_000_000n; // 0.5 NEAR

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
 * With TESTNET_SPONSOR_* configured, FE should auto-fund instead of blocking the UI.
 */
export function companyCreateFunding(departmentCount = 3) {
  const depts = BigInt(Math.max(0, departmentCount));
  const deposits = CREATE_COMPANY_DEPOSIT_YOCTO + depts * CREATE_DEPARTMENT_DEPOSIT_YOCTO;
  const recommended = deposits + CREATE_COMPANY_GAS_BUFFER_YOCTO;
  const n = network();
  const e = env();
  const autoFundAvailable = n.id === "testnet" && Boolean(e.TESTNET_SPONSOR_ACCOUNT_ID && e.TESTNET_SPONSOR_PRIVATE_KEY);
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
    /** When true, FE should call POST /v1/auth/fund-testnet — do not hard-wall the dashboard. */
    autoFundAvailable,
    /** Physics: company create always needs storage NEAR; user may not have to supply it on testnet. */
    userMustDeposit: !autoFundAvailable,
    hint: autoFundAvailable
      ? `Testnet will auto-fund ~${yoctoToNear(recommended)} NEAR so you can create a company without a faucet wall.`
      : n.id === "testnet"
        ? `Need ~${yoctoToNear(recommended)} testnet NEAR to create a company (2.5 + 1×${depts} teams + gas). Prefer configuring TESTNET_SPONSOR so signup stays frictionless.`
        : `Fund about ${yoctoToNear(recommended)} NEAR before creating a company.`,
  };
}

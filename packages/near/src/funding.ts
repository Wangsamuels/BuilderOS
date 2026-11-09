import { network } from "@builderos/shared";

/** Storage deposits the founder signs with `create_company` / `create_department` (yoctoNEAR). */
export const CREATE_COMPANY_DEPOSIT_YOCTO = 5_000_000_000_000_000_000_000_000n; // 5 NEAR
export const CREATE_DEPARTMENT_DEPOSIT_YOCTO = 3_000_000_000_000_000_000_000_000n; // 3 NEAR
/** Extra headroom for gas / first txs after create (not attached as deposit). */
export const CREATE_COMPANY_GAS_BUFFER_YOCTO = 1_000_000_000_000_000_000_000_000n; // 1 NEAR

const YOCTO_PER_NEAR = 10n ** 24n;

export function yoctoToNear(yocto: bigint): string {
  const whole = yocto / YOCTO_PER_NEAR;
  const frac = yocto % YOCTO_PER_NEAR;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(24, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

/**
 * Exact testnet (or mainnet) NEAR the founder must hold to sign the default company create bundle:
 * create_company (5) + N × create_department (3 each) + set_caps (1 yocto).
 * Default departments match CreateCompanyBody (build, ops, growth) → 3.
 */
export function companyCreateFunding(departmentCount = 3) {
  const depts = BigInt(Math.max(0, departmentCount));
  const deposits = CREATE_COMPANY_DEPOSIT_YOCTO + depts * CREATE_DEPARTMENT_DEPOSIT_YOCTO;
  const recommended = deposits + CREATE_COMPANY_GAS_BUFFER_YOCTO;
  const n = network();
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
    /** Show this on Describe / fund CTA — deposit + small gas buffer. */
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
    hint:
      n.id === "testnet"
        ? `Add about ${yoctoToNear(recommended)} testnet NEAR to your wallet before creating a company (5 NEAR company + 3 NEAR × ${depts} teams + ~1 NEAR gas).`
        : `Fund about ${yoctoToNear(recommended)} NEAR before creating a company.`,
  };
}

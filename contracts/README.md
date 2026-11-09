# BuilderOS NEAR contracts

Rust/wasm contracts matching `packages/near/src/contracts.ts`.

| Crate | Deploy account (your testnet) |
|---|---|
| `builderos-factory` | `builderos-wang.testnet` |
| `builderos-registry` | `registry.builderos-wang.testnet` |
| `builderos-company` | created by factory as `<slug>.builderos-wang.testnet` |
| `builderos-department` | created by company as `<dept>.<slug>.builderos-wang.testnet` |

## Build

```bash
rustup target add wasm32-unknown-unknown
cd contracts
./build.sh
```

## Deploy (after accounts from step 2.4 exist)

```bash
near contract deploy builderos-wang.testnet use-file wasm/factory.wasm \
  with-init-call new json-args '{
    "owner_id":"builderos-wang.testnet",
    "registry_id":"registry.builderos-wang.testnet",
    "mpc_signer":"v1.signer-prod.testnet",
    "worker_id":"worker.builderos-wang.testnet",
    "verifier_id":"verifier.builderos-wang.testnet"
  }' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-keychain send

near contract deploy registry.builderos-wang.testnet use-file wasm/registry.wasm \
  with-init-call new json-args '{"owner_id":"builderos-wang.testnet"}' \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-keychain send
```

Save the factory deploy **block height** for `INDEXER_START_BLOCK`.


## Upgrading the factory (keeps existing state)

The company wasm is embedded in the factory, so any change to `company` or `department` means
rebuilding and redeploying the factory. Its state layout is unchanged, so deploy **without** an init call:

```bash
cd contracts && ./build.sh
near contract deploy builderos-wang.testnet use-file wasm/factory.wasm without-init-call \
  network-config testnet sign-with-keychain send
```

Companies created before an upgrade keep their old code. Testnet companies can be recreated; do not
upgrade a live company's wasm without a migration.

Refunds: if a create fails and the factory can't pay the deposit back at once, it records a pending
refund (`get_pending_refund`), and the founder calls `claim_refund`. Keep the factory funded with a
few NEAR above its storage cost anyway.

## No full-access keys on company or team accounts

The factory creates company accounts, and companies create team accounts, **without** adding anyone's
key. Nobody, including the founder, can sign as those accounts directly, so every payment and rule
change goes through contract code:

- **Agent keys:** `company.register_agent(department_name, public_key, role)` (founder or admin). The team
  adds a function-call key limited to `request_purchase,record_response,create_bounty` with a 0.25 NEAR
  gas allowance. `company.fire_agent` deletes it. The spend methods reject any caller other than these keys.
- **Upgrades:** the founder calls `company.propose_upgrade(target, code_hash)`, where target is `"company"` or a team name. Every member
  sees `upgrade_proposed`. After 24 h, `apply_upgrade` is called with the raw wasm as input, and only code
  matching the hash is deployed. `cancel_upgrade` withdraws a proposal.

```bash
# register an agent key from keystore/agents.public.json (founder's wallet signs)
near contract call-function as-transaction acme.builderos-wang.testnet register_agent \
  json-args '{"department_name":"build","public_key":"ed25519:...","role":"backend"}' \
  prepaid-gas '60.0 Tgas' attached-deposit '0 NEAR' sign-as <founder>.testnet network-config testnet sign-with-keychain send
```

Team accounts pay agent gas from their own NEAR balance (about 0.9 NEAR is left after deploy). Top them
up with a plain transfer if agents run a lot.

## Purchases: limits, approval cards, Chain Signatures

- `request_purchase` (agent key only) checks the payee against the team's allow-list (`allow_seller`, founder/admin via
  `company.dept_call`), the team's USDC/chain, budget, per-tx limit and task cap, then calls `company.check_spend`
  for frozen + the company-wide daily cap.
- `"ok"` → the team builds the EIP-3009 digest and calls `v1.signer.sign({ request: { path: "builderos-base", payload: [32 bytes], domain_id: 0 } })`
  (1 yocto, 50 Tgas). The signature comes back in `PurchaseResult` and `payment_signed`.
- `"pending"` → `purchase_yielded` (approval card). `company.approve/reject` (founder or approver, ≤20 per tx) marks the
  team request; the agent then calls `sign_approved`.
- Each team's Base address is derived from its account id: `v1.signer.derived_public_key({ path: "builderos-base",
  predecessor: <team account>, domain_id: 0 })`. The API passes it (plus chain id and USDC) to `create_department`;
  older teams can be set with `POST /v1/companies/:id/payments/configure`.
- Only `x402-evm` is contract-signed today; other rails return `rail_not_supported`.

Install `binaryen` (`brew install binaryen`) before `./build.sh`: `wasm-opt` shrinks the contracts, which means less NEAR locked per company.

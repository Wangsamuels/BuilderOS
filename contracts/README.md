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

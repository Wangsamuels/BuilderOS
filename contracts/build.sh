#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
export CARGO_HOME="${CARGO_HOME:-$ROOT/../.cargo-home}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
mkdir -p "$CARGO_HOME" "$CARGO_TARGET_DIR" wasm

build_one() {
  local pkg="$1" out="$2"
  echo "==> building $pkg"
  RUSTFLAGS='-C link-arg=-s' cargo build -p "$pkg" --target wasm32-unknown-unknown --release
  local src="$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/${pkg//-/_}.wasm"
  # crate builderos-department → builderos_department.wasm
  cp -f "$src" "wasm/$out"
  if command -v wasm-opt >/dev/null 2>&1; then
    wasm-opt -Oz -o "wasm/$out" "wasm/$out" || true
  fi
  echo "    wasm/$out $(wc -c < "wasm/$out") bytes"
}

build_one builderos-department department.wasm
build_one builderos-company company.wasm
build_one builderos-factory factory.wasm
build_one builderos-registry registry.wasm
echo "OK"
ls -la wasm/*.wasm

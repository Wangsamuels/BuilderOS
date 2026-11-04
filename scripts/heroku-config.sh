#!/usr/bin/env bash
# One-shot Heroku config for BuilderOS (your wang testnet accounts).
# Usage:
#   export HEROKU_APP=builderos-api          # required
#   export WEB_ORIGIN=https://YOUR.vercel.app
#   # optional overrides if keys aren't in .env yet:
#   export WORKER_PRIVATE_KEY=ed25519:... VERIFIER_PRIVATE_KEY=ed25519:...
#   ./scripts/heroku-config.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP="${HEROKU_APP:?Set HEROKU_APP=your-heroku-app-name}"
WEB_ORIGIN="${WEB_ORIGIN:?Set WEB_ORIGIN=https://your-app.vercel.app}"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

SESSION_SECRET="${SESSION_SECRET:-$(openssl rand -base64 32)}"
: "${WORKER_PRIVATE_KEY:?Export WORKER_PRIVATE_KEY or put it in .env (near account export-account worker.builderos-wang.testnet …)}"
: "${VERIFIER_PRIVATE_KEY:?Export VERIFIER_PRIVATE_KEY or put it in .env}"
: "${AGENT_KEYSTORE_PASSPHRASE:?Set AGENT_KEYSTORE_PASSPHRASE (from pnpm run setup / .env)}"
[[ -f keystore/agents.json ]] || { echo "missing keystore/agents.json — run: pnpm run setup"; exit 1; }

echo "Configuring Heroku app: $APP"

heroku config:set -a "$APP" \
  NODE_ENV=production \
  NETWORK=testnet \
  SESSION_SECRET="$SESSION_SECRET" \
  AUTH_RECIPIENT=builderos \
  WEB_ORIGIN="$WEB_ORIGIN" \
  FACTORY_CONTRACT=builderos-wang.testnet \
  REGISTRY_CONTRACT=registry.builderos-wang.testnet \
  WORKER_ACCOUNT_ID=worker.builderos-wang.testnet \
  WORKER_PRIVATE_KEY="$WORKER_PRIVATE_KEY" \
  VERIFIER_ACCOUNT_ID=verifier.builderos-wang.testnet \
  VERIFIER_PRIVATE_KEY="$VERIFIER_PRIVATE_KEY" \
  AGENT_KEYSTORE_JSON="$(cat keystore/agents.json)" \
  AGENT_KEYSTORE_PASSPHRASE="$AGENT_KEYSTORE_PASSPHRASE" \
  DB_POOL_MAX=5 \
  USE_SELLER_MESH=false \
  TEMPO_ENABLED=false \
  ${NEAR_AI_API_KEY:+NEAR_AI_API_KEY=$NEAR_AI_API_KEY} \
  ${VAPID_PUBLIC_KEY:+VAPID_PUBLIC_KEY=$VAPID_PUBLIC_KEY} \
  ${VAPID_PRIVATE_KEY:+VAPID_PRIVATE_KEY=$VAPID_PRIVATE_KEY} \
  ${VAPID_SUBJECT:+VAPID_SUBJECT=$VAPID_SUBJECT} \
  ${INDEXER_START_BLOCK:+INDEXER_START_BLOCK=$INDEXER_START_BLOCK}

echo "Done. Scale dynos:"
echo "  heroku ps:scale web=1:basic worker=1:basic -a $APP"
echo "Deploy:"
echo "  heroku git:remote -a $APP && git push heroku main"

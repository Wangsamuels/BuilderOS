# BuilderOS Backend — Setup Guide (private, keep outside the repo)

Step-by-step: run it locally, push to GitHub, deploy to Heroku, connect the Vercel frontend.
Code lives in `~/Downloads/builderos` · GitHub: `git@github.com:Wangsamuels/BuilderOS.git`

---

## 0. Install once

```bash
# Node 22+ and pnpm
brew install node@22
corepack enable && corepack prepare pnpm@10.28.0 --activate
# Heroku CLI
brew tap heroku/brew && brew install heroku
heroku login
# Docker Desktop (for local Postgres): https://www.docker.com/products/docker-desktop
```

## 1. Run locally

```bash
cd ~/Downloads/builderos
pnpm install
docker compose up -d          # Postgres 16 on :5432, MailHog on :8025
pnpm run setup                # NOT "pnpm setup" (that's a pnpm built-in)
pnpm db:migrate
pnpm dev                      # API :4000, workers, seller mesh :4100
```

`pnpm run setup` creates:
- `.env` with a random `SESSION_SECRET`, VAPID keys and a keystore passphrase
- `keystore/agents.json`: encrypted agent keys (one request-only key per role per department)
- `keystore/agents.public.json`: the public keys to add on chain

Check it works:
```bash
curl localhost:4000/health
pnpm demo                     # offline money path
pnpm test                     # 18 tests should pass
```

Fill in `.env` before testing against testnet: `FACTORY_CONTRACT`, `REGISTRY_CONTRACT`, `WORKER_ACCOUNT_ID` / `WORKER_PRIVATE_KEY`, `VERIFIER_ACCOUNT_ID` / `VERIFIER_PRIVATE_KEY`, `NEAR_AI_API_KEY`.

## 2. Push to GitHub

```bash
cd ~/Downloads/builderos
git init
git add .
git status --short | grep -iE '\.env$|\.env\.|keystore/.+\.json|\.pem|\.key' || echo "clean"   # must print "clean"
git commit -m "BuilderOS backend"
git branch -M main
git remote add origin git@github.com:Wangsamuels/BuilderOS.git
git push -u origin main
```

If SSH fails (`Permission denied (publickey)`), switch to HTTPS:
```bash
git remote set-url origin https://github.com/Wangsamuels/BuilderOS.git
git push -u origin main       # password = a GitHub personal access token
```

**The repo is public.** Secrets only go in Heroku and Vercel config, never in git.

## 3. Deploy API + workers to Heroku

```bash
cd ~/Downloads/builderos
heroku create builderos-api                 # or your app name
heroku addons:create heroku-postgresql:essential-0
heroku buildpacks:set heroku/nodejs
heroku stack:set heroku-24
```

Set config vars (replace the `<…>` values):
```bash
heroku config:set \
  NODE_ENV=production \
  NETWORK=testnet \
  SESSION_SECRET="$(openssl rand -base64 32)" \
  AUTH_RECIPIENT=builderos \
  WEB_ORIGIN=https://<your-app>.vercel.app \
  FACTORY_CONTRACT=<factory>.testnet \
  REGISTRY_CONTRACT=<registry>.testnet \
  WORKER_ACCOUNT_ID=<worker>.testnet WORKER_PRIVATE_KEY=ed25519:<…> \
  VERIFIER_ACCOUNT_ID=<verifier>.testnet VERIFIER_PRIVATE_KEY=ed25519:<…> \
  NEAR_AI_API_KEY=<…> \
  DB_POOL_MAX=5
```

Agent keystore and notification keys (from your local `.env` / `keystore/`):
```bash
heroku config:set AGENT_KEYSTORE_JSON="$(cat keystore/agents.json)"
heroku config:set AGENT_KEYSTORE_PASSPHRASE=<value from .env>
heroku config:set VAPID_PUBLIC_KEY=<from .env> VAPID_PRIVATE_KEY=<from .env> VAPID_SUBJECT=mailto:<you@email>
# Optional email
heroku config:set NEAR_EMAIL_URL=<…> NEAR_EMAIL_PAYMENT_KEY=<…>
```

Optional, for Vercel preview deployments:
```bash
heroku config:set WEB_ORIGIN_PATTERN='^https://<project>-[a-z0-9-]+-<team>\.vercel\.app$'
```

Deploy (pick one):
- **Git:** `heroku git:remote -a builderos-api` then `git push heroku main`
- **GitHub integration:** Heroku dashboard → app → Deploy → GitHub → connect `Wangsamuels/BuilderOS` → enable automatic deploys from `main`

Start both dynos:
```bash
heroku ps:scale web=1:basic worker=1:basic
```

What happens on deploy:
1. Build: `heroku-postbuild` → `pnpm build` bundles `apps/api`, `apps/workers` and the migration script.
2. Release: `node packages/db/dist/migrate.js` applies database migrations.
3. Run: `web` starts the API, `worker` starts the indexer and other workers.

Check it:
```bash
curl https://builderos-api.herokuapp.com/health
curl https://builderos-api.herokuapp.com/v1/status    # indexer lag, queue depth, etc.
heroku logs --tail
```

Cost: Basic web + Basic worker + Postgres Essential-0 ≈ $19/month.

## 4. Connect the Vercel frontend

On **Vercel** → Project → Settings → Environment Variables:
```
NEXT_PUBLIC_API_URL=https://builderos-api.herokuapp.com
```
Redeploy the frontend after adding it.

On **Heroku**, `WEB_ORIGIN` must equal the exact Vercel URL (no trailing slash). Several URLs are comma-separated.

### Sign-in cookies: pick one

**A. Default domains (`*.vercel.app` + `*.herokuapp.com`).** No extra config. The cookie is third-party, and Safari blocks it, so the frontend must use the bearer token:
- save `token` from `POST /v1/auth/verify`
- send `Authorization: Bearer <token>` on every request
- open the stream with `/v1/stream?token=<token>`

**B. Custom domain (recommended).** `app.yourdomain.com` on Vercel, `api.yourdomain.com` on Heroku:
```bash
heroku domains:add api.yourdomain.com      # then add the DNS CNAME it prints
heroku certs:auto:enable
heroku config:set COOKIE_DOMAIN=.yourdomain.com WEB_ORIGIN=https://app.yourdomain.com
```
On Vercel: `NEXT_PUBLIC_API_URL=https://api.yourdomain.com`. Cookies then just work (`credentials: "include"`).

### Frontend client (drop into `lib/api.ts`)

```ts
const API = process.env.NEXT_PUBLIC_API_URL!;
let token: string | null = typeof window !== "undefined" ? sessionStorage.getItem("bos_token") : null;

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.method && init.method !== "GET" ? { "idempotency-key": crypto.randomUUID() } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? res.statusText);
  return res.json();
}

export async function signIn(wallet: any, accountId: string) {
  const ch = await api<{ message: string; recipient: string; nonce: string }>(`/v1/auth/challenge?accountId=${accountId}`);
  const signed = await wallet.signMessage({ message: ch.message, recipient: ch.recipient, nonce: Buffer.from(ch.nonce, "base64") });
  const out = await api<{ token: string }>("/v1/auth/verify", {
    method: "POST",
    body: JSON.stringify({ accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: ch.nonce, message: ch.message }),
  });
  token = out.token;
  sessionStorage.setItem("bos_token", out.token);
}

// Any write returns unsigned txs → the user signs them
export async function approve(wallet: any, cardId: string) {
  const { transaction } = await api<{ transaction: any }>(`/v1/approvals/${cardId}`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
  await wallet.signAndSendTransactions({ transactions: [transaction] });
}

export function stream(onEvent: (e: any) => void) {
  const es = new EventSource(`${API}/v1/stream${token ? `?token=${token}` : ""}`, { withCredentials: true });
  es.onmessage = (m) => onEvent(JSON.parse(m.data));
  ["payment_signed", "purchase_yielded", "purchase_approved", "receipt", "frozen", "topup_recorded"].forEach((t) =>
    es.addEventListener(t, (m: MessageEvent) => onEvent(JSON.parse(m.data))),
  );
  return () => es.close();
}
```

## 5. Before the first testnet run

- [ ] Check contract method names and arguments in `packages/near/src/contracts.ts` against the deployed contracts.
- [ ] Check the event fields in `packages/shared/src/events.ts` against what the contracts emit.
- [ ] Add each public key from `keystore/agents.public.json` on chain as a function-call key limited to `request_purchase` / `record_response`.
- [ ] Give the worker key only `record_*`, `request_rail_topup`, `record_withdrawal`, and the verifier key only `submit_verdict`.
- [ ] Optionally set `INDEXER_START_BLOCK` to the factory's deploy block so the indexer replays history.
- [ ] Leave `TEMPO_ENABLED=false` until the Tempo spike is decided.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Browser: CORS error | `WEB_ORIGIN` on Heroku must exactly match the Vercel URL (https, no trailing slash) |
| Signed in but next request is 401 | Third-party cookie blocked → use the bearer token (option A) or a custom domain (option B) |
| `SESSION_SECRET must be set…` on boot | `heroku config:set SESSION_SECRET="$(openssl rand -base64 32)"` |
| `too many connections` | Lower `DB_POOL_MAX` (Essential-0 has 20 connections) |
| Live stream disconnects | Normal on Heroku (55 s idle / dyno restarts); EventSource reconnects and resumes |
| `/v1/status` shows large indexer lag | Check worker logs; set a recent `INDEXER_START_BLOCK` for a fresh start |
| Release phase fails | `heroku releases:output` shows the migration error |

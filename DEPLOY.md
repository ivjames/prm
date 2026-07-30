# Deploying PRM on the lab980 droplet

PRM runs on the shared lab980 droplet (165.22.128.19) following the standard
one-dir-per-site / pm2 / nginx / certbot shape — see `lab980.com/CLAUDE.md`.

**Architecture is hybrid (decided at setup):** the backend is **Supabase**
(managed Postgres + Auth + RLS), and the droplet serves the **web PWA** at
`prm.lab980.com` plus runs the **ingestion + cadence workers** under pm2. The
droplet holds no database — only the Node web/worker processes, which talk to
Supabase.

```
 browser ──▶ nginx :443 (prm.lab980.com) ──▶ pm2 prm-web  :80xx ──▶ Supabase
                                             pm2 prm-worker ───────▶ Supabase
                                             (Gmail/Calendar/Claude/Deepgram)
```

## One-time: Supabase project

1. Create a Supabase project (free tier is fine to start; Pro when it has real
   use). Note the project URL and the `anon` + `service_role` keys.
2. Apply the schema. Migrations live in `supabase/migrations/`:
   - With the Supabase CLI: `supabase link --project-ref <ref>` then
     `supabase db push`.
   - Or paste `0001` → `0004` in order into the SQL editor.
   Migration `0003` needs the **Vault** extension (`supabase_vault`) — enabled
   by default on Supabase; the migration creates it if missing.
3. Confirm RLS is on (it is, via `0002`) — every table should show "RLS
   enabled" in the dashboard.

## One-time: provision the subdomain

Run **on the droplet**, as root (this is what stands up DNS, the nginx vhost,
and TLS — it does not build or start the app):

```sh
provision-site prm ivjames/prm
```

That creates the DNS A record `prm.lab980.com → 165.22.128.19`, clones the repo
into `/var/www/prm`, picks the next free local port (8060+), writes
`/var/www/prm/.env` with `PORT=…`, wires the nginx vhost, and issues the cert.

## One-time: fill in .env

`provision-site` seeds only `PORT`. Add the rest (see `.env.example`):

```sh
cd /var/www/prm
# edit .env — keep the PORT provision-site chose, then add:
#   PUBLIC_ORIGIN=https://prm.lab980.com
#   SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY
#   ANTHROPIC_API_KEY, DEEPGRAM_API_KEY
#   GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET
```

The `service_role` key stays server-side (it's only read by the worker + API);
the web client is handed the `anon` key via `/api/config`, and RLS protects the
data.

## One-time: build, start, persist

```sh
cd /var/www/prm
npm ci && npm run build
pm2 start ecosystem.config.cjs   # starts prm-web (binds PORT) + prm-worker
pm2 save                         # persist across the droplet's boot hook
```

Then symlink the operate CLI onto PATH (once):

```sh
ln -sf /var/www/prm/bin/prm /usr/local/bin/prm
```

Smoke check: `curl -s https://prm.lab980.com/api/readyz` should return
`{"ok":true,"backend":"supabase"}`.

## Everyday operation

All via the `prm` CLI (see `bin/prm`):

```sh
prm deploy     # git pull -> npm ci -> build -> migrate -> pm2 restart -> pm2 save
prm restart
prm logs       # tail both processes
prm status
prm migrate    # supabase db push
prm backup     # snapshot .env + public schema into data/backups/
```

## Connecting a data source (Gmail / Calendar)

Login OAuth (Sign in with Google) is Supabase Auth. **Data-access** OAuth — the
background read token the ingestion worker uses — is separate and wired through
`/api/connect/google` → Google consent → `/api/connect/google/callback`, which
exchanges the code, stores the refresh token encrypted via `store_account_token`
(the vault), and creates `account` rows for `gmail` + `gcal`.

One Google Cloud OAuth client can serve **both** flows — reuse the same client
id/secret; just register both redirect URIs on it.

One-time Google Cloud setup:

1. In a Google Cloud project, enable the **Gmail API** and **Calendar API**.
2. Configure the OAuth **consent screen** (External, in Testing). Add the scopes
   `gmail.readonly` and `calendar.readonly` (both *restricted* — a CASA
   assessment is required before any non-personal/public use; fine for personal
   use). Under **Test users**, add the owner's Google account — restricted-scope
   consent is blocked for anyone not on that list while the app is in Testing.
3. Create an **OAuth 2.0 Client ID** (type: Web application). Add **both**
   authorized redirect URIs:
   - `https://prm.lab980.com/api/connect/google/callback` — the **data-access**
     flow (the app exchanges the code directly).
   - `https://<project-ref>.supabase.co/auth/v1/callback` — the **login** flow
     ("Sign in with Google"), which routes through Supabase Auth. Supabase shows
     this exact URL on its Google provider page. Skip this URI if you only want
     email/password login.
4. Put the client id/secret in the droplet `.env` as `GOOGLE_OAUTH_CLIENT_ID` /
   `GOOGLE_OAUTH_CLIENT_SECRET` (these drive the **data-access** flow), then
   `prm restart`.

One-time Supabase setup (only for "Sign in with Google"):

5. Dashboard → **Authentication → Providers → Google**: enable it and paste the
   **same** client id/secret. (Supabase persists login sessions itself; the
   droplet `.env` copy is what the data-access ingestion flow uses — they're
   independent, so keeping them in sync is fine.)
6. Dashboard → **Authentication → URL Configuration → Redirect URLs**: allow-list
   `https://prm.lab980.com/api/auth/callback` (the `redirectTo` the login flow
   sends), and set the **Site URL** to `https://prm.lab980.com`.

Then: sign in (Google or email/password), click **Connect Gmail & Calendar** (or
hit `/api/connect/google`), grant consent. That vaults the refresh token and
creates the `gmail` + `gcal` account rows.

Test the pipeline immediately instead of waiting for `INGEST_CRON`:

```sh
prm ingest      # run one ingestion poll now; non-zero exit if it fails
prm logs        # watch for `ingested touchpoints`
```

From then on `prm-worker` polls on `INGEST_CRON` and the pipeline runs end to
end — entity resolution → interactions → cadence reset. `readyz` stays green
regardless of connection state.

> Note: the data-access consent uses `access_type=offline` + `prompt=consent` to
> guarantee a refresh token. If a stale prior grant means Google returns none,
> `/callback` reports it — revoke the app at myaccount.google.com → Security →
> third-party access, and reconnect.

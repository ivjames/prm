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

Login OAuth is handled by Supabase Auth. **Data-access** OAuth (the background
read token) is separate and not yet wired — the ingestion worker's provider
fetch is a stub (`src/workers/ingest.ts`) until:

1. Google OAuth app + restricted Gmail/Calendar scopes are configured
   (`GOOGLE_OAUTH_CLIENT_ID/SECRET`).
2. The consent → token exchange → `store_account_token()` vault write path is
   built, creating an `account` row and stashing its refresh token.

Once an active `account` row with a stored token exists, the ingestion pipeline
(entity resolution → interactions → cadence reset) runs end to end on the
`INGEST_CRON` schedule. Restricted Google scopes need a CASA assessment before
any non-personal use — plan lead time (see `docs/architecture.md`).

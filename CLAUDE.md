# PRM — working notes

A personal-relationship manager: voice-note capture, contact
cadences, and a priority digest.

Served at **https://prm.lab980.com** from the lab980 droplet.

How work lands here — branch, PR, and the fact that merging is not deploying —
is in `.claude/rules/lab980-conventions.md`, which Claude Code loads
automatically every session. That file is owned by the lab980 scaffold and is
overwritten by it; **this** file is the site's own, and everything below is
about this site rather than about the platform. For the box itself, read the
`ivjames/lab980.com` repo's `CLAUDE.md`.

## Shape

A **hybrid**: the backend is external **Supabase** (managed Postgres + Auth +
RLS), while this droplet serves the web PWA and runs the ingestion and cadence
workers under pm2. So there is no database on the box — the `data/` and SQLite
convention that applies to other lab980 app sites does not apply here.

nginx fronts a pm2-managed Node process on a local port. **The port is not
recorded in this repo on purpose**: `provision-site` picks the next free one
from 8060 at bring-up and writes it into `/var/www/prm/.env`, so the box is the
only place that knows it. `.env.example` shows `PORT=8060` as an illustration,
not a fact — keep whatever provisioning chose.

- Repo: `ivjames/prm` · droplet dir: `/var/www/prm`
- pm2 processes: `prm-web` (binds the site port) and `prm-worker` (binds
  none), both **fork mode** (`exec_mode: "fork"`, no
  `instances` key: setting it silently flips pm2 into cluster mode, whose
  startup crashes land in `~/.pm2/pm2.log` instead of the app's own log — a
  crash-looping app with empty logs is that trap)
- Config and data live in the app dir (`.env`, `data/`), not `/etc` or
  `/var/lib`. `.env` is **not** in git; changing it is a droplet-side edit
  followed by a restart.
- vhost: `/etc/nginx/sites-available/prm.lab980.com`, written by `provision-site`

## Deploying

On the droplet, as root:

```bash
prm deploy      # git pull --ff-only, npm ci, build, soft migrate, pm2 restart
prm status      # pm2 state of prm-web and prm-worker
prm logs        # tail their pm2 logs
```

`prm` also carries `migrate`, `ingest`, `backfill`, `cadence`, `cleanup`,
`backup` and one-shot worker runs — see `bin/prm --help`.

Two things `deploy` and `status` do **not** do, because it's easy to assume
otherwise from the other lab980 sites: `deploy` ends at `pm2 save` without
probing anything, and `status` reports pm2 only — no HEAD, no local or public
probe, no cert expiry. So neither confirms that the right revision is live or
that the site answers. Check both separately before calling a deploy good, and
note they need different tools:

```bash
git -C /var/www/prm rev-parse --short HEAD   # which commit is actually live
health-check --site prm                      # DNS, upstream port, public URL, cert
```

Nothing in this repo's CLI or in `health-check` reports the deployed revision —
`health-check` covers reachability and the cert, not which commit is serving —
so a stale-but-healthy checkout passes every other check there is.

And `deploy` uses `git pull --ff-only`, not a hard reset. A tracked hand-edit on
the droplet is therefore **not** wiped: a non-conflicting one survives into the
running deploy, a conflicting one aborts the pull and the deploy fails. Most
lab980 sites hard-reset; this one doesn't. Don't edit on the box.

Full runbook, including first-time bring-up and `.env` keys: `DEPLOY.md`.

## Things worth knowing

- `.env` and `data/` are gitignored, so `deploy` never touches them — and here
  that is the *only* protection they have, since the pull is `--ff-only` rather
  than a hard reset (see Deploying). It also means a missing key is invisible
  in the repo: keep `.env.example` current and list every key in `DEPLOY.md`.
- Verify a **clean** clone builds, not just the working tree:
  `git archive HEAD | tar -x -C /tmp/x && cd /tmp/x && npm ci && npm run build`.
  A kitchen-sink `.gitignore` quietly eating a source dir is the classic way
  this bites; `git ls-files <dir>` confirms what is actually tracked.
- pm2 process names are `prm-web` and `prm-worker`; `prm logs` tails them.
  A crash-looping worker with *empty* logs is the cluster-mode trap — check
  `~/.pm2/pm2.log`, not the app's own log.

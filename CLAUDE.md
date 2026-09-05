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

On the droplet, as root (`sudo -i` / `su -` — pm2's daemon and dump are
root's, keyed off `HOME`):

```bash
prm deploy      # fetch + reset --hard origin/main, npm ci, build, migrate --soft,
                # pm2 start (whichever of the two is unregistered) / restart, probe, gated save
prm restart     # pm2 restart prm-web prm-worker + probe, no code change
prm status      # HEAD, pm2 state of prm-web and prm-worker, local + public probe, cert days
prm logs        # tail prm-web's pm2 logs; `prm logs worker` for prm-worker
```

`prm` also carries `migrate [--soft]`, `ingest`, `backfill [days]`, `cadence`,
`cleanup` and `backup` — see `prm --help`. `bin/prm` is the merged lab980
app-CLI template extended from one pm2 process to the two this checkout
owns; what that means in practice:

- **Every pm2 call runs from a scrubbed environment** — `env -i` plus `PATH`,
  `HOME`, `LANG`, and `PM2_HOME`/`TERM` if set; never `--update-env`. pm2
  copies the environment of the `pm2 start` call into the process and into
  `~/.pm2/dump.pm2`, so nothing exported in the shell that ran `deploy`
  reaches either process or the dump. Unlike the other lab980 CLIs this one
  does not hand in `PORT` either: both processes get everything — `PORT`,
  Supabase, model, Deepgram, Google OAuth keys — from `.env` via dotenv, and
  pm2 gives them only the `NODE_ENV` in `ecosystem.config.cjs`, exactly the
  live registrations. There is no box-level key store; `.env` is the only
  copy.
- **The port still lives only on the box.** dotenv never overrides a variable
  already in the environment and pm2 pins the start-time environment into
  the dump, so a `PORT` handed in at first start would outlive a later `.env`
  change — which is why it isn't. The CLI reads `PORT` from
  `/var/www/prm/.env` (`PRM_PORT` overrides) only to know where to probe, and
  has no built-in default; without one, `deploy` and `restart` refuse rather
  than probe a guess.
- **First start comes from `ecosystem.config.cjs`, one process at a time**
  (`pm2 start ecosystem.config.cjs --only prm-web`, then `--only
  prm-worker`) for whichever of the two is not registered; the rest get one
  `pm2 restart prm-web prm-worker`. So a box where one of the two was
  deleted by hand comes back whole on the next deploy.
- **`deploy` probes and can fail.** After the restart it retries
  `127.0.0.1:<PORT>` (any HTTP status counts; `PRM_PROBE_TRIES`, default 10,
  a second apart) and exits non-zero, saving nothing, if `prm-web` never
  answers. Only `prm-web` binds a port, so only it is probed; the worker's
  health is its pm2 state in `prm status`. `pm2 save` runs only after the
  probe passes and only when **every** registered pm2 process on the box is
  `online` — otherwise it warns and leaves the previous dump alone.
- **Sync is `git fetch` + `git reset --hard origin/main`**, like the other
  lab980 sites now. A tracked hand-edit on the droplet is wiped by the next
  deploy; `.env` and `data/` are gitignored and survive. Don't edit on the
  box.

Where a failed `deploy` leaves you still depends on how far it got. The
order is: reset → `npm ci` → build → `migrate --soft` → pm2 start/restart →
probe → save, under `set -euo pipefail`.

- **Failed before the restart** (install, build or migrate): the running
  processes still hold the previously built code — `npm run build` is `tsc`
  into `dist/`, and node loaded that at start — but the site is **not** wholly
  on the old revision. `web/` is tracked source served straight off disk
  (`express.static` in `src/server.ts`), so any frontend files the reset
  touched are live the moment it lands, with no restart. The result is the
  new PWA shell talking to the old API and worker, which is worse than either
  being stale, and the case where `rev-parse` misleads most.
- **Failed at the restart**: `prm-web` and `prm-worker` are restarted in one
  command, so one can be on the new build and the other not. Check both in
  `prm status` rather than assuming they match.
- **Failed at the probe**: the restart happened, the new build is what pm2 is
  (re)starting, and nothing was saved — read `prm logs`. A reboot before the
  next successful save resurrects the previous process list.

This app exposes no build identity of its own, so "which revision is
running" still cannot be read from outside. The closest you get is `prm
status`: HEAD is what you intended **and** both processes' `uptime-since`
show they restarted when you expected **and** the local probe answers.
`health-check --site prm` covers DNS, upstream port, public URL and cert.
Treat anything less as unverified rather than as a pass.

Full runbook, including first-time bring-up and `.env` keys: `DEPLOY.md`.

## Things worth knowing

- `.env` and `data/` are gitignored, so `deploy`'s hard reset never touches
  them. It also means a missing key is invisible in the repo: keep
  `.env.example` current and list every key in `DEPLOY.md`.
- Verify a **clean** clone builds, not just the working tree:

  ```bash
  d=$(mktemp -d) \
    && git archive HEAD | tar -x -C "$d" \
    && ( cd "$d" && npm ci && npm run build ) \
    && rm -rf "$d"
  ```

  `mktemp -d` is the point, not tidiness. The directory has to exist — `tar -x
  -C` into a missing one fails outright — and it has to be *empty*, or the
  extract merges over an earlier run's files and the check quietly stops
  testing a clean tree. A fixed `/tmp/x` gets both wrong, and on a shared
  `/tmp` it lets two runs race, each able to delete the other's tree
  mid-build. The subshell keeps you in the checkout, so `$d` and the `git
  ls-files` below still resolve; the trailing `rm -rf` fires only on success,
  leaving a failed build in `$d` to look at. A kitchen-sink `.gitignore`
  eating a source dir is the classic thing this catches; `git ls-files <dir>`
  confirms what is actually tracked.
- pm2 process names are `prm-web` and `prm-worker`; `prm logs` tails the
  web, `prm logs worker` the worker (`pm2 logs` takes one name — the old
  `pm2 logs prm-web prm-worker` only ever showed the web).
  A crash-looping worker with *empty* logs is the cluster-mode trap — check
  `~/.pm2/pm2.log`, not the app's own log.

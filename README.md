# prm

A personal relationship management tool — auto-updating contact timelines from email/calendar, cadence-based reminders, and low-friction voice-note capture. Currently scoped for personal use by a single owner, architected so it doesn't need rework to support a few additional private users later.

**Status:** early build. Backend spine scaffolded — schema + RLS migrations,
a web/API server and background workers deployable on the lab980 droplet.
Provider OAuth ingestion and the Capacitor client are the next phases.

## Start here

- [`HANDOFF.md`](./HANDOFF.md) — onboarding for anyone (human or agent) picking this up: locked-in decisions, open questions, recommended first build steps.
- [`DEPLOY.md`](./DEPLOY.md) — how PRM is set up and run on the lab980 droplet (hybrid: Supabase backend + web/worker on the droplet).
- [`docs/architecture.md`](./docs/architecture.md) — system design, stack, data model, AI cost model.
- [`docs/capture-flow.md`](./docs/capture-flow.md) — the guided voice-capture UX, in detail.
- [`docs/competitive-brief.md`](./docs/competitive-brief.md) — market landscape and why certain features are deliberately deferred.

## Stack

Supabase (Postgres + Auth + RLS) · Capacitor (web/iOS/Android, one codebase) · Claude API (Haiku for extraction/summarization, Sonnet for the priority digest) · Deepgram-class STT for voice capture. Served from the shared lab980 droplet as `prm.lab980.com` (pm2 + nginx + certbot).

## Layout

```
src/
  server.ts            web PWA + API (binds PORT; the process nginx proxies to)
  api/                 health, auth (Supabase JWT), people/timeline routes
  workers/             prm-worker: ingestion + cadence schedulers
    entity-resolution  handle -> canonical Person (the differentiating core)
supabase/migrations/   0001 schema · 0002 RLS · 0003 token vault · 0004 cadence
web/                   static PWA shell (placeholder for the Capacitor build)
ecosystem.config.cjs   pm2: prm-web + prm-worker
bin/prm                operate CLI (deploy/restart/logs/migrate/backup)
```

## Develop locally

```sh
npm install
cp .env.example .env      # fill in SUPABASE_URL + keys
npm run build             # tsc -> dist/
npm run dev               # web server with reload (tsx)
npm run dev:worker        # workers with reload
```

Deployment is documented in [`DEPLOY.md`](./DEPLOY.md).

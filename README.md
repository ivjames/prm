# prm

A personal relationship management tool — auto-updating contact timelines from email/calendar, cadence-based reminders, and low-friction voice-note capture. Currently scoped for personal use by a single owner, architected so it doesn't need rework to support a few additional private users later.

**Status:** design/architecture stage. No application code yet.

## Start here

- [`HANDOFF.md`](./HANDOFF.md) — onboarding for anyone (human or agent) picking this up: locked-in decisions, open questions, recommended first build steps.
- [`docs/architecture.md`](./docs/architecture.md) — system design, stack, data model, AI cost model.
- [`docs/capture-flow.md`](./docs/capture-flow.md) — the guided voice-capture UX, in detail.
- [`docs/competitive-brief.md`](./docs/competitive-brief.md) — market landscape and why certain features are deliberately deferred.

## Stack (planned)

Supabase (Postgres + Auth + RLS) · Capacitor (web/iOS/Android, one codebase) · Claude API (Haiku for extraction/summarization, Sonnet for the priority digest) · Deepgram-class STT for voice capture.

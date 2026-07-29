# Handoff

This repo is at the design/architecture stage — **no application code has been written yet.** Everything below is the accumulated output of a scoping conversation; treat the `docs/` files as the spec to build from, not aspirational notes.

## What this is

A personal relationship management (PRM) tool — think "a CRM for your own relationships," but automated. Auto-ingests email/calendar to keep an up-to-date interaction timeline per contact, reminds the owner when someone's overdue for contact, and supports low-friction voice-note capture that gets extracted into structured notes and follow-ups.

**Current scope: personal use for a single owner, built so it doesn't need rework to support a handful of additional private users later.** Not currently being built as a public commercial product — see `docs/competitive-brief.md` for why that path is deprioritized for now (crowded market, price-anchored low, automation alone isn't a differentiator).

## Read in this order

1. `docs/architecture.md` — system design, stack choices (Supabase, Capacitor), data model, AI cost model, build order.
2. `docs/capture-flow.md` — the voice-capture UX in detail, including three resolved edge cases and the one open item flagged for override (see below).
3. `docs/competitive-brief.md` — market context; explains *why* certain things (iMessage, LinkedIn/social, a "voice assistant" as primary UI) are deliberately deferred rather than missing by oversight.

## Locked-in decisions (don't relitigate without new information)

- **Backend:** Supabase (managed Postgres + Auth + RLS). Understood tradeoff: this is a server-heavy app (ingestion workers, token vault, cadence jobs), so Supabase mostly buys managed Postgres + auth + hosting here, not its client-side RLS/PostgREST value prop.
- **Client:** Capacitor — one codebase for web/iOS/Android. No native code needed for the core app; native plugins only for push notifications and mic capture.
- **Data model:** `Person` / `Identifier` / `Interaction` / `InteractionPerson` (join table) / `Note` / `Cadence` / `Account`. The `InteractionPerson` join table is required — a single voice capture can name multiple people — build it from day one.
- **RLS on from the start**, even single-user. Cheap now, expensive to retrofit if this ever supports more than one owner.
- **AI provider split:** Haiku-tier for extraction/summarization, Sonnet-tier reserved for the periodic priority digest. Summarize threads once and cache — don't re-summarize on every view (this is the main AI-cost lever).
- **STT:** batch transcription (not streaming) is the default for voice-note capture — cheaper, and streaming's latency benefit isn't needed for this use case.
- **Deferred, not forgotten:** iMessage (Mac companion script reading `chat.db`, no Xcode needed, if ever built), Android SMS/call-log (real native work + Play Store policy gate), social sources, a live conversational voice-agent interface (cost structure doesn't fit a low flat price, and browsing contacts is inherently visual — voice belongs on the *input* side only, not review).

## Open items — needs owner input before building

- **One UX call flagged, not confirmed:** `capture-flow.md`'s "no identifiable person" path includes a one-tap "skip — not about anyone" escape hatch inside the immediate person-attribution prompt. This was proposed, not explicitly requested — confirm before relying on it, or rip it out if every capture should require a person.
- **Google OAuth scopes** (Gmail/Calendar) will require a CASA security assessment before any public availability — not urgent for personal use, but plan lead time if this ever generalizes.
- **Apple Calendar** has no real solution yet — no cloud API exists; true iCloud-native calendars would need CalDAV or on-device EventKit. Most "Apple Calendar" data in practice is a synced Google/Exchange account already covered elsewhere. Don't build dedicated Apple Calendar support without revisiting this.

## Recommended first build steps

Per `docs/architecture.md`'s build order: stand up the Supabase project and schema (with RLS) first, then Gmail + Google Calendar ingestion and entity resolution — that alone produces a working, self-updating PRM before any voice or UI work begins. Voice capture (`docs/capture-flow.md`) is a later phase, once the ingestion loop is proven daily-usable.

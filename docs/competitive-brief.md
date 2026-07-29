# Competitive Brief

Personal relationship management / personal CRM market, mid-2026. Pricing for Dex, Mesh (formerly Clay), and Folk verified from vendor/aggregator pages; Monica, Covve, UpHabit from a third-party roundup — treat those as approximate. Market-size figures below are low-confidence (see caveat).

## The players

| Product | Price (2026) | Positioning | Automation / AI | Platforms |
|---|---|---|---|---|
| **Mesh** (was Clay) | Free (≤1k contacts); Pro $10/mo; Team $40/seat | "Network intelligence" — your database updates itself | Strongest: auto-enrichment, going-cold scoring, calendar briefs; Gmail/Outlook/GCal/LinkedIn/X/FB/iMessage | Web, macOS (iMessage) |
| **Dex** | ~$12/mo flat, free tier + trial | For people who "live on LinkedIn"; job-change alerts | LinkedIn capture + job alerts, keep-in-touch reminders, AI-drafted thank-you notes (manual-prompt, needs editing) | Web, iOS, Android, extension |
| **Covve** | $12/seat/mo, $120/yr | Mobile-first; business-card scanning | "News Engine" scans 150+ sources; reminders | iOS, Android |
| **Monica** | Free (self-host), ~$9/mo hosted | Open-source, privacy-first | Minimal — mostly manual entry | Web, self-hosted |
| **UpHabit** | Freemium (~$10/mo) | Mobile personal CRM, reminders | Contact sync + follow-up nudges | iOS, Android |
| **Folk** | $30 / $60 / $100+ per seat, no free plan | Really a lightweight *team* CRM, not personal | LinkedIn capture, enrichment credits, email campaigns | Web, extension (no native mobile) |
| **Inner Circle** | Free tier: 10 contacts / 50 queries/mo | Voice/chat capture explicitly against forms — "no required fields" | Freeform natural-language capture and query; no completeness checking, no email/report generation found | Not fully verified |
| **DIY** (Notion/Airtable) | Free – $10/user | Customizable database | None — manual upkeep, "a pretty spreadsheet" | Web, apps |

Also circling: Nat, Dextr, Orvo, and Gmail-native tools like Streak ($49+/seat). The long tail is growing — a signal in itself.

## The pricing reality

**The established price band for personal CRM is $9–12/month.** Dex $12, Mesh Pro $10, Covve $12, Monica $9, UpHabit ~$10. Folk is $30+ but it's a team product, not a true comparable.

A price above $12–15 sits above the entire band. Not fatal, but it means out-delivering a field of ~$10 tools, several with credible free tiers (Mesh free to 1,000 contacts, Monica free self-hosted, Notion free). Free tiers anchor willingness-to-pay low across the category.

## What this means for the build

**"Heavily automated" is table stakes, not a wedge.** Mesh's entire pitch is already "your database updates itself." Automated ingestion is the price of entry now.

**iMessage: incumbents already have it, and it's a sore point.** Both Mesh and Dex read iMessage via a Mac with full-disk access — and it's a recurring privacy complaint in reviews. Validates deferring it, and suggests a privacy-respecting approach as a possible angle rather than a raw feature copy, if ever revisited.

**Voice-first capture is contested, not vacant.** Inner Circle already does freeform voice/chat capture, explicitly marketed *against* structure/required fields ("you tell it what happened in plain language, and it does the filing"). This is a real correction to an earlier "genuinely unclaimed" claim — it's a fast-moving space and that assessment changed within weeks of research.

**The open wedge: guided-completeness capture paired with reliable generated output.** Dex's AI thank-you notes require a user-written prompt and post-editing — not a fully automatic loop. Inner Circle captures fast but (per what's been verified) does no completeness checking and no email/report generation. The specific combination — light guidance at capture time → guaranteed-complete record → an automatically generated, ready-to-use output (a follow-up email, a pre-meeting brief) — is not clearly claimed by either. See `capture-flow.md` for the detailed design of this approach.

**Everyone is horizontal — verticalizing is open.** Dex, Mesh, Folk all target the same undifferentiated "founders/networkers." A profession-specific PRM (right fields, right cadences) is a wedge none of them occupy — deferred for now since the current build is personal-first, but worth revisiting if this generalizes beyond one user.

## Market size — low confidence, do not use as a real TAM

One analyst report (Future Market Insights) puts "personal CRM" at ~$16.5B in 2026 growing to ~$51.6B by 2036 (12.1% CAGR). Treat this as directional at best — third-party sizing reports routinely conflate personal CRM with the much larger general-CRM market, and a $16B "personal CRM" figure looks inflated against a landscape of mostly $10/mo indie tools. The honest read: a real but modest, fragmented consumer/prosumer market, not a proven large one.

## Risks, if this ever generalizes beyond personal use

- **Commoditization** — the same AI that makes this easy to build makes it easy for everyone; the long tail is already growing.
- **Feature-vs-product** — LinkedIn, Google Contacts, or Notion could absorb "stay in touch" as a feature.
- **Platform dependency** — LinkedIn enrichment already constrained for Mesh; Google requires a CASA security review for Gmail scopes; Apple has no calendar API at all (see `architecture.md`).
- **Churn is the category disease** — relationship trackers get abandoned; auto-ingestion and low-friction capture mitigate this but don't cure "why am I paying for this" drift over time. No reliable PRM-specific churn data was found — this is category commentary and inference, not a cited statistic.

## Bottom line (as of the market research pass)

Crowded, commoditizing, price-anchored at ~$10, with automation already claimed by the leader. That kills the *generic* version of the idea, not the idea itself. The viable shape, if this generalizes: voice-first capture with a genuine completeness/reliability payoff (the wedge this repo is currently built around), ideally paired with a chosen vertical later. For now, the project is scoped to personal use — this brief is context for if/when that changes, not a current requirement to chase a market position.

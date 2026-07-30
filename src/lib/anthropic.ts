import { config } from "../config";

/**
 * Minimal Anthropic Messages API client for relationship summarization. Uses
 * Haiku (the cheap extraction/summarization tier per architecture.md) over
 * global fetch — no SDK dependency. We only ever send interaction *metadata*
 * (subjects/titles, dates, channel, direction), never message bodies, matching
 * the ingestion privacy decision.
 */

const API_URL = "https://api.anthropic.com/v1/messages";

export function aiConfigured(): boolean {
  return Boolean(config.anthropicApiKey);
}

export interface InteractionMeta {
  source: string;
  direction: string;
  occurred_at: string;
  summary: string | null;
}

const SYSTEM =
  "You summarize a personal relationship from interaction metadata only — email " +
  "subjects, calendar titles, dates, channel, and direction. Never invent content " +
  "beyond what's given. Write 1–2 plain sentences, readable at a glance, about who " +
  "this contact appears to be and the recent nature and cadence of contact. No " +
  "preamble, no lists, no quotes, no markdown.";

export async function summarizeRelationship(
  name: string,
  interactions: InteractionMeta[],
): Promise<string> {
  const lines = interactions
    .slice(0, 40)
    .map((i) => {
      const day = new Date(i.occurred_at).toISOString().slice(0, 10);
      const dir = i.direction === "out" ? "you→them" : i.direction === "in" ? "them→you" : "shared";
      return `- ${day} [${i.source}, ${dir}] ${(i.summary ?? "").trim()}`.trim();
    })
    .join("\n");

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: 200,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Contact: ${name}\nInteractions (most recent first):\n${lines}`,
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  }
  const j = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = (j.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("")
    .trim();
  return text || "(no summary generated)";
}

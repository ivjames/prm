import "dotenv/config";

/**
 * Central env loader. Reads from the app-dir .env (lab980 convention).
 * Fails loud for anything the process genuinely can't run without, but stays
 * lenient for keys only some code paths need (e.g. a web-only boot doesn't
 * need the Deepgram key), so partial deploys still start.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v;
}

function optional(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export const config = {
  port: Number(optional("PORT", "8060")),
  publicOrigin: optional("PUBLIC_ORIGIN", "http://localhost:8060"),

  supabase: {
    url: optional("SUPABASE_URL"),
    anonKey: optional("SUPABASE_ANON_KEY"),
    serviceRoleKey: optional("SUPABASE_SERVICE_ROLE_KEY"),
  },

  anthropicApiKey: optional("ANTHROPIC_API_KEY"),
  // Haiku-tier for extraction/summarization (architecture.md). Overridable via env.
  anthropicModel: optional("ANTHROPIC_MODEL", "claude-haiku-4-5"),
  deepgramApiKey: optional("DEEPGRAM_API_KEY"),

  google: {
    clientId: optional("GOOGLE_OAUTH_CLIENT_ID"),
    clientSecret: optional("GOOGLE_OAUTH_CLIENT_SECRET"),
  },

  cron: {
    ingest: optional("INGEST_CRON", "*/15 * * * *"),
    cadence: optional("CADENCE_CRON", "0 * * * *"),
  },
};

/** Assert the vars a given process role needs; call at boot for a clear error. */
export function requireFor(role: "web" | "worker"): void {
  required("SUPABASE_URL");
  if (role === "web") {
    required("SUPABASE_ANON_KEY");
  }
  if (role === "worker") {
    required("SUPABASE_SERVICE_ROLE_KEY");
  }
}

import { config } from "../config";

/**
 * Direct Google OAuth 2.0 for DATA ACCESS (Gmail + Calendar reads), separate
 * from Supabase Auth login. This is the token the ingestion worker uses in the
 * background, so we need offline access (a refresh token) and store it
 * encrypted in the vault (see migration 0003). Uses global fetch (Node 22+).
 */

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://www.googleapis.com/oauth2/v3/userinfo";

// Read-only Gmail + Calendar, plus identity so we can label the account.
// Note: gmail/calendar are Google "restricted" scopes — a CASA assessment is
// required before any non-personal/public use (see docs/architecture.md).
export const DATA_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "openid",
  "email",
];

export interface GoogleToken {
  access_token: string;
  refresh_token?: string;
  expiry_ms: number; // absolute expiry, ms epoch
  scope?: string;
  token_type?: string;
}

export function isConfigured(): boolean {
  return Boolean(config.google.clientId && config.google.clientSecret);
}

export function redirectUri(): string {
  return `${config.publicOrigin}/api/connect/google/callback`;
}

export function authUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: DATA_SCOPES.join(" "),
    access_type: "offline", // we need a refresh token for background ingestion
    prompt: "consent", // force refresh-token issuance even on re-consent
    include_granted_scopes: "true",
    state,
  });
  return `${GOOGLE_AUTH}?${p.toString()}`;
}

async function tokenRequest(body: Record<string, string>): Promise<any> {
  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    throw new Error(`google token endpoint ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

export async function exchangeCode(code: string): Promise<GoogleToken> {
  const t = await tokenRequest({
    code,
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
  });
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expiry_ms: Date.now() + (t.expires_in ?? 3600) * 1000,
    scope: t.scope,
    token_type: t.token_type,
  };
}

/** Refresh an access token. Google keeps the same refresh_token across refreshes. */
export async function refresh(refreshToken: string): Promise<GoogleToken> {
  const t = await tokenRequest({
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  return {
    access_token: t.access_token,
    refresh_token: refreshToken,
    expiry_ms: Date.now() + (t.expires_in ?? 3600) * 1000,
    scope: t.scope,
    token_type: t.token_type,
  };
}

export async function userinfoEmail(accessToken: string): Promise<string> {
  const res = await fetch(GOOGLE_USERINFO, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`google userinfo ${res.status}`);
  const j = (await res.json()) as { email?: string };
  return String(j.email ?? "");
}

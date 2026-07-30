/**
 * Heuristics for telling a real person's email from an automated / role /
 * bulk sender (no-reply@, notifications@, newsletters, receipts). A PRM only
 * wants humans as contacts, so these are filtered out at ingestion and used to
 * bulk-archive junk that was imported before the filter existed.
 */

// Substring signals anywhere in the local part — catches "noreply-42",
// "bounce+tag", "mailer-daemon", "shop.updates".
const ROLE_SUBSTRING = /(no-?reply|do-?not-?reply|mailer-?daemon|unsubscribe|bounce|postmaster)/;

// Whole-local-part role names (the part before @ equals one of these).
const ROLE_EXACT = new Set([
  "noreply",
  "notification",
  "notifications",
  "notify",
  "updates",
  "update",
  "alert",
  "alerts",
  "newsletter",
  "newsletters",
  "mailer",
  "mailing",
  "mailings",
  "auto",
  "automated",
  "donotreply",
  "do-not-reply",
  "do-not-respond",
  "news",
  "info",
  "hello",
  "team",
  "support",
  "help",
  "contact",
  "sales",
  "marketing",
  "billing",
  "receipt",
  "receipts",
  "order",
  "orders",
  "store",
  "shop",
  "deals",
  "offers",
  "feedback",
  "community",
  "member",
  "members",
  "account",
  "accounts",
  "security",
  "admin",
  "webmaster",
  "daemon",
  "robot",
  "bot",
  "email",
  "mail",
]);

export function isRoleAddress(email: string | undefined | null): boolean {
  const local = String(email ?? "").split("@")[0]?.toLowerCase().trim() ?? "";
  if (!local) return true;
  if (ROLE_SUBSTRING.test(local)) return true;
  if (ROLE_EXACT.has(local)) return true;
  return false;
}

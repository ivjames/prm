/**
 * Name normalization + similarity for fuzzy duplicate detection. Deliberately
 * conservative: it clusters likely-duplicate contacts to *suggest* merges, which
 * the owner then confirms — it never merges on its own.
 */

/**
 * Canonicalize a display name for comparison: lowercase, strip accents and
 * punctuation, collapse whitespace, and sort tokens so "Doe, Jane" == "Jane Doe".
 * Returns "" for names that look like a raw email (can't be matched by name).
 */
export function normalizeName(name: string): string {
  const raw = String(name ?? "").trim();
  if (!raw || raw.includes("@")) return "";
  const cleaned = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned.split(" ").filter(Boolean).sort().join(" ");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const cur = [i + 1];
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      cur.push(Math.min(cur[j] + 1, prev[j + 1] + 1, prev[j] + cost));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Similarity in [0,1]: 1 - editDistance/maxLen. */
export function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  return max === 0 ? 0 : 1 - levenshtein(a, b) / max;
}

// Names at/above this similarity are treated as the same person (suggestion only).
export const DUPLICATE_THRESHOLD = 0.86;

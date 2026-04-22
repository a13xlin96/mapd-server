// Pure helpers for place-name normalization, dedup, and @mention parsing.
// Server-side mirror of src/utils/enrichmentHelpers.ts in the mapd client.
// Plain JS, no deps — safe to import from enrich.js and lib/vision.js.

// Casefold + strip diacritics + strip punctuation + collapse whitespace,
// so "Café Nowhere" and "cafe nowhere." collapse to the same dedup key.
function normalizePlaceName(name) {
  if (!name) return '';
  return String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // combining diacritical marks U+0300..U+036F
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Deduplicate an array by a caller-supplied key function. Preserves input
// order so earlier (higher-confidence) entries win ties.
function dedupe(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// Handles that pattern-match as personal accounts or generic content-creator
// brands. Filtered out before we pass handles to the AI as "possible venues"
// so @foodblog / @sarah_eats don't nudge the model into hallucinating a venue.
const NON_VENUE_HANDLE_PATTERNS = [
  /^@?[a-z]+_?(eats|eater|foodie|foodies|tasteof|diaries|diary|adventures|travels|traveler|explores|official|real|fan|life|journey|blog|vlog|world|girl|guy|tv)$/i,
  /^@?(the_?)?[a-z]+(_?(bun|boo|babe|bby|mama|dad|king|queen|ling))$/i,
];

// Extract up to 5 distinct @handles from a caption, filtering out the
// obvious non-venue patterns.
function parseMentionedAccounts(description) {
  if (!description) return [];
  const raw = String(description).match(/@[a-zA-Z0-9_.]{3,30}/g) || [];
  const seen = new Set();
  const kept = [];
  for (const full of raw) {
    const handle = full.slice(1).toLowerCase();
    if (seen.has(handle)) continue;
    seen.add(handle);
    if (NON_VENUE_HANDLE_PATTERNS.some((re) => re.test(handle))) continue;
    kept.push(handle);
    if (kept.length >= 5) break;
  }
  return kept;
}

module.exports = { normalizePlaceName, dedupe, parseMentionedAccounts };

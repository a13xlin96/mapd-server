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
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
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

// Account identity is evidence, not a venue classifier. Keep legitimate short
// names and suffixes such as "official". Cap the input budget at 30 accounts.
function parseMentionedAccounts(description) {
  const kept = new Set();
  const matches = String(description || '').matchAll(/(?:^|[^\p{L}\p{N}_@.])@([a-zA-Z0-9_](?:[a-zA-Z0-9_.]{0,28}[a-zA-Z0-9_])?)(?![a-zA-Z0-9_])/gu);
  for (const match of matches) {
    const handle = match[1].toLowerCase();
    if (handle.includes('..')) continue;
    kept.add(handle);
    if (kept.size >= 30) break;
  }
  return [...kept];
}
module.exports = {normalizePlaceName, dedupe, parseMentionedAccounts};

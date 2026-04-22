const { anthropic } = require('../lib/anthropic');
const { getCached, setCache } = require('../lib/cache');

function stripFences(text) {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function textOf(message) {
  const first = message && message.content && message.content[0];
  return first && first.type === 'text' ? (first.text || '').trim() : '';
}

// Claude sometimes appends prose after the JSON it promised to return.
// Pull out the first balanced {...} or [...] block and parse just that.
function parseFirstJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed === 'null') return null;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch !== '{' && ch !== '[') continue;
    const open = ch;
    const close = ch === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let j = i; j < trimmed.length; j++) {
      const c = trimmed[j];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          const slice = trimmed.slice(i, j + 1);
          try { return JSON.parse(slice); } catch { return null; }
        }
      }
    }
  }
  return null;
}

/** Extract place name from title/description caption when structured methods fail. */
async function aiExtractPlace(ogData) {
  const title = ogData.title || '';
  const description = ogData.description || '';
  if (!title && !description) return null;

  const cacheKey = `ai:extract:${title.slice(0, 50)}:${description.slice(0, 50)}`;
  const cached = await getCached(cacheKey);
  if (cached && cached.place) return `${cached.place.name} ${cached.place.city || ''}`.trim();
  if (cached && cached.place === null) return null;

  try {
    const caption = `${title}\n${description.slice(0, 800)}`.trim();

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: `You are extracting the specific place name from a social media post about a real-world location (restaurant, bar, cafe, shop, attraction, hotel, etc.).

Look for:
- Named businesses ("at Ichiran Ramen", "the Sandwich Board", "visited Bavel")
- Places after prepositions ("at", "in", "visited", "tried", "went to")
- Places before locations ("Cafe Luna in Brooklyn", "Weng Yao Chicken, Jiaoxi")

Caption:
${caption}

Return ONLY valid JSON: {"name": "place name", "city": "city or neighborhood", "country": "country"}
If the post does NOT mention any specific named place (just a generic "best pizza" with no name), return: null`,
      }],
    });

    const text = stripFences(textOf(message));
    const parsed = parseFirstJson(text);
    if (parsed && parsed.name) {
      await setCache(cacheKey, { place: parsed });
      return `${parsed.name} ${parsed.city || ''}`.trim();
    }
    await setCache(cacheKey, { place: null });
    return null;
  } catch (err) {
    console.error('aiExtractPlace failed:', err.message);
    return null;
  }
}

/** Verify Google Places result matches the caption; suggest a better query when it doesn't. */
async function aiVerifyPlace(ogData, placeName, placeAddress, placeTypes) {
  try {
    const caption = `${ogData.title || ''}\n${(ogData.description || '').slice(0, 600)}`.trim();

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      messages: [{
        role: 'user',
        content: `A social media post mentions a place. We searched Google Places and got a result. Does the result match what the post is actually about?\n\nCaption:\n${caption}\n\nGoogle Places result:\n- Name: ${placeName}\n- Address: ${placeAddress}\n- Types: ${(placeTypes || []).join(', ')}\n\nReturn ONLY valid JSON: {"match": true/false, "betterQuery": "refined search query if not a match, or null"}`,
      }],
    });

    const text = stripFences(textOf(message));
    const parsed = parseFirstJson(text);
    if (!parsed) return { match: true, betterQuery: null };
    return {
      match: parsed.match != null ? parsed.match : true,
      betterQuery: parsed.betterQuery || null,
    };
  } catch (err) {
    console.error('aiVerifyPlace failed:', err.message);
    return { match: true, betterQuery: null };
  }
}

/** Extract ALL places from a social post; returns [{name, city, address, source?}, ...].
 *  Accepts optional mentionedAccounts (caption @handles already filtered by the caller)
 *  and collaborators (IG Collab co-authors, when available) to give the model more
 *  signal on thin captions. Cache key includes the mentions list because it influences
 *  the answer — otherwise a stale cache hit returns mention-unaware results. */
async function aiExtractPlaces({
  title,
  description,
  hashtags,
  uploader,
  subtitles,
  mentionedAccounts,
  collaborators,
}) {
  const mentionsKey = Array.isArray(mentionedAccounts) ? mentionedAccounts.slice(0, 5).join(',') : '';
  const cacheKey = `ai:places:${(title || '').slice(0, 50)}:${(description || '').slice(0, 50)}:${(subtitles || '').slice(0, 30)}:${mentionsKey.slice(0, 50)}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  try {
    const mentionLines = [];
    if (Array.isArray(mentionedAccounts) && mentionedAccounts.length) {
      mentionLines.push(
        `Mentioned accounts (may or may not be venues): ${mentionedAccounts.slice(0, 5).map((h) => '@' + h).join(' ')}`,
      );
    }
    if (Array.isArray(collaborators) && collaborators.length) {
      mentionLines.push(
        `Collaborators / co-authors: ${collaborators.slice(0, 3).map((h) => '@' + h).join(' ')}`,
      );
    }

    const context = [
      title ? `Title: ${title}` : '',
      description ? `Caption: ${(description || '').slice(0, 1200)}` : '',
      uploader ? `Uploader: ${uploader}` : '',
      subtitles ? `Video transcript/subtitles: ${(subtitles || '').slice(0, 3000)}` : '',
      hashtags && hashtags.length ? `Hashtags: ${hashtags.join(', ')}` : '',
      ...mentionLines,
    ].filter(Boolean).join('\n');

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `Extract ALL specific place names (restaurants, bars, cafes, shops, attractions, hotels) from this social media post.

Rules:
- Only extract NAMED businesses or attractions (not generic descriptions like "best pizza spot")
- Include the city/neighborhood if mentioned or inferrable from context
- If a full address is given, include it
- If there are multiple places, return all of them
- If NO specific named place is found, return an empty list
- For each place, record which signal it came from: "caption", "hashtag", "transcript", or "handle" (a venue-looking @mention or collaborator). When uncertain about a handle being a venue, OMIT it — do not guess.

${context}

Return ONLY valid JSON: {"places": [{"name": "Place Name", "city": "City", "address": "full address if given, otherwise empty string", "source": "caption" | "hashtag" | "transcript" | "handle"}], "count": N}`,
      }],
    });

    const text = stripFences(textOf(message));
    const parsed = parseFirstJson(text);
    const result = {
      places: Array.isArray(parsed && parsed.places) ? parsed.places : [],
      count: (parsed && parsed.count) || 0,
    };
    await setCache(cacheKey, result);
    return result;
  } catch (err) {
    console.error('aiExtractPlaces failed:', err.message);
    return { places: [], count: 0 };
  }
}

module.exports = { aiExtractPlace, aiVerifyPlace, aiExtractPlaces };

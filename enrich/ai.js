const { anthropic } = require('../lib/anthropic');
const { getCached, setCache } = require('../lib/cache');

function stripFences(text) {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function textOf(message) {
  const first = message && message.content && message.content[0];
  return first && first.type === 'text' ? (first.text || '').trim() : '';
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
    if (!text || text === 'null') {
      await setCache(cacheKey, { place: null });
      return null;
    }
    const parsed = JSON.parse(text);
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
    if (!text) return { match: true, betterQuery: null };

    const parsed = JSON.parse(text);
    return {
      match: parsed && parsed.match != null ? parsed.match : true,
      betterQuery: (parsed && parsed.betterQuery) || null,
    };
  } catch (err) {
    console.error('aiVerifyPlace failed:', err.message);
    return { match: true, betterQuery: null };
  }
}

/** Extract ALL places from a social post; returns [{name, city, address}, ...]. */
async function aiExtractPlaces({ title, description, hashtags, uploader, subtitles }) {
  const cacheKey = `ai:places:${(title || '').slice(0, 50)}:${(description || '').slice(0, 50)}:${(subtitles || '').slice(0, 30)}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  try {
    const context = [
      title ? `Title: ${title}` : '',
      description ? `Caption: ${(description || '').slice(0, 1200)}` : '',
      uploader ? `Uploader: ${uploader}` : '',
      subtitles ? `Video transcript/subtitles: ${(subtitles || '').slice(0, 1500)}` : '',
      hashtags && hashtags.length ? `Hashtags: ${hashtags.join(', ')}` : '',
    ].filter(Boolean).join('\n');

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Extract ALL specific place names (restaurants, bars, cafes, shops, attractions, hotels) from this social media post.

Rules:
- Only extract NAMED businesses or attractions (not generic descriptions like "best pizza spot")
- Include the city/neighborhood if mentioned or inferrable from context
- If a full address is given, include it
- If there are multiple places, return all of them
- If NO specific named place is found, return an empty list

${context}

Return ONLY valid JSON: {"places": [{"name": "Place Name", "city": "City", "address": "full address if given, otherwise empty string"}], "count": N}`,
      }],
    });

    const text = stripFences(textOf(message));
    const parsed = JSON.parse(text);
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

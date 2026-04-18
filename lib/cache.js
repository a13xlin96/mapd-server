const { Redis } = require('@upstash/redis');

const CACHE_TTL_SECONDS = 60 * 60 * 24; // 24 hours

let redis = null;
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    console.log('Redis cache connected (Upstash)');
  } else {
    console.log('Redis not configured — using in-memory cache (not persistent across restarts)');
  }
} catch (err) {
  console.warn('Redis init failed, using in-memory fallback:', err.message);
}

const memoryCache = new Map();

async function getCached(key) {
  if (redis) {
    try {
      const data = await redis.get(key);
      if (data) return data;
    } catch (err) {
      console.warn('Redis get failed, falling back to memory:', err.message);
    }
  }
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_SECONDS * 1000) {
    memoryCache.delete(key);
    return null;
  }
  return entry.data;
}

async function setCache(key, data, ttlSeconds) {
  const ttl = ttlSeconds || CACHE_TTL_SECONDS;
  if (redis) {
    try {
      await redis.set(key, data, { ex: ttl });
    } catch (err) {
      console.warn('Redis set failed, using memory only:', err.message);
    }
  }
  if (memoryCache.size > 5000) {
    const oldest = memoryCache.keys().next().value;
    memoryCache.delete(oldest);
  }
  memoryCache.set(key, { data, timestamp: Date.now() });
}

function normalizeUrlForCache(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    for (const param of ['_r', '_t', '_d', '_svg', 'igsh', 'igshid', 'utm_source', 'utm_medium', 'utm_campaign', 'fbclid', 'ref', 'share_id', 'g_st', 'g_ep', 'entry', 'coh', 'skid']) {
      parsed.searchParams.delete(param);
    }
    return parsed.origin + parsed.pathname.replace(/\/+$/, '') + (parsed.searchParams.toString() ? '?' + parsed.searchParams.toString() : '');
  } catch {
    return rawUrl;
  }
}

module.exports = { redis, getCached, setCache, normalizeUrlForCache, CACHE_TTL_SECONDS };

const { persistThumbnail, isThumbnailUrl } = require('./thumbnails');
const { isAllowedExtractUrl } = require('./urlValidation');
const { normalizeUrl } = require('../enrich/urlUtils');

async function extractFresh(sourceUrl) {
  if (!isAllowedExtractUrl(sourceUrl)) return null;
  const { fetchInstagramReelPost, isInstagramReelUrl } = require('./instagramReel');
  const { fetchInstagramCarouselPost, isInstagramPostUrl } = require('./instagramCarousel');
  const { fetchTikTokPhotoPost, isTikTokPhotoUrl } = require('./tiktokPhoto');
  let data;
  try {
    if (isInstagramReelUrl(sourceUrl)) data = await fetchInstagramReelPost(sourceUrl);
    else if (isInstagramPostUrl(sourceUrl)) data = await fetchInstagramCarouselPost(sourceUrl);
    else if (isTikTokPhotoUrl(sourceUrl)) data = await fetchTikTokPhotoPost(sourceUrl);
  } catch { /* Fall back to the existing extractor; no AI or Places calls. */ }
  if (!data?.thumbnail_url) data = await require('./ytdlp').runYtDlp(sourceUrl);
  return { image: data.thumbnail_url || '', url: data.webpage_url || sourceUrl };
}
function createThumbnailRepair({ persist = persistThumbnail, extract = extractFresh } = {}) {
  // Repeated sources across pins cost one extraction per repair run.
  const results = new Map();
  return async function repairPin(fs, snapshot) {
    const pin = snapshot.data();
    const originals = [{url:pin.url,ogImage:pin.ogImage}, ...(pin.sources || [])];
    const repaired = new Map();
    for (const source of originals) {
      if (!source.url || !isAllowedExtractUrl(source.url) || (source.ogImage && !isThumbnailUrl(source.ogImage))) continue;
      const key = normalizeUrl(source.url);
      if (!results.has(key)) {
        results.set(key, (async () => {
          // Historical pin fields came from clients too; don't let them seed
          // the shared verified cache. Fresh server extraction below may.
          const saved = await persist(source.ogImage || '', source.url, pin.userId);
          if (saved && saved !== source.ogImage) return saved;
          try {
            const fresh = await extract(source.url);
            if (!fresh?.image) return null;
            const hosted = await persist(fresh.image, fresh.url);
            return hosted && hosted !== fresh.image ? hosted : null;
          } catch { return null; }
        })());
      }
      const image = await results.get(key);
      if (image) repaired.set(key, image);
    }
    if (!repaired.size) return false;
    // A link may be removed or replaced while extraction is in flight. Merge
    // into the fresh doc and never resurrect a source or overwrite a new image.
    return fs.runTransaction(async txn => {
      const current = await txn.get(snapshot.ref);
      if (!current.exists) return false;
      const data = current.data();
      if (data.userId !== pin.userId) return false;
      const patch = {};
      if (data.url && data.url === pin.url && data.ogImage === pin.ogImage && repaired.has(normalizeUrl(data.url))) patch.ogImage = repaired.get(normalizeUrl(data.url));
      if (Array.isArray(data.sources)) {
        let changed = false;
        const sources = data.sources.map(source => {
          const original = originals.find(old => old.url === source.url && old.ogImage === source.ogImage);
          const image = original && source.url && repaired.get(normalizeUrl(source.url));
          if (!image || image === source.ogImage) return source;
          changed = true;
          return {...source, ogImage:image};
        });
        if (changed) patch.sources = sources;
      }
      if (!Object.keys(patch).length) return false;
      txn.update(snapshot.ref, patch);
      return true;
    });
  };
}
module.exports = { createThumbnailRepair };

const { validId, sourceKey, identities } = require('../functions/lib/contentIdentity');

// This is an optimization, never the uniqueness barrier for creating pins.
// Missing memberships return no matches; callers must preserve normal processing.
// Required collection composite: userId ASC, contentIds ARRAY_CONTAINS,
// __name__ ASC (Firestore appends the document-name field implicitly).
// staleRowIds are repair hints only; this reader never mutates memberships.
function createContentIndex({ db, pageSize = 100 }) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new Error('invalid_page_size');

  async function lookup({ uid, contentId, url }) {
    if (!validId(uid)) throw new Error('invalid_user_id');
    const key = contentId || sourceKey(url);
    if (typeof key !== 'string' || !/^(instagram|tiktok|youtube|url):[^\s]+$/.test(key) || key.length > 256) {
      throw new Error('invalid_content_identity');
    }
    const account = await db.collection('accountingAccounts').doc(uid).get();
    const pins = [], seen = new Set(), staleRowIds = [];
    let cursor = null, pages = 0, rowsRead = 0, pinsRead = 0;
    while (true) {
      let query = db.collection('pinContentIndex').where('userId', '==', uid)
        .where('contentIds', 'array-contains', key).orderBy('__name__').limit(pageSize);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      pages++; rowsRead += page.size;
      for (const row of page.docs) {
        const data = row.data();
        if (data.userId !== uid || !validId(data.pinId) || !Array.isArray(data.contentIds) || !data.contentIds.includes(key)) {
          staleRowIds.push(row.id); continue;
        }
        if (seen.has(data.pinId)) continue;
        seen.add(data.pinId);
        const pin = await db.collection('pins').doc(data.pinId).get();
        pinsRead++;
        if (!pin.exists || pin.data().userId !== uid || !identities(pin.data()).includes(key)) {
          staleRowIds.push(row.id); continue;
        }
        pins.push({ ...pin.data(), id: pin.id });
      }
      if (page.size < pageSize) break;
      cursor = page.docs[page.docs.length - 1].id;
    }
    return { pins, indexReady: account.exists && account.data().indexReady === true,
      staleRowIds, reads: { account: 1, rows: rowsRead, pins: pinsRead, pages } };
  }
  return { lookup };
}

module.exports = { createContentIndex };

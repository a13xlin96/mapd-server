const { FakeFirestore } = require('./helpers/fakeFirestore');
const { createContentIndex } = require('../lib/contentIndex');
const { identities, indexRows } = require('../functions/lib/contentIdentity');

let db;
const save = (id, pin, indexed = true) => {
  db.seed('pins', id, pin);
  if (indexed) for (const row of indexRows(pin.userId, id, identities(pin))) db.seed('pinContentIndex', row.id, row);
};
beforeEach(() => { db = new FakeFirestore(); });

// Instrument actual SDK get calls in a local adapter; unrelated documents in
// the fake's backing Map are not Firestore document reads.
function instrument(db) {
  const reads = { documents: 0, queries: 0, returned: 0, queriesByCollection: [] };
  const collection = db.collection.bind(db);
  const wrap = (target, isDoc, name) => new Proxy(target, { get(obj, prop) {
    if (prop === 'get') return async () => {
      const result = await obj.get();
      if (isDoc) reads.documents++;
      else { reads.queries++; reads.returned += result.size; reads.queriesByCollection.push(name); }
      return result;
    };
    if (['where', 'orderBy', 'limit', 'startAfter', 'doc'].includes(prop)) {
      return (...args) => wrap(obj[prop](...args), prop === 'doc', name);
    }
    const value = obj[prop]; return typeof value === 'function' ? value.bind(obj) : value;
  } });
  db.collection = name => wrap(collection(name), false, name);
  return reads;
}

test.each([10, 1000, 10000])('one match costs constant reads with %i unrelated pins', async count => {
  for (let i = 0; i < count; i++) save(`unrelated-${i}`, { userId: 'alice', url: `https://youtu.be/other${i}` });
  save('match', { userId: 'alice', url: 'https://instagram.com/reel/target/?igsh=abc' });
  db.seed('accountingAccounts', 'alice', { indexReady: true });
  const reads = instrument(db);
  const result = await createContentIndex({ db }).lookup({ uid: 'alice', url: 'https://www.instagram.com/p/target/?stkn=other' });
  expect(result.pins.map(pin => pin.id)).toEqual(['match']);
  expect(result.indexReady).toBe(true);
  expect(reads).toEqual({ documents: 2, queries: 1, returned: 1, queriesByCollection: ['pinContentIndex'] });
});

test('pages every matching pin across primary and attached URL variants, isolated by owner', async () => {
  save('one', { userId: 'alice', url: 'https://youtu.be/abc' });
  save('two', { userId: 'alice', sources: [{ url: 'https://youtube.com/shorts/abc?utm_source=x' }] });
  save('three', { userId: 'alice', url: 'https://youtube.com/watch?v=abc&feature=share' });
  save('foreign', { userId: 'bob', url: 'https://youtu.be/abc' });
  const result = await createContentIndex({ db, pageSize: 1 }).lookup({ uid: 'alice', contentId: 'youtube:abc' });
  expect(result.pins.map(pin => pin.id).sort()).toEqual(['one', 'three', 'two']);
  expect(result.reads.pages).toBe(4);
});

test('stale source removal, deletion, ownership and forged cached data cannot produce false matches', async () => {
  save('removed', { userId: 'alice', sources: [{ url: 'https://youtu.be/abc' }] });
  save('deleted', { userId: 'alice', url: 'https://youtu.be/abc' });
  save('owner', { userId: 'alice', url: 'https://youtu.be/abc' });
  save('real', { userId: 'alice', url: 'https://youtu.be/abc', id: 'untrusted' });
  await db.collection('pins').doc('removed').update({ sources: [] });
  await db.collection('pins').doc('deleted').delete();
  await db.collection('pins').doc('owner').update({ userId: 'bob' });
  const result = await createContentIndex({ db }).lookup({ uid: 'alice', contentId: 'youtube:abc' });
  expect(result.pins.map(pin => pin.id)).toEqual(['real']);
  expect(result.staleRowIds).toHaveLength(3);
});

test('index lag and outages never cause migrated accounts to fullscan', async () => {
  db.seed('accountingAccounts', 'alice', { indexReady: true });
  save('lagged', { userId: 'alice', url: 'https://youtu.be/abc' }, false);
  const reads = instrument(db);
  const lookup = createContentIndex({ db }).lookup;
  expect(await lookup({ uid: 'alice', contentId: 'youtube:abc' })).toMatchObject({ pins: [], indexReady: true });
  expect(reads.queriesByCollection).toEqual(['pinContentIndex']);
  const collection = db.collection.bind(db);
  db.collection = name => { if (name === 'pinContentIndex') throw new Error('index_unavailable'); return collection(name); };
  await expect(lookup({ uid: 'alice', contentId: 'youtube:abc' })).rejects.toThrow('index_unavailable');
});

test('corrupt foreign-owner rows returned by a faulty adapter are rejected before reading pins', async () => {
  const reads = instrument(db), collection = db.collection.bind(db);
  db.collection = name => {
    if (name !== 'pinContentIndex') return collection(name);
    const query = { where: () => query, orderBy: () => query, limit: () => query,
      get: async () => ({ size: 1, docs: [{ id: 'foreign-row', data: () => ({ userId: 'bob', pinId: 'secret', contentIds: ['youtube:abc'] }) }] }) };
    return query;
  };
  const result = await createContentIndex({ db }).lookup({ uid: 'alice', contentId: 'youtube:abc' });
  expect(result.pins).toEqual([]);
  expect(result.staleRowIds).toEqual(['foreign-row']);
  expect(reads.documents).toBe(1);
});

test('duplicate chunk rows read each persisted pin once and generic URL normalization is reusable', async () => {
  const url = 'https://example.org/place?b=2&a=1&utm_source=old#fragment';
  save('one', { userId: 'alice', url });
  const [row] = indexRows('alice', 'one', identities({ url }));
  db.seed('pinContentIndex', 'extra', row);
  const result = await createContentIndex({ db, pageSize: 1 }).lookup({ uid: 'alice', url: 'https://example.org/place?a=1&b=2' });
  expect(result.pins).toHaveLength(1);
  expect(result.reads.pins).toBe(1);
});

test.each([
  ['https://www.tiktok.com/@user/video/123456?share_id=first', 'https://m.tiktok.com/@other/video/123456?share_id=second'],
  ['https://instagram.com/reels/ABC123/?igshid=one', 'https://m.instagram.com/tv/ABC123/?igshid=two'],
  ['https://youtube.com/embed/abc_123', 'https://music.youtube.com/watch?v=abc_123'],
])('canonical provider variants resolve persisted content: %s', async (savedUrl, queryUrl) => {
  save('one', { userId: 'alice', url: savedUrl });
  expect((await createContentIndex({ db }).lookup({ uid: 'alice', url: queryUrl })).pins.map(pin => pin.id)).toEqual(['one']);
});

test('writer and reader use the same bounded identity for an oversized social identifier', async () => {
  const url = 'https://instagram.com/p/' + 'a'.repeat(247);
  save('large-id', { userId: 'alice', url });
  const found = await createContentIndex({ db }).lookup({ uid: 'alice', url });
  expect(found.pins.map(pin => pin.id)).toEqual(['large-id']);
});

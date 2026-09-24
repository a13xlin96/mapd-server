const { createThumbnailService, isThumbnailUrl, thumbnailKey } = require('../lib/thumbnails');
const source = 'https://www.instagram.com/reel/ABC123/';
const raw = 'https://scontent.cdninstagram.com/test.jpg?oe=old';
function fixture() {
  const files = new Map();
  const bucket = { name: 'test.appspot.com', file: jest.fn(name => ({
    getMetadata: jest.fn(async () => { if (!files.has(name)) throw { code: 404 }; return [files.get(name)]; }),
    save: jest.fn(async (bytes, options) => { files.set(name, options.metadata); }),
  })) };
  const download = jest.fn(async () => ({ bytes: Buffer.from([0xff,0xd8,0xff,0]), contentType: 'image/jpeg' }));
  return { files, bucket, download, persist: createThumbnailService({ bucket, download }) };
}
test('stores once per content, reuses token URL despite rotating CDN URL', async () => {
  const f = fixture();
  const a = await f.persist(raw, source);
  const b = await f.persist(raw + '&new=1', source);
  expect(a).toMatch(/^https:\/\/firebasestorage.googleapis.com\/v0\/b\/test.appspot.com\/o\//);
  expect(b).toBe(a);
  expect(f.download).toHaveBeenCalledTimes(1);
  expect(f.files.size).toBe(1);
});
test('simultaneous shares download once', async () => {
  const f = fixture();
  const result = await Promise.all([f.persist(raw, source), f.persist(raw, source)]);
  expect(result[0]).toBe(result[1]);
  expect(f.download).toHaveBeenCalledTimes(1);
});
test.each(['http://scontent.cdninstagram.com/a','https://127.0.0.1/a','https://cdninstagram.com.evil.test/a','https://user:pass@scontent.cdninstagram.com/a','https://scontent.cdninstagram.com:8443/a'])('rejects unsafe image URL %s', url => expect(isThumbnailUrl(url)).toBe(false));
test('unsupported/missing images preserve the original without a download', async () => {
  const f = fixture();
  expect(await f.persist('', source)).toBe('');
  expect(await f.persist('https://example.com/a.jpg', source)).toBe('https://example.com/a.jpg');
  expect(f.download).not.toHaveBeenCalled();
});
test('storage failure cannot fail saving a place', async () => {
  const f = fixture();
  f.download.mockRejectedValue(new Error('unavailable'));
  expect(await f.persist(raw, source)).toBe(raw);
});
test('keys ignore tracking and isolate content', () => {
  expect(thumbnailKey(source)).toBe(thumbnailKey(source + '?igsh=abc'));
  expect(thumbnailKey(source)).not.toBe(thumbnailKey('https://www.instagram.com/reel/XYZ/'));
});

test('untrusted client images cannot seed the shared or another user cache', async () => {
  const f = fixture();
  const client = await f.persist(raw, source, 'u1');
  const other = await f.persist(raw, source, 'u2');
  const verified = await f.persist(raw, source);
  expect(new Set([client, other, verified]).size).toBe(3);
  expect(f.download).toHaveBeenCalledTimes(3);
});
test('concurrent server uploads retain the winning download token', async () => {
  const winner = { metadata: { firebaseStorageDownloadTokens: 'existing-token' } };
  const file = {
    getMetadata: jest.fn().mockRejectedValueOnce({code:404}).mockResolvedValue([winner]),
    save: jest.fn().mockRejectedValue({code:412}),
  };
  const persist = createThumbnailService({bucket:{name:'test',file:()=>file},download:async()=>({bytes:Buffer.from('jpeg'),contentType:'image/jpeg'})});
  expect(await persist(raw,source)).toContain('token=existing-token');
});

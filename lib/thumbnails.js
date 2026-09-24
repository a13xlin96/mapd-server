const { createHash, randomUUID } = require('crypto');
const https = require('https');
const dns = require('dns').promises;
const { BlockList, isIP } = require('net');
const { extractContentId, normalizeUrl } = require('../enrich/urlUtils');

const CDN_HOSTS = ['cdninstagram.com', 'fbcdn.net', 'tiktokcdn.com', 'tiktokcdn-us.com',
  'tiktokcdn-eu.com', 'ibytedtos.com', 'byteoversea.com', 'ytimg.com'];
const MAX_BYTES = 5 * 1024 * 1024;
const blocked = new BlockList();
for (const [net, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],
  ['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['192.0.0.0',24],['198.18.0.0',15],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(net,bits,'ipv4');
for (const [net,bits] of [['::',128],['::1',128],['fc00::',7],['fe80::',10],['ff00::',8]]) blocked.addSubnet(net,bits,'ipv6');

function isThumbnailUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443')
      && CDN_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch { return false; }
}
function thumbnailKey(sourceUrl, clientUid) {
  const u = new URL(sourceUrl);
  const social = ['instagram.com','tiktok.com','youtube.com','youtu.be'].some(h => u.hostname === h || u.hostname.endsWith('.' + h));
  const identity = (social && extractContentId(sourceUrl)) || normalizeUrl(sourceUrl);
  // Client-supplied URL/image pairs cannot populate the shared, server-verified cache.
  const namespace = clientUid ? `client:${clientUid}:` : 'verified:';
  return 'thumbnails/v1/' + createHash('sha256').update(namespace + identity).digest('hex');
}
function imageType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP') return 'image/webp';
  throw new Error('unsupported-image');
}
async function downloadImage(raw, redirects = 0) {
  if (!isThumbnailUrl(raw) || redirects > 3) throw new Error('unsafe-image-url');
  const u = new URL(raw);
  // Pin a public DNS answer to the request; validating before a second DNS
  // lookup would leave a rebinding window. Recheck every redirect as well.
  let dnsTimer;
  const addresses = await Promise.race([
    dns.lookup(u.hostname, { all: true }),
    new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new Error('image-dns-timeout')), 4000); }),
  ]).finally(() => clearTimeout(dnsTimer));
  if (!addresses.length || addresses.some(a => !isIP(a.address) || a.address.toLowerCase().startsWith('::ffff:') || blocked.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4'))) throw new Error('unsafe-image-address');
  const selected = addresses[0];
  return new Promise((resolve, reject) => {
    const req = https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*' },
      lookup: (_host, options, cb) => options.all ? cb(null, [selected]) : cb(null, selected.address, selected.family),
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        clearTimeout(timer);
        return downloadImage(new URL(res.headers.location, u).href, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200 || Number(res.headers['content-length'] || 0) > MAX_BYTES) {
        res.resume(); reject(new Error('image-unavailable')); return;
      }
      const chunks = []; let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BYTES) { req.destroy(new Error('image-too-large')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        clearTimeout(timer);
        try { const bytes = Buffer.concat(chunks); resolve({ bytes, contentType: imageType(bytes) }); }
        catch (err) { reject(err); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('image-timeout')), 8000);
    req.on('error', err => { clearTimeout(timer); reject(err); });
    req.on('close', () => clearTimeout(timer));
  });
}
function downloadUrl(bucket, key, metadata) {
  const token = metadata?.metadata?.firebaseStorageDownloadTokens?.split(',')[0];
  return token ? `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket.name)}/o/${encodeURIComponent(key)}?alt=media&token=${encodeURIComponent(token)}` : null;
}
function createThumbnailService({ bucket, download = downloadImage }) {
  const pending = new Map();
  return async function persist(raw, sourceUrl, clientUid) {
    if (!raw || !isThumbnailUrl(raw)) return raw || '';
    let key;
    try { key = thumbnailKey(sourceUrl, clientUid); } catch { return raw; }
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      try {
        const file = bucket.file(key);
        try {
          const [metadata] = await file.getMetadata();
          const existing = downloadUrl(bucket, key, metadata);
          if (existing) return existing;
          return raw; // Never replace an existing object's token.
        } catch (err) { if (Number(err.code) !== 404) throw err; }
        const { bytes, contentType } = await download(raw);
        const metadata = { contentType, cacheControl: 'public,max-age=31536000,immutable',
          metadata: { firebaseStorageDownloadTokens: randomUUID() } };
        try {
          await file.save(bytes, { resumable: false, metadata, preconditionOpts: { ifGenerationMatch: 0 } });
        } catch (err) {
          if (Number(err.code) !== 412) throw err; // Another server won the upload race.
          return downloadUrl(bucket, key, (await file.getMetadata())[0]) || raw;
        }
        return downloadUrl(bucket, key, metadata);
      } catch (err) {
        // No signed URLs or user links in logs. Storage must not fail a save.
        console.warn('Thumbnail persistence unavailable:', err.code || 'fetch-or-storage-failed');
        return raw;
      }
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  };
}
let persist;
async function persistThumbnail(raw, sourceUrl, clientUid) {
  if (!raw || !isThumbnailUrl(raw)) return raw || '';
  try {
    if (!persist) {
      const admin = require('firebase-admin');
      const name = process.env.FIREBASE_STORAGE_BUCKET || admin.app().options.storageBucket;
      if (!name) { console.warn('Thumbnail persistence needs FIREBASE_STORAGE_BUCKET'); return raw; }
      persist = createThumbnailService({ bucket: admin.storage().bucket(name) });
    }
    return await persist(raw, sourceUrl, clientUid);
  } catch { return raw; }
}
module.exports = { persistThumbnail, createThumbnailService, isThumbnailUrl, thumbnailKey, downloadImage, imageType };

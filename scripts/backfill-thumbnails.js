// Dry run by default. Explicit --user and --apply bound production mutations.
// FIREBASE_SERVICE_ACCOUNT_JSON + FIREBASE_STORAGE_BUCKET come from the server environment.
const admin = require('firebase-admin');
const { createThumbnailRepair } = require('../lib/repairThumbnails');
const { isThumbnailUrl } = require('../lib/thumbnails');
const { isAllowedExtractUrl } = require('../lib/urlValidation');
async function main() {
  const args = process.argv.slice(2);
  const value = name => args[args.indexOf(name) + 1];
  const uid = args.includes('--user') ? value('--user') : null;
  const limit = args.includes('--limit') ? Number(value('--limit')) : 100;
  if (!uid || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Usage: node scripts/backfill-thumbnails.js --user UID [--limit 100] [--after PIN_ID] [--apply]');
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw || !process.env.FIREBASE_STORAGE_BUCKET) throw new Error('Configure server credentials and FIREBASE_STORAGE_BUCKET first.');
  const credentials = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString());
  admin.initializeApp({credential:admin.credential.cert(credentials), storageBucket:process.env.FIREBASE_STORAGE_BUCKET});
  const fs = admin.firestore();
  let query = fs.collection('pins').where('userId','==',uid).orderBy(admin.firestore.FieldPath.documentId()).limit(limit);
  if (args.includes('--after')) query = query.startAfter(value('--after'));
  const snap = await query.get();
  const candidates = new Set();
  let pinsWithCandidates = 0;
  for (const pin of snap.docs) {
    const data = pin.data();
    const sources = [{url:data.url,ogImage:data.ogImage}, ...(Array.isArray(data.sources) ? data.sources : [])];
    const eligible = sources.filter(s => typeof s.url === 'string' && isAllowedExtractUrl(s.url) && (!s.ogImage || isThumbnailUrl(s.ogImage)));
    if (eligible.length) pinsWithCandidates++;
    eligible.forEach(s => candidates.add(s.url));
  }
  console.log(JSON.stringify({pinsWithCandidates,uniqueSourceUrls:candidates.size,mode:args.includes('--apply')?'apply':'dry-run',pins:snap.size,nextAfter:snap.docs.at(-1)?.id || null}));
  if (!args.includes('--apply')) return;
  const repair = createThumbnailRepair();
  let updated = 0;
  for (const pin of snap.docs) {
    if (await repair(fs,pin)) updated++;
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  console.log(JSON.stringify({examined:snap.size,updated}));
}
main().catch(err=>{console.error(err.message);process.exitCode=1;});

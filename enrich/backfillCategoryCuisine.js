// One-shot backfill that re-derives `category` and `cuisine` on legacy
// pins from their already-stored `types[]` + `primaryType`. No Google
// Places re-fetch — both source fields landed in the v4 Atmosphere backfill,
// so this pass is free and fast.
//
// Migration cohort guard (Codex R1): only touches pins with the legacy
// `category: 'food'` value.
//
// Lost-update guard (Codex R2): each write happens in a transaction that
// re-checks `category === 'food'` at commit time, with race => 'raced'.
//
// Lost-freshness guard (Codex R3): `newCategory`/`newCuisine` are derived
// from `txn.get(...)` data INSIDE the transaction, not the page snapshot.
// If `types[]` changed concurrently while category stayed `food`, the
// commit uses the fresh classification, not stale page data.
//
// Confidence guard: skips writes when `mapToCategory(types)` returns
// `other`. A legacy `food` pin with missing/unknown types is better
// preserved as-is than downgraded. Sample of unresolved IDs surfaces under
// `unclassifiableSample` so operators can triage.
//
// Input validation: `batchSize` must be an integer in [1, MAX_BATCH_SIZE]
// — rejecting 0 prevents a `hasMore=true` / `processed=0` infinite-loop
// trap for callers chaining pages.
//
// dryRun=true (default) returns a sample of intended changes without
// writing. Dry-run uses the page-snapshot derivation as a best-effort
// preview — it inherently can't reflect concurrent type mutations.

const { mapToCategory } = require('./categories');
const { extractCuisine } = require('./cuisine');

const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCH_SIZE = 1000;
const SAMPLE_LIMIT = 20;
const TARGET_CATEGORIES = new Set(['restaurant', 'cafe', 'bar']);

function deriveFromPin(data) {
  const types = Array.isArray(data.types) ? data.types : [];
  const primaryType = typeof data.primaryType === 'string' ? data.primaryType : null;
  return {
    types,
    primaryType,
    category: mapToCategory(types),
    cuisine: extractCuisine(types, primaryType),
  };
}

async function runBackfillCategoryCuisine({
  firestore,
  batchSize = DEFAULT_BATCH_SIZE,
  startAfterDocId = null,
  dryRun = true,
}) {
  if (!firestore) throw new Error('firestore is required');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error(
      `batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}, got: ${batchSize}`,
    );
  }

  let query = firestore.collection('pins').orderBy('__name__').limit(batchSize);
  if (startAfterDocId !== null && startAfterDocId !== undefined) {
    if (typeof startAfterDocId !== 'string' || startAfterDocId.length === 0) {
      throw new Error('startAfterDocId must be a non-empty string when provided');
    }
    // Use a doc REFERENCE rather than a snapshot so cursor pagination is
    // honored as a lexicographic boundary even when the cursor doc has
    // been deleted between pages. Previously a .get().exists check
    // silently fell through to a full scan from the head — that could
    // make automation reprocess pages or loop indefinitely.
    const startRef = firestore.collection('pins').doc(startAfterDocId);
    query = query.startAfter(startRef);
  }

  const snap = await query.get();

  let processed = 0;
  let updated = 0;
  let skippedNonCohort = 0;
  let skippedUnclassifiable = 0;
  let raced = 0;
  let lastDocId = null;
  const sample = [];
  const unclassifiableSample = [];
  const failures = [];

  for (const docSnap of snap.docs) {
    processed += 1;
    lastDocId = docSnap.id;

    const data = docSnap.data() || {};

    // Cohort guard from page snapshot — cheap filter to skip non-food pins
    // before paying for a transaction.
    if (data.category !== 'food') {
      skippedNonCohort += 1;
      continue;
    }

    if (dryRun) {
      // Dry-run: derive from page-snapshot data. Best-effort preview — can't
      // reflect concurrent type mutations.
      const previewed = deriveFromPin(data);
      if (!TARGET_CATEGORIES.has(previewed.category)) {
        skippedUnclassifiable += 1;
        if (unclassifiableSample.length < SAMPLE_LIMIT) {
          unclassifiableSample.push({
            id: docSnap.id,
            types: previewed.types,
            primaryType: previewed.primaryType,
          });
        }
        continue;
      }
      if (sample.length < SAMPLE_LIMIT) {
        sample.push({
          id: docSnap.id,
          old: { category: data.category, cuisine: data.cuisine == null ? null : data.cuisine },
          new: { category: previewed.category, cuisine: previewed.cuisine },
        });
      }
      updated += 1;
      continue;
    }

    // Live mode: derive AND write inside the transaction so both the cohort
    // precondition and the type-derived classification use the same fresh
    // read. Closes the round-3 stale-types race.
    try {
      const outcome = await firestore.runTransaction(async (txn) => {
        const fresh = await txn.get(docSnap.ref);
        if (!fresh.exists) return { state: 'raced' };
        const freshData = fresh.data() || {};
        if (freshData.category !== 'food') return { state: 'raced' };

        const derived = deriveFromPin(freshData);
        if (!TARGET_CATEGORIES.has(derived.category)) {
          return {
            state: 'unclassifiable',
            types: derived.types,
            primaryType: derived.primaryType,
          };
        }

        txn.set(
          docSnap.ref,
          { category: derived.category, cuisine: derived.cuisine },
          { merge: true },
        );
        return {
          state: 'updated',
          previous: { category: freshData.category, cuisine: freshData.cuisine == null ? null : freshData.cuisine },
          next: { category: derived.category, cuisine: derived.cuisine },
        };
      });

      if (outcome.state === 'updated') {
        updated += 1;
        if (sample.length < SAMPLE_LIMIT) {
          sample.push({ id: docSnap.id, old: outcome.previous, new: outcome.next });
        }
      } else if (outcome.state === 'raced') {
        raced += 1;
      } else if (outcome.state === 'unclassifiable') {
        skippedUnclassifiable += 1;
        if (unclassifiableSample.length < SAMPLE_LIMIT) {
          unclassifiableSample.push({
            id: docSnap.id,
            types: outcome.types,
            primaryType: outcome.primaryType,
          });
        }
      }
    } catch (err) {
      failures.push({
        id: docSnap.id,
        error: String((err && err.message) || err).slice(0, 200),
      });
    }
  }

  return {
    processed,
    updated,
    skippedNonCohort,
    skippedUnclassifiable,
    raced,
    failures,
    hasMore: snap.size === batchSize,
    lastDocId,
    dryRun,
    sample,
    unclassifiableSample,
  };
}

module.exports = { runBackfillCategoryCuisine };

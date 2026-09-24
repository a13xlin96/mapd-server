const { createPinAccounting } = require('./pinAccounting');
const { hash, validId } = require('./contentIdentity');

const RECEIPT = /^[a-f0-9]{64}$/;
const STATES = ['pending', 'awaiting_account', 'needs_review', 'complete'];
const PROJECT = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/;
const invalid = code => { throw new Error(code); };

function repairOptions({ project, uid, apply = false, retryNeedsReview = false,
  pageSize = 100, maxPages = 10, cursor = null } = {}) {
  if (!PROJECT.test(project || '')) invalid('explicit_valid_project_required');
  if (!validId(uid) || !uid.trim() || uid === '.' || uid === '..') invalid('explicit_valid_uid_required');
  if (typeof apply !== 'boolean' || typeof retryNeedsReview !== 'boolean') invalid('invalid_mode');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 250) invalid('invalid_page_size');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20) invalid('invalid_max_pages');
  // Tokens contain only a scope digest and a hashed inbox document ID. Bind
  // report/apply and review policy too: a preview cursor must not skip writes.
  const scope = hash(JSON.stringify([project, uid, apply, retryNeedsReview]));
  let after = null;
  if (cursor !== null) {
    if (typeof cursor !== 'string' || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalid('invalid_cursor');
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (decoded.v !== 1 || decoded.scope !== scope || !RECEIPT.test(decoded.after)
        || Object.keys(decoded).sort().join(',') !== 'after,scope,v') invalid('invalid_cursor');
      after = decoded.after;
    } catch { invalid('invalid_cursor'); }
  }
  return { project, uid, apply, retryNeedsReview, pageSize, maxPages, scope, after };
}

function createAccountingRepair({ db, admin, repairMutation = createPinAccounting({ db, admin }).repairMutation }) {
  async function run(options = {}) {
    const { project, uid, apply, retryNeedsReview, pageSize, maxPages, scope, after } = repairOptions(options);
    const { signal, onProgress = () => {} } = options;
    let cursor = after;
    const report = { project, accountHash: hash(uid), dryRun: !apply, retryNeedsReview,
      pageSize, maxPages, pages: 0, scanned: 0, eligible: 0, attempted: 0,
      states: Object.fromEntries(STATES.map(state => [state, 0])),
      outcomes: { reconciled: 0, complete: 0, missing: 0, disabled: 0, inactive_account: 0, needs_review: 0, failed: 0 },
      scanComplete: false, stoppedReason: null, nextCursor: null };
    const snapshot = () => ({ ...report, states: { ...report.states }, outcomes: { ...report.outcomes },
      nextCursor: report.scanComplete || !cursor ? null
        : Buffer.from(JSON.stringify({ v: 1, scope, after: cursor })).toString('base64url') });
    const stop = reason => { report.stoppedReason = reason; };
    while (report.pages < maxPages && !report.stoppedReason && !report.scanComplete) {
      if (signal?.aborted) { stop('aborted'); break; }
      // Scan all account states in document order. Changing state during repair
      // cannot shift offsets, and a deleted cursor document remains resumable.
      let query = db.collection('accountingInbox').where('userId', '==', uid).orderBy('__name__').limit(pageSize);
      if (cursor) query = query.startAfter(cursor);
      let page;
      try { page = await query.get(); } catch { stop('query_failed'); break; }
      report.pages++;
      for (const doc of page.docs) {
        if (signal?.aborted) { stop('aborted'); break; }
        const item = doc.data();
        report.scanned++;
        if (!RECEIPT.test(doc.id) || item?.userId !== uid || !STATES.includes(item.state)) {
          stop('invalid_record'); break;
        }
        report.states[item.state]++;
        if (item.state === 'complete' || (item.state === 'needs_review' && !retryNeedsReview)) {
          cursor = doc.id;
          continue;
        }
        const mutation = item.mutation;
        // Fail closed on corrupt ownership/identity before invoking the existing
        // server-only consumer. Never accept event facts from CLI arguments.
        if (mutation?.uid !== uid || !validId(mutation.pinId)
          || typeof mutation.generation !== 'string' || !mutation.generation
          || typeof mutation.mutationId !== 'string' || !mutation.mutationId
          || hash(`${uid}\0${mutation.pinId}\0${mutation.generation}\0${mutation.mutationId}`) !== doc.id) {
          stop('invalid_record'); break;
        }
        report.eligible++;
        if (apply) {
          report.attempted++;
          let result;
          try {
            // This is the only write path. Its receipts guard crash replay and
            // concurrent trigger delivery; it never starts link extraction.
            result = await repairMutation(doc.id, { manual: retryNeedsReview });
          } catch { result = { status: 'failed' }; }
          const status = Object.hasOwn(report.outcomes, result?.status) ? result.status : 'failed';
          report.outcomes[status]++;
          if (!['reconciled', 'complete', 'missing'].includes(status)) {
            // Preserve the boundary BEFORE this record, including when capture
            // is disabled or the user is missing. A resume retries the blocker.
            stop(status); break;
          }
        }
        cursor = doc.id;
      }
      if (!report.stoppedReason && page.size < pageSize) report.scanComplete = true;
      await onProgress(snapshot());
    }
    if (!report.stoppedReason && !report.scanComplete) stop('page_limit');
    return snapshot();
  }
  return { run };
}

module.exports = { createAccountingRepair, repairOptions };

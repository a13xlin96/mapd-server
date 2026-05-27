// Unit tests for the Cloud Function handler. Uses injected deps (no real
// firebase-functions-test, no real firebase-admin) so the handler can be
// exercised in pure node without booting the Functions runtime.

const { _internal } = require('..');
const { createEnrichOnPendingJobHandler } = _internal;

// Tiny fake Firestore supporting just enough for markFailedIfStillPending:
// docs are a Map<id, data|null>; runTransaction calls fn({get, update})
// against a one-shot snapshot view; updates merge into the underlying map.
function makeFakeFirestore() {
  const docs = new Map();
  const transactionLog = [];

  function makeRef(id) {
    return {
      __id: id,
      get: () => Promise.resolve(makeSnap(id)),
      // mimic admin SDK's update so non-txn code paths could use it
      update: async (patch) => {
        const cur = docs.get(id);
        if (!cur) throw new Error(`update on missing doc ${id}`);
        docs.set(id, { ...cur, ...patch });
      },
    };
  }

  function makeSnap(id) {
    const data = docs.get(id);
    return {
      __id: id,
      exists: data !== undefined && data !== null,
      data: () => (data === undefined || data === null ? undefined : { ...data }),
      ref: makeRef(id),
    };
  }

  return {
    seed(id, data) { docs.set(id, { ...data }); },
    read(id) { return docs.get(id); },
    delete(id) { docs.set(id, null); },
    transactionLog,
    runTransaction: async (fn) => {
      // Capture which doc and what the snapshot looked like for debugging.
      const localOps = [];
      const txn = {
        get: async (ref) => {
          const snap = makeSnap(ref.__id);
          localOps.push({ op: 'get', id: ref.__id, exists: snap.exists, data: snap.data() });
          return snap;
        },
        update: (ref, patch) => {
          const cur = docs.get(ref.__id);
          if (!cur) {
            localOps.push({ op: 'update-missing', id: ref.__id });
            return;
          }
          docs.set(ref.__id, { ...cur, ...patch });
          localOps.push({ op: 'update', id: ref.__id, patch });
        },
      };
      const result = await fn(txn);
      transactionLog.push(localOps);
      return result;
    },
  };
}

// Builder for the synthetic Firestore-create event the trigger receives.
function makeEvent({ jobId, data, time }) {
  const fs = makeFakeFirestore();
  if (data !== null) fs.seed(jobId, data);

  // The snap.ref needs to point to our fake so markFailedIfStillPending
  // can talk to the same docs map.
  const ref = {
    __id: jobId,
    get: () => Promise.resolve({
      exists: fs.read(jobId) !== undefined,
      data: () => fs.read(jobId),
    }),
  };

  const snap = {
    data: () => fs.read(jobId),
    ref,
  };

  const event = {
    data: data === null ? null : snap,
    params: { jobId },
    time,
  };

  return { event, fs };
}

const FIXED_TS = { _ts: true };

function buildHandler({ axiosPost, maxAgeMs, getAdminToken = () => 'fake-token' }) {
  // Each test gets its own fs via makeEvent — but the handler closure captures
  // ONE firestore at construction time. So we return a factory the test calls
  // with the per-test fs.
  return (fs) => createEnrichOnPendingJobHandler({
    firestore: fs,
    axiosInstance: { post: axiosPost },
    getAdminToken,
    enrichServerUrl: 'https://example.test',
    serverTimestamp: () => FIXED_TS,
    maxAgeMs,
    log: { log: () => {}, warn: () => {}, error: () => {} },
  });
}

describe('enrichOnPendingJob handler', () => {
  test('skip: non-pending status (legacy direct-POST doc) → no axios, no write', async () => {
    const axiosPost = jest.fn();
    const { event, fs } = makeEvent({
      jobId: 'j1',
      data: { status: 'processing', userId: 'u1', url: 'https://x/' },
      time: new Date().toISOString(),
    });
    const handler = buildHandler({ axiosPost })(fs);

    const result = await handler(event);
    expect(result).toBeNull();
    expect(axiosPost).not.toHaveBeenCalled();
    expect(fs.read('j1').status).toBe('processing');
  });

  test('skip: snap.data null/missing → return null without throw', async () => {
    const axiosPost = jest.fn();
    const { event, fs } = makeEvent({
      jobId: 'j_missing',
      data: null,
      time: new Date().toISOString(),
    });
    const handler = buildHandler({ axiosPost })(fs);

    const result = await handler(event);
    expect(result).toBeNull();
    expect(axiosPost).not.toHaveBeenCalled();
  });

  test('malformed: missing url → markFailedIfStillPending writes failed', async () => {
    const axiosPost = jest.fn();
    const { event, fs } = makeEvent({
      jobId: 'j_bad',
      data: { status: 'pending', userId: 'u1' /* url missing */ },
      time: new Date().toISOString(),
    });
    const handler = buildHandler({ axiosPost })(fs);

    await handler(event);
    expect(axiosPost).not.toHaveBeenCalled();
    expect(fs.read('j_bad').status).toBe('failed');
    expect(fs.read('j_bad').error).toBe('malformed_pending_doc');
  });

  test('malformed: missing userId → markFailedIfStillPending writes failed', async () => {
    const axiosPost = jest.fn();
    const { event, fs } = makeEvent({
      jobId: 'j_bad2',
      data: { status: 'pending', url: 'https://x/' /* userId missing */ },
      time: new Date().toISOString(),
    });
    const handler = buildHandler({ axiosPost })(fs);

    await handler(event);
    expect(axiosPost).not.toHaveBeenCalled();
    expect(fs.read('j_bad2').status).toBe('failed');
  });

  test('age cap: event.time > 30 min old → mark failed, no throw, no POST', async () => {
    const axiosPost = jest.fn();
    const oldTime = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const { event, fs } = makeEvent({
      jobId: 'j_old',
      data: { status: 'pending', userId: 'u1', url: 'https://x/' },
      time: oldTime,
    });
    const handler = buildHandler({ axiosPost, maxAgeMs: 30 * 60 * 1000 })(fs);

    await expect(handler(event)).resolves.toBeNull();
    expect(axiosPost).not.toHaveBeenCalled();
    expect(fs.read('j_old').status).toBe('failed');
    expect(fs.read('j_old').error).toBe('cloud_function_max_retry_exceeded');
  });

  test('happy path: pending doc → POST /enrich with admin header + payload from stored doc', async () => {
    const axiosPost = jest.fn().mockResolvedValue({ status: 202, data: { jobId: 'j_ok', status: 'processing' } });
    const { event, fs } = makeEvent({
      jobId: 'j_ok',
      data: {
        status: 'pending', userId: 'u1', url: 'https://insta/p/x/', captionText: 'caption',
      },
      time: new Date().toISOString(),
    });
    const handler = buildHandler({ axiosPost, getAdminToken: () => 'secret-token' })(fs);

    const result = await handler(event);
    expect(result).toBeNull();
    expect(axiosPost).toHaveBeenCalledTimes(1);
    const [url, body, opts] = axiosPost.mock.calls[0];
    expect(url).toBe('https://example.test/enrich');
    expect(body).toEqual({
      jobId: 'j_ok',
      url: 'https://insta/p/x/',
      userId: 'u1',
      captionText: 'caption',
    });
    expect(opts.headers['X-Admin-Token']).toBe('secret-token');
    expect(opts.timeout).toBe(90000);
    // Doc untouched (the SERVER's /enrich handler advances it; our function doesn't).
    expect(fs.read('j_ok').status).toBe('pending');
  });

  test('200 from /enrich (already-terminal job) → no-op success', async () => {
    const axiosPost = jest.fn().mockResolvedValue({ status: 200, data: { jobId: 'j_dup', status: 'complete' } });
    const { event, fs } = makeEvent({
      jobId: 'j_dup',
      data: { status: 'pending', userId: 'u1', url: 'https://x/' },
      time: new Date().toISOString(),
    });
    const handler = buildHandler({ axiosPost })(fs);

    const result = await handler(event);
    expect(result).toBeNull();
    expect(axiosPost).toHaveBeenCalledTimes(1);
  });

  test('4xx from /enrich → mark failed + return null (no throw)', async () => {
    const axiosPost = jest.fn().mockResolvedValue({ status: 403, data: { error: 'forbidden' } });
    const { event, fs } = makeEvent({
      jobId: 'j_403',
      data: { status: 'pending', userId: 'u1', url: 'https://x/' },
      time: new Date().toISOString(),
    });
    const handler = buildHandler({ axiosPost })(fs);

    const result = await handler(event);
    expect(result).toBeNull();
    expect(fs.read('j_403').status).toBe('failed');
    expect(fs.read('j_403').error).toBe('enrich_http_403');
  });

  test('5xx from /enrich → throws (Firebase retries)', async () => {
    const axiosPost = jest.fn().mockResolvedValue({ status: 502, data: 'bad gateway' });
    const { event, fs } = makeEvent({
      jobId: 'j_502',
      data: { status: 'pending', userId: 'u1', url: 'https://x/' },
      time: new Date().toISOString(),
    });
    const handler = buildHandler({ axiosPost })(fs);

    await expect(handler(event)).rejects.toThrow(/502/);
    // Doc NOT marked failed (we want Firebase to retry).
    expect(fs.read('j_502').status).toBe('pending');
  });

  test('axios network error → throws (Firebase retries), doc not marked failed', async () => {
    const axiosPost = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const { event, fs } = makeEvent({
      jobId: 'j_net',
      data: { status: 'pending', userId: 'u1', url: 'https://x/' },
      time: new Date().toISOString(),
    });
    const handler = buildHandler({ axiosPost })(fs);

    await expect(handler(event)).rejects.toThrow(/ECONNREFUSED/);
    expect(fs.read('j_net').status).toBe('pending');
  });
});

describe('markFailedIfStillPending guard (Codex P1 from §2.4a)', () => {
  test('does NOT clobber doc that was already advanced to processing', async () => {
    // Construct an event for a doc that's STILL pending when the handler fires
    // (e.g. it's a 4xx return path), but a concurrent actor advanced it
    // between the axios call and the txn read.
    const { event, fs } = makeEvent({
      jobId: 'j_race',
      data: { status: 'pending', userId: 'u1', url: 'https://x/' },
      time: new Date().toISOString(),
    });

    // Hook: between the axios POST returning 4xx and the txn writing failed,
    // simulate a concurrent actor flipping the doc to processing.
    let postCalled = false;
    const axiosPost = jest.fn().mockImplementation(async () => {
      postCalled = true;
      // Simulate concurrent actor advancing the doc (e.g. a legacy direct
      // POST claim transitioned pending → processing).
      const cur = fs.read('j_race');
      fs.seed('j_race', { ...cur, status: 'processing' });
      return { status: 400, data: { error: 'bad request' } };
    });

    const handler = buildHandler({ axiosPost })(fs);
    await handler(event);

    expect(postCalled).toBe(true);
    // The doc should NOT have been clobbered back to 'failed' — the CAS
    // guard saw it's no longer 'pending' and skipped the write.
    expect(fs.read('j_race').status).toBe('processing');
  });

  test('does nothing if doc is deleted between check and txn', async () => {
    const { event, fs } = makeEvent({
      jobId: 'j_gone',
      data: { status: 'pending', userId: 'u1', url: 'https://x/' },
      time: new Date().toISOString(),
    });

    const axiosPost = jest.fn().mockImplementation(async () => {
      fs.delete('j_gone');
      return { status: 400, data: {} };
    });

    const handler = buildHandler({ axiosPost })(fs);
    await handler(event); // should not throw

    expect(fs.read('j_gone')).toBeNull();
  });

  test('writes failed normally when doc is still pending at txn time', async () => {
    const axiosPost = jest.fn().mockResolvedValue({ status: 400, data: {} });
    const { event, fs } = makeEvent({
      jobId: 'j_normal_fail',
      data: { status: 'pending', userId: 'u1', url: 'https://x/' },
      time: new Date().toISOString(),
    });
    const handler = buildHandler({ axiosPost })(fs);

    await handler(event);
    expect(fs.read('j_normal_fail').status).toBe('failed');
    expect(fs.read('j_normal_fail').error).toBe('enrich_http_400');
  });
});

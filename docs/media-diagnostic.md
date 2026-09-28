# One-use operator media diagnostic

Review-only implementation. Deployment, live ticket creation/invocation and any
pilot enablement are separate operator decisions. This route does not alter the
media rollout, admission policy, pins, user records or enrichment jobs.

## Ticket and invocation contract

An administrator creates `engineMediaDiagnostics/<32 lowercase hex characters>`
using Firestore Admin **create**, not set/upsert. This root collection is private
by default: the app rules have no match allowing clients to access it. Its
documents have no client-writable subcollections. Do not add a client rule or
mint endpoint. Confirm that the deployed rules match that default-deny contract
before a live run; mocked server tests do not establish deployed rule state.

```js
{
  schemaVersion: 1,
  status: 'pending',
  tokenHash: '<SHA-256 hex of the UTF-8 secret token>',
  userId: '<exact operator-authorized account UID>',
  url: 'https://www.instagram.com/reel/EXAMPLE/',
  createdAtMs: 1790000000000, // replace with current epoch milliseconds
  expiresAtMs: 1790000900000 // <= 15 minutes after creation
}
```

Generate the token with `randomBytes(32).toString('hex')`; generate the document
ID with `randomBytes(16).toString('hex')`. The secret is 256 bits, remains local,
and never enters Firestore, query strings, command arguments or printed output.
Only its SHA-256 hash is stored. The UID and source URL come exclusively from
the private ticket, never from HTTP headers or a request body.

POST `/internal/media-diagnostics/<ticketId>` with
`x-media-diagnostic-token: <local secret>`, **no body and no query parameters**.
The supplied helper sends the header in memory. Do not use a command with the
secret pasted into its arguments or enable HTTP header/debug logging.

A committed transaction changes pending to running, adding `claimId`,
`claimedAtMs`, and `deadlineMs` (earlier of ticket expiry or 120 seconds). This
claim is irreversible. The HTTP response is normally 202 with only
`{status:'running', executionExpired:false}`. Concurrent callers and replays
read existing state; they cannot schedule another execution. Missing/malformed
credentials return sanitized 401; unknown tickets and wrong tokens return the
same sanitized 404. No result, owner, URL, error message or credential is sent
over this endpoint. The route has a 1 KiB parser limit, rejects any nonempty
body, and limits requests to 6/IP/minute and 12/process/minute.

## Local operator helper

Use the existing approved Firebase CLI OAuth helper, **not** the server's
service account or provider keys. `scripts/media-diagnostic-operator.js` accepts
an authenticated Admin Firestore handle programmatically. Its CLI adapter
expects the existing helper (or a tiny local wrapper) to export
`getFirestore({projectId})`, returning that handle. Adapt the existing helper's
return shape locally if needed; no OAuth token needs to be printed, copied to
an environment variable, or added to this repository. This sidecar did not
inspect or execute the auth helper.

The following are templates, not commands that were run. Replace the helper
path/project/account/source/server with the approved values. Use a private
local directory; the helper creates each output exclusively with mode 0600.

```sh
node scripts/media-diagnostic-operator.js create \
  --auth-helper /absolute/path/to/existing-oauth-adapter.cjs \
  --project APPROVED_PROJECT --user APPROVED_UID \
  --url https://www.instagram.com/reel/EXAMPLE/ \
  --server https://APPROVED_SERVER \
  --file /private/tmp/operator-private/media-ticket.json

node scripts/media-diagnostic-operator.js invoke \
  --file /private/tmp/operator-private/media-ticket.json

node scripts/media-diagnostic-operator.js read \
  --auth-helper /absolute/path/to/existing-oauth-adapter.cjs \
  --project APPROVED_PROJECT \
  --file /private/tmp/operator-private/media-ticket.json \
  --output /private/tmp/operator-private/media-result.json
```

Programmatic use with the already-authenticated handle avoids an adapter:

```js
const {createTicket, invokeOnce, readResult} = require('./scripts/media-diagnostic-operator');
// db is supplied by the existing local OAuth helper; it never leaves memory.
await createTicket({db, userId:approvedUid, url:approvedUrl, server:approvedOrigin, file:privateTicketFile});
await invokeOnce({file:privateTicketFile});
// Later, inspect once with Admin SDK. Choose a fresh private output filename.
await readResult({db, file:privateTicketFile, output:privateResultFile});
```

The invocation helper writes an exclusive `.invoked` marker before the HTTP
call and never follows redirects or retries. Keep that marker even if the
response is lost. On a create error, the local secret file is retained because
the Firestore create might have committed. Inspect through Admin SDK; do not
overwrite/recreate a ticket. Do not copy ticket files into task logs or uploads.

## Execution and interpretation

Only `extractPublicPost` and `collectVideoEvidence` run, with an explicit schema
2 media/language feature snapshot, the ticket UID and a distinct attempt ID.
There is no job ID, job lease, admission, enrichment, place matching or save
entrypoint. Existing source/media/provider/FFmpeg bounds, shared-operation
fences, cooldowns and observation-only accounting remain in force. There are
no monetary caps or retry-generation inputs. Anthropic media calls retain
`maxRetries:0`; transcription uses one fetch per chunk. A source/subtitle 429,
block or timeout prevents diagnostic media discovery/fallback.

The live `engineControl/mediaExecution` control is checked at claim, before
source/media work, during shared-provider authorization and at publication.
Missing control means enabled, matching the existing execution contract;
malformed or stopped control fails closed. Pending tickets observed while
stopped become permanently stopped. To revoke a running ticket, an operator
can set its status to `stopped`; new provider dispatches then fail authorization.
An already dispatched provider request cannot be undone, and remote shared
subscribers with independent authority can finish their own work.

The private document receives `result` and `finishedAtMs`, with terminal status
`completed`, `partial`, `failed`, `stopped`, or `timed_out`. Results include
bounded candidate name/geography/source fields, modality coverage/intervals
(stored as `{startMs,endMs}` objects, not nested arrays),
allowlisted error codes and existing sanitized call/usage/time metrics. They
exclude evidence quotes, transcripts, frames, signed URLs, raw exceptions and
retry tokens. These are **unverified candidates**, not saved/verified places.
Accounting is observational and may be incomplete until background writes
settle; unknown usage or prices are not evidence of zero cost.

Existing production source/evidence caches and private shared-operation/
accounting stores are still used. A diagnostic may reuse cached/subtitle
evidence and therefore make zero new audio/vision calls: check coverage and
physical-call metrics before claiming that live audio/video was exercised.
There is deliberately no cache-bypass or forced redispatch switch. The new
ticket report itself does not duplicate raw evidence from those stores.

## Failure boundaries and review

- A crash after claim (even before invocation), lost commit acknowledgement or
  failed result write can leave `running` permanently. After the fixed deadline
  HTTP/Admin reads can identify it as expired. There is no reclaim, renewal,
  sweep or automatic retry. Do not reset status or delete/recreate its marker.
- Timeout aborts the diagnostic subscription and rejects late source results.
  Existing source child processes also have their own deadlines. Already-sent
  work and background accounting may finish; the token never authorizes another
  coordinator execution. Partial places returned by the coordinator survive a
  subsequent stop. A hard timeout/crash cannot recover in-memory partials.
- The limiter is per process; the Firestore transaction is the fleet-wide
  at-most-once fence. A ticket authorizes one coordinator run, which can contain
  multiple bounded chunks/frame batches/fusion calls. It does not promise one
  provider request total or exactly-once delivery.
- The server tests use fake Firestore and mocked paid adapters. They cover
  authentication spoofing, claim races across independent routers, replay,
  expiry, uncertain commit, deadlines, stop/revocation, partial outputs, source
  429 and sanitized reports. They do not validate live keys, installed FFmpeg,
  deployed Firestore rules or Render networking.

No provider credentials are loaded/exported by the local helper. No production
call, browser action, deployment, account pilot or public rollout is part of
this implementation/review.

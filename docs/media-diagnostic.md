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
  schemaVersion: 2, // remote audio-only ticket; use 1 with no analysisMode for default audio+video
  status: 'pending',
  tokenHash: '<SHA-256 hex of the UTF-8 secret token>',
  userId: '<exact operator-authorized account UID>',
  url: 'https://www.instagram.com/reel/EXAMPLE/',
  analysisMode: 'audio-only', // required for remote schemaVersion 2
  createdAtMs: 1790000000000, // replace with current epoch milliseconds
  expiresAtMs: 1790000900000 // <= 15 minutes after creation
}
```

Generate the token with `randomBytes(32).toString('hex')`; generate the document
ID with `randomBytes(16).toString('hex')`. The secret is 256 bits, remains local,
and never enters Firestore, query strings, command arguments or printed output.
Only its SHA-256 hash is stored. The UID and source URL come exclusively from
the private ticket, never from HTTP headers or a request body. The optional
`analysisMode` also comes exclusively from that trusted ticket. Its only
accepted explicit value is the exact string `audio-only`; null, empty strings,
other modes and non-string values fail validation at both helper creation and
server claim. Programmatic callers must omit the field rather than pass
`undefined` for the default behavior. The remote ticket version and mode must
match exactly:

| Remote ticket version | Mode field | Execution policy |
| --- | --- | --- |
| `schemaVersion:1` | No own `analysisMode` field | Original audio+video, `media-v1` |
| `schemaVersion:2` | `analysisMode:'audio-only'` | Audio-only, `media-v2` |

Version 1 with any mode field and version 2 without the exact audio-only mode
are rejected before claim. Existing version 1 tickets without the field keep
their prior behavior, with no mode field added to their policy.

**Upgrade all diagnostic readers before creating or invoking audio-only
tickets.** Older servers accept only remote schema version 1 and therefore
reject version 2 without dispatching work. The version boundary prevents an
old reader from ignoring the new mode and running video. Never encode an
audio-only ticket as version 1, downgrade a version 2 ticket, or remove its
mode to make an old reader accept it. A rejected invocation still consumes the
local `.invoked` marker; an upgrade does not authorize automatic retry. The
existing media stop control remains in force; no separate live mode control
is required.

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
The remote schema version and mode are part of the claimed authority:
changing the version or adding, removing or changing the mode after claim
blocks further work and publication under the old claim. It never resets the
execution fence. Create a separate authorized ticket to select a different
mode; do not edit a consumed ticket.

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
  --analysis-mode audio-only \
  --file /private/tmp/operator-private/media-ticket.json

node scripts/media-diagnostic-operator.js invoke \
  --file /private/tmp/operator-private/media-ticket.json

node scripts/media-diagnostic-operator.js read \
  --auth-helper /absolute/path/to/existing-oauth-adapter.cjs \
  --project APPROVED_PROJECT \
  --file /private/tmp/operator-private/media-ticket.json \
  --output /private/tmp/operator-private/media-result.json
```

`--analysis-mode audio-only` is accepted only by `create`. Omit it to retain the
original audio+video behavior. `invoke` and `read` reject that option, and the
invocation continues to send zero body/query parameters. The local capability
file remains `schemaVersion:1` for both modes and contains only its existing
ID/token/server fields and schema version. This is the local secret format,
separate from the remote ticket version. Editing it or supplying HTTP mode
headers cannot override the trusted ticket.

Programmatic use with the already-authenticated handle avoids an adapter:

```js
const {createTicket, invokeOnce, readResult} = require('./scripts/media-diagnostic-operator');
// db is supplied by the existing local OAuth helper; it never leaves memory.
await createTicket({db, userId:approvedUid, url:approvedUrl, server:approvedOrigin,
  file:privateTicketFile, analysisMode:'audio-only'});
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
For an audio-only ticket, the server selects
`mediaPolicy:{policyVersion:'media-v2', analysisMode:'audio-only'}` when creating
that immutable snapshot; the resulting validated policy is in
`features.media.policy`. Its existing duration, download, workspace, deadline
and concurrency bounds still apply. The collector skips frame selection,
frame encoding and video-vision calls. Audio acquisition/transcription and
text fusion remain enabled; a media container may still be downloaded and
probed, and existing subtitles/caches may avoid new transcription calls.
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

Audio-only results additionally include `analysisMode:'audio-only'`, taken
from the claimed policy rather than collector output. Default reports retain
their prior shape without a mode field. The collector reports visual coverage
as `unavailable` with reason `disabled_by_policy`; this intentional exclusion
does not by itself make audio-only execution partial. Check the report's
`metrics.providerCalls` for zero `video_vision` entries, and check frame
operations/stages for no decoding, selection or encoding work. Audio
transcription and `media_fusion` calls may still be present. Mode and coverage
state the selected policy; observed metrics and adapter tests provide separate
checks of execution. Missing/dropped observations or a missing final report
cannot prove zero physical calls.

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
- Audio-only tests cover strict helper/server mode validation, create-only CLI
  parsing, remote v2 creation, rejection of incompatible version/mode pairs,
  immutable v2 features, schema/mode mutation fences, default compatibility,
  and the real collector with synthetic adapters showing zero frame/vision
  invocations while audio and text fusion still run. Run the focused local
  checks with existing dependencies:
  `./node_modules/.bin/jest --runInBand --runTestsByPath tests/media.diagnostic.test.js tests/media.diagnosticOperator.test.js`.

No provider credentials are loaded/exported by the local helper. No production
call, browser action, deployment, account pilot or public rollout is part of
this implementation/review.

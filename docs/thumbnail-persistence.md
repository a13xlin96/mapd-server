# Thumbnail persistence — rollout and repair

The server now copies supported Instagram, TikTok, and YouTube thumbnails into Firebase Storage during extraction/enrichment. The stored download URL is written into both the pin and its source entry. This prevents saved pins from depending indefinitely on an expiring social-CDN URL. Opening the app never triggers extraction.

## Configuration and deployment order

1. On the existing Render service, set `FIREBASE_STORAGE_BUCKET=mapd-820d4.firebasestorage.app` (the bucket configured by the app).
2. Confirm the existing Firebase service account can read and create objects in that bucket. No new client credentials are needed. Keep the bucket's existing access rules; do not make it public.
3. Deploy this server commit, then the matching app branch `fix/onboarding-thumbnails`.
4. Save a new social link. Verify `pins/{id}.ogImage` and the matching `sources[].ogImage` contain a `firebasestorage.googleapis.com` URL, and that the image opens.
5. Install the Android preview, force-stop/reopen, and confirm the image still loads. This native/live-storage check has not been performed locally.

Tokenized download URLs allow anyone possessing that URL to read the object. They do not expire automatically; deleting the object or revoking its token invalidates them. No global Storage rules relaxation is part of this change.

## Safe defaults

- Download only from explicitly allowed HTTPS social-image CDN hosts. Validate and pin public DNS answers; validate every redirect. Reject credentials, custom ports, private network addresses, oversized downloads (>5 MiB), and non-JPEG/PNG/WebP data. DNS and each network request are time-bounded.
- Reuse stored objects by content identity. Concurrent uploads keep the winning token, rather than invalidating already-saved URLs.
- `/thumbnails/persist` requires the existing authentication and rate-limiting middleware. Client-supplied image/source pairs are cached in a per-user namespace; they cannot seed the shared server-extracted cache. Historical pin images use the same separation during repair.
- If fetching or Storage fails, saving the place still works with the original image URL. Monitor the sanitized `Thumbnail persistence unavailable` warnings. Such images may still need a later repair.
- Unsupported image hosts keep their existing URL. Places saved without any image get a client placeholder; this does not introduce Google Places Photo requests or billing.

## One-time repair of existing pins

Use the server environment's existing `FIREBASE_SERVICE_ACCOUNT_JSON` and `FIREBASE_STORAGE_BUCKET`. Do not put credentials in command arguments or commit them. Start with a specific account, identified by its Firebase Authentication UID:

```sh
node scripts/backfill-thumbnails.js --user YOUR_UID --limit 20
```

This is read-only: it prints counts of examined pins, pins with candidate images, unique source URLs, and a pagination cursor. It does not extract or upload images.

After reviewing that batch, apply the same scope:

```sh
node scripts/backfill-thumbnails.js --user YOUR_UID --limit 20 --apply
```

To continue, supply the previous output's `nextAfter` value:

```sh
node scripts/backfill-thumbnails.js --user YOUR_UID --limit 20 --after LAST_PIN_ID --apply
```

The script is bounded to 1–1,000 pins, defaults to 100, runs sequentially, and pauses between pins. It first tries the stored CDN URL; if expired, it runs the existing extractor once per source per run, with no AI or Places calls. It merges only unchanged image fields into a fresh transaction, preserving links added/removed during extraction. It changes thumbnail fields only, and deletes no pins or telemetry. A failed/unavailable original post may remain unrepaired. Restart the app after repair to refresh session-cached shared-list covers.

## Verification (2026-09-06)

- Server: 544 tests / 44 suites passing, including actual enrichment writes, caller cache isolation, concurrent uploads, private-address/redirect rejection, byte validation/size limits, and repair concurrency.
- Real downloader: public YouTube sample returned JPEG bytes successfully (no Storage upload).
- Matching app: 644 tests / 50 suites, TypeScript check and Android export passed. Actual collage/source components inspected in a browser with sample images and deliberate image failures.
- Production deployment, Storage permissions/upload, historical repair, and physical Android testing remain rollout steps. No production data was modified during this implementation.

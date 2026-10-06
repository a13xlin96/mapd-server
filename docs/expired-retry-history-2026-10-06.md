# Ordinary retry recovery when old processing history is absent

An explicit Retry can point to a failed queue-admission receipt whose original
job no longer exists. The current reader walks the validated admission receipt,
then reports `invalid_response` before extraction or audio starts. A missing
direct parent already starts fresh, so inserting an unstarted admission receipt
must not make the same ordinary Retry permanently unreadable.

The reader now uses the existing fresh-analysis fallback when it reaches an
absent ancestor after only owner- and exact-URL-validated, unstarted admission
receipts. It does not infer selected identities, prior outcomes, or media retry
tokens from the missing record. Existing per-place deduplication and confirmation
rules apply to the new analysis. Lost selection/dismissal history cannot be
reconstructed; extant authoritative result fields still stop traversal.

Analysis-only retries retain their recovery-authority requirement. Read errors,
owner/URL mismatches, cycles, malformed IDs, active ancestors and overlong chains
still fail. This change neither schedules a retry nor updates historical jobs,
saved pins, rollout flags, credentials or provider settings.

Validation: the new missing-history cases reproduced the production failure
before the fix; all 88 focused retry tests passed after it. The root suite passed
2,875 tests across 140 suites, with 34 tests / three suites skipped. All 32 offline
regression scenarios passed. The integration regression reanalyzes through the
media path, requires selection, and retains one pin after confirming an existing
place. Local adversarial checks cover identity boundaries, missing versus
unreadable ancestors, paid-operation authority and preserved result fields.

An attempted independent reviewer was blocked by automatic approval review over
private-source export, so no independent-review approval is claimed. Hosted CI
and deployment remain separate from these local results. These tests do not
establish real-video transcription or location-matching accuracy.

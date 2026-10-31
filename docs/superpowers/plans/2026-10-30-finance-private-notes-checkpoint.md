# Private transaction notes: verified continuation checkpoint

2026-10-31 UTC. Branch task/finance-parity-20261028. Paths are relative to ~/Jarv1s.
Commits and pushes are authorized; no merge, deployment, production data or PR publication.
Main conversation owns further priorities and strict design approval. No new feature was started.

## Capability and current source

Spec a9c3c4fa preceded implementation 6eda0f62. Production 6d9d4904 fixed refresh across
cached months and keeps transaction details mounted when a note edit removes its filtered row.
Approved UX fix d714b555 makes blocked drafts read only, focusable and selectable, with an
explicit reason and recovery action. Initial reads can close or return to details without waiting.
A generation fence ignores late responses across close/reopen, including their finally handlers.
Submitted saves retain close protection: canceling a read does not imply canceling a write.

Last completed Finance source: 54c2adbbf1279ae08e312fe3b750d94771f2c9ff, committed and pushed.
A subsequent type-only textarea annotation fixes the canonical helper error described below;
final-source checks must be rerun before treating the latest branch as fully verified.
Its two follow-up test commits correct hidden-dialog queries under the real host guard and honor
register read backoff. The module app map includes the actual recovery behavior. No migration
or financial calculation changed in these refinements; Finance retains 23 owned tables and 41
additive migrations.

One exact account/id/month read captures the saved note and opaque row version. A dedicated
note-only SQL compare-and-set changes notes and metadata-only activity atomically. It preserves
amount, category, posting, review, splits, links, account balances and reconciliation. Empty
strings preserve explicit clear intent through same-ID sync and linked pending-to-posted handoff.
Whitespace is preserved; over 4,000 UTF-8 bytes, NUL and malformed Unicode are rejected without
shortening the draft. Pending, posted, split, transfer and reconciled owned SQL notes are supported.
KV compatibility and household rows remain read only. No automatic write retry is introduced.

Check saved note retains the draft beside current saved text. If the draft already committed
before response loss, recovery says so and disables redundant Save. All dependent reads are
invalidated, including other cached months; authoritative completed reads fence older requests.
A filtered-out row keeps its editor and returns focus to search. The shared Dialog owns modal
isolation, keyboard containment, scrolling and focus restoration.

## Verification receipts

All gates use scripts/run-gate.sh and an owned disposable pgvector PostgreSQL 17.11 server.
Toolchain: Node 24.19.0 and pnpm 10.6.2. Synthetic financial/auth fixtures only. Real installed
UI, host approval, API, worker and SQL/RLS paths are exercised. Provider and credential ports
are inert synthetic stand-ins; real bank/provider HTTP and CI e2e remain unrun.

Complete Finance passed **237 tests in 20 files, including all 24 installed-browser flows**,
at clean 54c2adbb, receipt /tmp/jarv1s-gate/moss_finance-20261031-001414-MBYx3C.log.
Fingerprint 57884b3d293dd80e72171a7d1744c20134c817f7dfb9525c9c824860d5aedb62.
Tests ran 00:14:49–00:22:22 UTC; duration 452.98 seconds. The runner removed its container.
A real budget.status 429/3-second read backoff was honored; no pattern rejection occurred.

The four-flow installed recovery/regression run passed at clean 54c2adbb:
/tmp/jarv1s-gate/moss_finance-20261031-001150-KUDeIF.log.
It covers a held real initial read, close and restored opener focus, a newer independent SQL
note, reopen, and delivery of the old response during a newer host-confirmed write. Close
protection survives; Escape cancels the host action without mutation and retains the new draft.
Blocked drafts remain enabled/read only, keyboard-select all text, and reject typed replacement.
Edit keyboard focus stays contained. Light/dark/sage desktop and phone captures assert overflow,
fixed actions and visible recovery/comparison text. The run honored a real note-read 429/6-second
backoff. Four passed and twenty were intentionally excluded, not a complete Finance verdict.

Earlier complete Finance at clean 6d9d4904 passed 237 tests in 20 files, all 24 installed flows:
/tmp/jarv1s-gate/moss_finance-20261030-233452-WE53Bh.log,
fingerprint 1eab72b6205cd7e76c555eb38b7c40ce788a8f64a674e4ebb41277a6cb9e579a.
It does not by itself verify the later approved UI changes.

Canonical aggregate at clean 54c2adbb stopped with rc=2 during integration-test types:
/tmp/jarv1s-gate/moss_finance_transfers_verify-20261031-002241-iNuzM2.log.
Earlier static stages passed. The new keyboard-selection assertion's generic Playwright element
needed an HTMLTextAreaElement annotation for selectionStart/selectionEnd. This is a real added
test-helper type regression, not a baseline-only result. The correction is type-only, preserving
runtime behavior; final complete Finance and canonical aggregate are pending at this checkpoint.
Unit/migration/UAT/integration chained stages were not reached; the initial fresh migration ran.

Baseline reference: /tmp/jarv1s-gate/moss_finance_transfers_verify-20261030-143017-SaB79F.log.
Strip ANSI; collect and trim complete FAIL lines; deduplicate; sort; join with newlines and one
final newline. The 277-identity set SHA-256 is
`dd40a5d54c5f4a990654eb4039f9055a3ecad8a99ada3088d76336ede12a0ba9`.
The completed aggregate at clean 6d9d4904, receipt 234309-xxsWfo, passed all static checks and
reported 277 failed, 19,782 passed and three skipped (21 failed/1,641 passed files). It matched
that full baseline set with no additions or removals. A previous bill-entry manifest-list
regression produced 278 failures at a6a17c7b; 4475cb87 fixed it. Do not mislabel that earlier run
baseline-only. Known baseline failures include Computer IPC/ACL and Sports environment fixtures;
no runtime guard, limit or test was weakened to clear them.

The two focused cache test files passed all three cases. Initial scoped type/lint commands
are supporting development evidence only; the later canonical run exposed the added helper
type error above. A completed command on earlier inputs is not final-source aggregate approval.

## Observed guard-removal controls and restored positives

- Owner isolation: clean 6eda0f62 receipt 224428-I83wZc removed RLS only in the disposable
  fixture and produced four foreign/admin read/write failures, nine passes. Restored receipt
  224509-Dup6ss passed all thirteen. Both fingerprints were
  af9ba5b0f5167db64820149ec8e1b0b08801a1ceeae2bad06793bbc883ae4fca.
- Mandatory confirmation: clean a9936648 receipt 230030-fDjiN2 installed a valid disposable
  auto/drafting manifest. The note and version changed before approval: one failed, one passed,
  twenty-two skipped. Production policy never changed. Later complete native runs restore approval.
- Metadata-only activity: receipt 231330-8YEXAL ran 589bcf53 plus one temporary dirty SQL-writer
  file adding actual note text to activity JSON. Fingerprint
  7dffab415886b1c8582c618e6005cf6f64ebbd6381412aec44996c3fabea55dc;
  one failed and twelve passed because synthetic note content reached activity params. Exact source
  was restored before clean 8292b50c receipt 231452-KJ3Sti passed thirteen, fingerprint
  a4b1cc2619781c1911881d1fbbd2f5b788e98ad06a016871aa99cf6c811a9622.
  Full Finance subsequently includes the restored storage/handler cases.

These are scoped, observed properties, not a claim that private notes never reach an owner's
assistant or global data export. The note route persists a key/count input summary; activity
contains IDs and notesChanged, without note text or Undo. Household projections and Finance
CSV exports use explicit allowlists and omit notes. Automatic categorization inputs omit them.

## Failures diagnosed during implementation

Native focus failure 225618-Te87bV exposed a hidden desktop opener after responsive changes;
07975352 resolves the visible row through shared returnFocusRef. Restored 225824-GwnOE8 passed.
Full 230227-qjeelw at 589bcf53 passed 235 and failed two: the harness had not acknowledged the
host uncertainty notice, and completed bill refresh discarded the successful direct read.
Full 231612-Xo9U1x at 8292b50c passed 236 and failed one: another cached month retained stale
financial review data. Actual red cache tests preceded fixes; 6d9d4904 restored 237/237.

New UX development receipt 000618-5JNYXJ at d714b555 passed three selected flows and failed
one because the host correctly hides the underlying dialog from role queries. The assertion
now inspects its unique close button directly. Receipt 000857-plKrwu at 9805ea7b also passed
three and failed one: a real register 429 was followed by a blind opener click. The helper now
waits the displayed bounded interval and explicitly retries the read. It never retries writes
or increases rate/pattern limits. Restored selected receipt 001150-KUDeIF passed all four.

## UI evidence and strict review boundary

[Twelve inspected original screenshots and exact state descriptions](../evidence/finance-private-notes-2026-10-31/README.md)
record the approved fixes at clean 54c2adbb. They are byte-for-byte originals from the passing
four-flow receipt; complete Finance subsequently passed on that same source. The earlier
[baseline originals](../evidence/finance-private-notes-2026-10-30/README.md) preserve before-fix
provenance and broader bill/budget/accounts/reports review states.

These scoped corrections do not close the overall design review. Main conversation still owns
hierarchy, density, typography, colors/contrast, mobile scrolling, empty/error/recovery states,
confirmation clarity and keyboard approval across the whole product. Existing phone budget
length/category density and crowded heading transitions remain review items, not silently fixed
or declared acceptable. Source-token contrast analysis is scoped to named role/ground pairs;
it excludes disabled opacity, textures, arbitrary custom palettes and full interactive states.

## Next priorities for main conversation

1. Finish strict product-wide desktop/phone design review using original screenshots and actual
   interactions; choose any further scoped changes before calling this work closed.
2. Reviewed non-transfer manual-entry correction and merchant/date edits, preserving statement,
   card, bill and split links. Current inverse transfers are a narrower correction capability.
3. Future/whole-series recurring occurrence management and early entry; calendar and detection
   remain gaps. Recording a due manual expense does not establish provider Bill Sync.
4. Compound/ordered/retroactive rules, bulk notes, tags and attachments.
5. Provider reconciliation/import and large histories require separately authorized provider
   acceptance; household access remains read-only mirrors, and holdings/performance are missing.

All broad Partial classifications remain in the [evidence-linked parity matrix](../specs/2026-10-28-finance-parity.md).
No new feature should start before main selects the next slice. The original checkout is preserved.

Release note draft: Added — Edit private transaction notes. Save or clear a note from transaction
details with confirmation, keeping amounts and reconciliation unchanged and preserving copyable
drafts when a save needs checking.

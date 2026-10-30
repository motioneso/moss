# Reviewed transaction metadata

Authorized continuation of Finance parity on the isolated task branch, extending #1144/#1147.
Commit/push only; no PR publication, merge, deployment, real credentials or live financial action.

[Monarch editing](https://help.monarch.com/hc/en-us/articles/360048393532-Editing-Transactions),
[Monarch rules](https://help.monarch.com/hc/en-us/articles/360048393372-Transaction-Rules), and
[YNAB approval/matching](https://support.ynab.com/en_us/approving-and-matching-transactions-a-guide-ByYNZaQ1i),
read October 30, distinguish correcting categorization/context from importing financial facts.
Moss's captured bulk path already updates metadata only. Legacy individual/chat/queue paths still
read a whole record and call a general upsert. A provider sync can also hold an older user-metadata
snapshot. Those are correctness gaps, even when a queue accepts the request successfully.

## Backend contract

Add an optional SQL metadata capability, retaining the old KV compatibility path. SQL transaction
reads carry opaque row revisions; these are change detectors, not authorization. A single statement
locks one to 200 distinct owned rows in ID order, rechecks captured revisions and live category
references, then updates category/provenance/review and only explicitly supplied notes. Metadata
and identifier-only activity commit all or none. No amount, currency, account, date, pending state,
clearing, reconciliation, split, balance or opening field is rewritten. Linked transfer legs and splits
are refused. Pending records may retain their existing individual metadata-edit behavior; changing
their financial facts remains a separate provider operation. Notes stay off job payloads and activity.

Route SQL chat and legacy category/review jobs through that capability, avoiding duplicate logs.
Category-only requests preserve the current note. Explicit empty notes clear it. Metadata edits remain
possible after reconciliation because they do not alter statement money. Stale rows reject a batch
without partial changes. Existing job envelopes/metadata and authorization families remain intact.
Queue acceptance is still not proof of persistence; do not call the legacy UI awaited or ordered.

Separate provider-window upsert behavior from the legacy/general seed upsert. A stale provider-window
snapshot must not erase the current user category or current notes while legitimate provider money,
date and posting changes still land. Preserve current user provenance and request review when its
amount/currency changes. Skip rewriting manual rows during provider-window persistence. Preserve
existing split protections. Test both orders of the edit/import race. Pending-to-posted replacement
with different IDs and multiple concurrent sync pages need separate acceptance; do not imply that a
same-ID fix proves every provider convergence property or live bank coverage.

No new financial schema is needed: existing rows, metadata and system revisions are sufficient.

## Native individual review

For owned posted unsplit non-transfer records with captured SQL references, changing an individual
confirmed category opens a native captured review and uses the existing always-confirm atomic
category tool. Reuse the bulk review implementation where practical; support singular language,
exact money/currency/date and before/after category context. Wait for actual persistence before
reporting success. Host cancellation retains the open review. Stale/ambiguous saves block submission
and require checking saved records before a new review. Suppress duplicate submissions immediately.

Retain existing pending/KV compatibility and merchant-rule workflows, with their limitations explicit.
This slice does not replace canonical merchant-rule management, make rule-plus-category writes atomic,
add bulk notes, or claim that every individual review is now synchronous. Keep the app map truthful.
Use shared Park Press primitives, semantic colors, compact responsive layouts and accessible states.

## Acceptance and completion

Use synthetic data. Prove exact financial/clearing/statement preservation, optional-note semantics,
foreign/admin/split/transfer/archive refusal, distinct-row bounds, all-or-none stale batches and held-lock
provider conflicts. Observe the race test fail with its row/version guard removed, restore and prove
green. Observe the stale provider-window test fail before metadata preservation is implemented.

Exercise real installed individual category review: cancel/save, reload, competing financial change,
stale recovery, missing/ambiguous outcomes, desktop/phone/light/dark/Sage inspection. Keep old KV
contracts passing. Run relevant SQL, unit, type/lint/static and aggregate checks on frozen source.
Record exact commit/fingerprint and failures/unrun stages, retain clean commits, push the branch and
continue the remaining matrix. No unit count or one successful slice establishes universal parity.

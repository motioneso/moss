# Finance budget concurrency continuation

Authorized continuation of #1148 and the October 28 parity specification. Work stays in the
isolated checkout; no publication, deployment, credentials or live money movements.

The currency slice introduces an owner-only immutable policy. Next, use that row as a budget
revision gate for ordinary assignments, category moves, draft start and budget undo. Every dependent
assignment, activity row, draft state and undo mark must depend on the same successful gate.
A stale or rejected request must not produce a partial success. Page writes move from optimistic
queue acknowledgements to the existing guarded host tools handle and keep rejected typed input.

A revision alone cannot detect account/transaction changes. Add a bounded opaque fingerprint of
owner-scoped row identities and PostgreSQL row versions for accounts, transactions, snapshots,
assignments and drafts. Capture before and after multi-query derivation and reject an unstable read.
The atomic write checks both the expected budget revision and the same ledger fingerprint against
its statement snapshot. Concurrent budget commits serialize on the policy row; ledger changes
committed before that snapshot invalidate stale funding reviews. A later bank/manual change remains
a later ledger event, not a guarantee that the budget will stay funded forever. This is optimistic
concurrency, not a claim that all Finance writes share one serializable transaction.

Keep explicit previous assignment totals as well: they bind assistant monetary confirmation to
the stored base. Commands without the new review tokens fail with a refresh instruction. Do not
silently upgrade old queued commands to a fresh review. Replays must not overwrite newer edits;
ambiguous responses require checking the saved budget, never an automatic retry.

Draft start currently prepares categories before its atomic totals; review this boundary. Prefer
an explicit SQL taxonomy cutover after currency review, copying existing KV/default categories
without changing their ids. Then draft category creation, totals and status can share one commit.
Do not leave a second authoritative taxonomy or discard existing custom categories. Ordinary
category writes and undo must use the same source. Archived categories with remaining money must
remain visible in budget history. If this extension cannot be completed and tested, retain an
honest partial status instead of claiming full draft atomicity.

Acceptance: stale funds after a manual entry, CSV batch, provider correction or split are rejected;
two competing assignments/moves cannot lose totals; a competing draft edit cannot change a started
budget; undo cannot overwrite a later amount; failed guards do not mark a draft started or an
activity undone. Run installed-owner SQL races, negative controls, confirmed/cancelled browser
flows and narrow plus aggregate checks. Then proceed to targets, recurring bills and flexible
planning on the same currency and revision model.

# Private transaction-note editing

2026-10-30. Continuation of Finance #1147/#1149 on task/finance-parity-20261028.
The user has delegated ordinary product decisions and authorized branch commits/pushes.
No merge, deployment, new issue or PR publication is authorized. Paths are relative to ~/Jarv1s.

## Problem and bounded capability

Transaction details currently show a captured note but cannot change it. Add an explicit
owner-only note editor with a fresh saved-note read, mandatory host confirmation and a
dedicated note-only SQL compare-and-set. An empty string means clear; whitespace is preserved.
Support owned pending, posted, manual, split, linked-transfer and reconciled transactions
without changing any other field. Legacy KV and household records remain read only.

[Monarch's current editing guide](https://help.monarch.com/hc/en-us/articles/360048393532-Editing-Transactions)
documents individual/bulk note editing and pending-to-posted continuity. This slice covers one
note, not merchant/date edits, tags, attachments or bulk notes. Transaction editing remains
Partial in the parity matrix. Provider HTTP acceptance remains a distinct integration gap.

## Interaction and Park Press layout

Keep the current shared scrolling Transaction details Dialog and its captured financial facts.
Edit private note opens a separate shared Dialog after closing the details surface. Read the
current note/version before enabling Save. Show account/date/payee context and concise privacy
copy. A labeled shared Textarea preserves the full valid saved note. Bound input to 4,000 UTF-8
bytes; reject PostgreSQL-incompatible NUL and malformed surrogate sequences without truncation.
Show remaining byte capacity with an accessible validation message. Existing layout classes,
semantic tokens, typography and sticky shared Dialog footer apply in light/dark desktop/phone.

Host cancellation keeps the draft. A conflict or uncertain result blocks further writes until
an explicit Check saved note succeeds. Retain the draft and show the newly read saved note so
the user can intentionally choose whether to overwrite it. Never automatically retry a write.
Honor server read backoff. Close/unmount fences late component results. After success announce
only that a private note was saved, invalidate transaction reads and preserve register filters.

## Storage and privacy contract

Read one exact account/id/month, with md5(id || ':' || xmin) as opaque revision. The SQL writer
compares that version inside the statement and updates only notes. One dependent activity insert
contains transaction/account/month IDs and notesChanged, with no note text or note Undo. A stale,
foreign or absent row changes nothing. A repeated already-completed save with an old version is
a conflict; an unchanged fresh note is a no-op. No schema migration is needed.

Do not reuse category metadata.apply: it confirms categories and refuses splits/transfers.
Explicit empty strings must survive same-ID provider updates and durable pending handoffs.
Follow actual mirror/export/automatic-categorization/job paths before making privacy claims;
do not infer owner privacy from hiding the editor. No notes are added to jobs or household
projections by this feature. The existing owner tool surface still permits the user's own
assistant to read transaction data; this is not a claim that notes never reach an assistant.

## Testable acceptance

- Dedicated SQL/handler cases: text/Unicode/empty preservation, 4,000-byte boundary, invalid input,
  stale revision, wrong account/month, missing row, no-op, concurrent captures, activity redaction,
  unchanged money/classification/splits/links/posting/statement fields and account revision.
- Owner boundary: foreign and admin exact-ID/revision reads/writes cannot access a private note;
  observe the assertions fail with fixture-only RLS removed, then restore and pass.
- Provider regression: same-ID update and durable pending-to-posted replacement preserve edits
  and explicit clear intent. Do not substitute a fake provider network for real bank acceptance.
- Installed native UI: current-note load, edit, host cancel with no mutation, approved save/reload,
  clear, actual intervening write conflict and explicit recovery. Inspect original desktop/phone,
  light/dark screenshots, modal focus/overflow/footer and visible error states. Observe the
  no-write-before-approval assertion fail with a valid disposable confirmation policy removed.
- Run relevant lint/type/static checks and complete Finance checks; record aggregate failures
  against the known unrelated baseline. Do not call unrun acceptance complete.

## Main-conversation design follow-up approved 2026-10-31

Functional acceptance at 6d9d4904 passes all 237 Finance cases; strict design closure remains open.
Two concrete issues are approved for correction before that closure:

- A blocked retained draft must be read only, selectable and keyboard-copyable, with its reason
  and explicit saved-note recovery action. Disabling the textarea prevents useful recovery.
- A pending initial read must allow close/cancel. Ignore or abort its late result, including
  after closing/reopening a different review, and preserve the pending-operation ownership lock.
  A submitted write keeps its existing close protection; cancellation never implies undoing it.

Regression acceptance: exercise keyboard selection of a blocked draft without changing it;
close during an intentionally delayed real read, reopen with a newer saved version, release
the older response and prove it cannot reopen, replace or unlock the newer review. Inspect
desktop/phone and light/dark states, focus return and explicit loading/recovery copy. Run
relevant full checks after the fixes. Main owns broader design decisions; these two corrections
do not establish whole-product design approval.

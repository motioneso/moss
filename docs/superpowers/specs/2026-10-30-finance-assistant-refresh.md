# Refresh Finance after assistant actions without rebasing typed money

Authorized continuation of Finance tasks #1144/#1148. Ben delegates ordinary product and
engineering choices and authorizes committing/pushing the isolated task branch. No published
PR, merge, deployment, production data, credentials, bank connection or real financial action.

## Evidence and intended behavior

The host already supplies an optional numeric refreshKey to external modules. It counts executed
assistant action results that affect the mounted module. Finance Root currently ignores it,
so a completed assistant edit can leave native Finance reads cached until explicit refresh or reload.
Consume changes to that existing host interface, without adding another platform event bus.
Skip the initial key so mounting does not produce a duplicate burst of reads. Refetch mounted
read queries and discard unmounted cached reads through Finance's existing invalidator. Ignore
unchanged keys. Never dispatch a write in response to a refresh signal.

Budget currently keeps typed values separately but uses the newest read's assignment/review tokens
when saving. Once assistant refresh is enabled, that could silently attach an older typed amount
to a new saved budget. Capture the revision/fingerprint identity when the first local amount is
typed. Keep that identity while any amount remains. A changed saved identity preserves all typed
values but disables saving until an explicit successful Check saved records. That check makes the
new saved state the review basis and tells the user to review their typed amounts before saving.
Clearing every typed amount removes the draft identity. Saving one category while other drafts
remain may similarly require a new explicit review. No automatic retry or merge of financial edits.

A known rejected assignment also requires that explicit check, even when a background read already
arrives. Uncertain writes retain their existing explicit-check boundary. Checking disables edits,
saves, month changes and competing planning controls until the new read settles. A failed read
must end the checking state, preserve input and keep the write boundary blocked. Honor Retry-After
for the next explicit read; never relax a production rate limit or retry a financial write.

## Native design

Retain the Park Press Budget hero, dense category rows, inline assignment inputs and existing
Check saved records button. A shared practical Note above the rows explains a changed saved
budget, retained typed amounts and the check needed before saving. Existing inputs remain visible
with their typed values, and Save is disabled during stale/checking states. A successful check
shows the existing concise confirmation to review typed amounts. No extra modal, financial jargon,
new color or custom control is needed. Existing captured target/flexible dialogs keep their review
and server CAS; do not silently replace an open dialog's captured tokens on background refresh.

## Acceptance and limits

- Unit host-contract test: an initial, unchanged or absent refresh key causes no extra invalidation;
  each changed key causes one invalidation. Screens/host props may be explicitly mocked here;
  this is not proof that a configured AI provider completed an actual conversation.
- Native Budget unit tests: type an amount, deliver a new saved snapshot, verify no write can use
  the new tokens without an explicit successful check. Preserve exact typed input; failed/429
  reads retain blocking and permit later explicit recovery after the supplied wait. Rejected and
  ambiguous writes do not automatically retry. Multiple drafts retain the same captured identity.
- Real installed browser: two owned synthetic pages compete; a stale confirmed save is refused,
  typed input survives, Save stays disabled until Check saved records, and subsequent explicit
  review/host confirmation persists against the new saved state. Inspect phone/desktop in light,
  dark and a park theme. No intercepted application response establishes acceptance.
- Run Finance units, lint, formatting, file-size/UI checks, types, installed browser and the safe
  aggregate gate. Record the exact source and distinguish known unrelated baseline failures.

This repairs read freshness and review integrity; it does not add collaborative household editing,
background bank sync, broadcast every native action to other tabs or claim provider-conversation
end-to-end acceptance. Broader parity remains partial in the evidence-linked matrix. Audited manual
transfer corrections remain the following ledger slice.

Provide an explicit Discard typed amounts action when any draft remains, including after a
category becomes ineligible. It clears only unsaved local input and errors; it does not resolve
an uncertain write or authorize another save without the required successful saved-record check.

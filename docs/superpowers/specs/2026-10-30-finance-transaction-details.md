# Readable transaction details

Date: 2026-10-30. Extends Finance #1147 under the existing parity brief and delegated
product decisions. Implementation, isolated commits and branch push are authorized;
publication, deployment, merge and live financial actions remain withheld.

## Purpose and comparison

Moss can search private notes and preserve them through sync, but its native register
cannot open a transaction to read that context. [Monarch transaction details](https://help.monarch.com/hc/en-us/articles/360048393532-Editing-Transactions)
and [notes](https://help.monarch.com/hc/en-us/articles/360056422791-Adding-Notes-and-Attachments-to-a-Transaction)
make transaction context available from the register. This bounded read surface addresses
that usability gap; it does not claim Monarch's merchant/date/note editing, tags or attachments.

## Interaction and data boundary

The transaction payee becomes a keyboard-accessible button in both register layouts.
Open a shared Park Press Dialog with captured payee, exact signed amount/currency, date,
account, category or split allocations, posting/manual statement state and review state.
Private notes appear as selectable, multiline text in a read-only shared Textarea; no note
is truncated. Empty notes say No private note. Household rows explicitly identify the
shared read-only view and omit notes even if a malformed projection contains a notes field.
The dialog describes the row as read when opened; background prop changes cannot silently
replace the captured financial details. Closing returns focus through the shared Dialog.

No new network calls, writes, storage migrations, jobs, export fields or sharing authority.
Existing category/split/transfer actions stay in the register and retain their confirmation
contracts. This slice adds no editing controls or misleading Save affordance.

## Acceptance

Unit tests cover private multiline/markup-like notes as literal text, empty/shared notes,
split/refund amounts, manual/provider status, captured-snapshot stability and zero tool writes.
Observe the shared-note guard test fail with that UI guard removed, then restore it.
Installed browser acceptance opens an actual owned SQL row, checks its preserved private note,
exact fields and unchanged row after closing, and opens a real shared mirror row without notes.
Inspect phone/desktop light/dark/Sage layouts, viewport bounds, modal footer and focus return.
Run Finance units, lint/type/static and full installed/backend checks; record exact aggregate
limits and distinguish historical unrelated failures from new regressions.

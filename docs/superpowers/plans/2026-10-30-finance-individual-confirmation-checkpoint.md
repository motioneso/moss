# Individual confirmation checkpoint — October 30

Branch `task/finance-parity-20261028`; commit/push authorized, no PR publication, merge, deployment,
production changes, real credentials, banks or live financial actions. Synthetic data only.

Design: [individual confirmation](../specs/2026-10-30-finance-individual-confirmation.md).
Status: [parity matrix](../specs/2026-10-28-finance-parity.md).

Owned posted unsplit non-transfer SQL Needs-a-look rows now open a captured individual review when
no merchant rule is requested. An unchanged category uses the existing atomic confirmation tool;
a deliberately changed category uses the captured category writer. The existing host guard still
requires confirmation, and the UI announces success only after actual persistence. User-confirmed
provenance follows the existing database contract. Financial facts, notes, statement state and
balances remain outside these writers. Pending/KV/merchant-rule compatibility remains queued.

The shared review retains captured intent, labels and revisions on background refresh or host
cancellation. Immediate duplicate invocation and dismissal are suppressed. Stale/ambiguous outcomes
block submission until an explicit successful saved-record read. No write is automatically retried.
Singular language distinguishes confirming an existing category from changing it; the authored
Park Press dialog, index and semantic colors supply responsive light/dark/Sage presentation.

## Verification

Development receipts on base `61052249` with dirty input `9a13a8967f64`, Node 24.19.0 / pnpm 10.6.2:

- Installed `070432-AshA31`: one expanded browser flow passed, eighteen skipped, exit 0. Real auth,
  API, installed worker/SQL and host dialog exercised cancellation with byte-for-byte saved-row
  equality, unchanged-category confirmation and reload, deliberate category change, and stale
  rejection after a competing financial edit. No response mocks. The prior complete nineteen-flow
  initialization receipt predates this UI change; a combined full browser run remains required.
- Real SQL `070652-vhGG82`: confirmation suite passed all five cases, exit 0, including captured
  revisions, all-or-none stale/foreign/split/pending/category rejection, reconciled money preservation
  and held-lock conflict. Existing SQL writer and guards were reused without modification.
- Focused affected components/manifest: four files / 31 passed. Complete Finance unit suite:
  67 files / 665 passed. Cancellation, captured intent/revision, immediate duplicate suppression,
  persisted success and uncertain/stale blocking cover both individual intents.
- Scoped lint, root-test types, Finance module types and formatting passed. Final combined-source
  static/foundation and CI e2e have not yet run for this new UI snapshot.

Screenshots `finance-single-confirm-<theme>-<width>.png` cover light/dark/Sage at 320/390/768/1440.
Actual phone dark and desktop light were inspected. No horizontal overflow; the footer stays within
900px height. Screenshots remain outside the repository and contain only synthetic records.

The frozen `61052249` foundation run `070254-PFAraS` finished exit 1: all static checks passed,
19,570 tests passed and the same 277 baseline failure identifiers remained, with no additions or
removals. Later aggregate DB stages were unrun. This predates this UI slice; final combined checks
remain required. See the subsequent [merchant-rules checkpoint](2026-10-30-finance-merchant-rules-checkpoint.md)
for ongoing implementation and verification limits.

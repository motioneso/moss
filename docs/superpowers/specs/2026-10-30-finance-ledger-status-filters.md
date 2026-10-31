# Manual-ledger status filters

Date: 2026-10-30. Extends Finance #1147 and #1148 under the existing parity brief.
User authorization covers reasonable product decisions, implementation and branch push;
no new issue/PR publication, deployment or live financial action is authorized.

## Purpose and evidence

The register currently filters posting state but cannot isolate manual statement states.
[YNAB search/filter documentation](https://support.ynab.com/en_us/searching-transactions-a-guide-r1gxyQryj)
describes cleared/reconciled register filters. Moss already records these states and supports
statement reconciliation. This slice makes existing ledger state searchable without changing it.
It does not implement general YNAB query syntax or provider statement reconciliation.

## Product contract

Add a Manual ledger status selector alongside the existing register filters. Default All
ledger statuses leaves the current scope unchanged. Uncleared means owned manual, posted,
not reconciled, cleared false or absent; Cleared means owned manual, posted, cleared true and
not reconciled; Reconciled means owned manual, posted with a reconciliation timestamp. A
reconciled row never appears in Cleared or Uncleared, including historical inconsistent flags.
Provider rows, pending rows and household mirror rows have no manual statement meaning and
are excluded whenever this selector is active. Posting and ledger states are separate controls;
Pending plus a manual ledger state deliberately yields No matches rather than changing either
choice. The existing owner-only read, month, account/category, direction, search and attention
filters continue to intersect before counts and limits. Clear filters resets the new control;
mobile expansion and active count include it. Loaded CSV follows the visible results.

Use the current Park Press Select, spacing and responsive filter grid; add no colors, new
visual primitives or unrelated layout. Show useful empty/error states and preserve filters on
read failures through the existing register lifecycle. Do not create financial writes, jobs,
new migrations, credentials, automatic retries or new sharing authority.

## Acceptance

- Backend tests distinguish all three states, inconsistent historical flags, legacy false/absent
  clearing flags, provider/pending/shared exclusion and invalid enum rejection.
- Intersect category/account/search/posting and verify counts before a small limit; reads do not
  mutate financial rows or mirrors. Existing unfiltered results are unchanged.
- Component tests exercise the selector, mobile active count and Clear filters.
- Installed browser acceptance uses an actual manually entered cleared record before and after
  actual statement reconciliation. Assert API and rendered matching/empty results, unchanged
  financial rows, mobile expansion and light/dark/Sage at phone/tablet/desktop widths. Capture
  screenshots and inspect representative phone/desktop frames.
- Run Finance units, static/type checks, installed Finance acceptance and aggregate checks.
  Record separate verdicts; synthetic installed acceptance is not real-bank or CI evidence.

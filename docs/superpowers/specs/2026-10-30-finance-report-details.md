# Finance report details

Continuation of the authorized Finance #1150 / #3177 practical-parity work. The isolated branch
may be pushed but must not be merged or deployed. This specification records the delegated product
choice before implementation; use only synthetic financial data for acceptance.

[Monarch's official Reports guide](https://help.monarch.com/hc/en-us/articles/21846787088916-Using-Reports),
updated September 21 and read October 30, 2026, describes opening underlying transactions from
report breakdowns and period summaries. Moss already has currency-separated totals and split-aware
aggregation, but its displayed bars and cash-flow periods cannot explain their underlying rows.
Build a faithful detail view before adding more chart varieties. Saved reports, arbitrary timeframes,
tags, chart export and business accounting remain separate gaps.

## Behavior and interface

A category or payee bar, or a monthly cash-flow income/outflow amount, opens a shared scroll-body
dialog. Capture month, currency, grouping, key and displayed total when opened. Show matching posted
and pending states, each transaction's contribution to the selected metric, and a parent amount when
only a split allocation contributes. Refunds net into expense categories; income allocations stay
separate. Transfer exclusion must be identical to the report, including margin-month and owner
boundaries. Current reports deliberately include pending entries; preserve that disclosed behavior
in this slice rather than silently changing historical totals.

Use a read-only details tool with validated month/currency/group parameters. Refactor report row
loading into one shared helper so aggregation and details cannot drift. Details apply the same
per-owner transfer logic before currency filtering and allocation expansion. Only include the shared
owners that contributed to the rendered report; validate those against authenticated active members
and the viewer's already available shared mirrors. Never fetch another owner's private SQL or notes.
Return explicit allowlisted detail fields, grouped by parent row and owner, not full stored records.
Directory failure keeps the view own-only, matching the existing Reports posture.

Use exact integer contribution totals. Return the full matching count and total separately from a
bounded 200-row detail page; expose a clear loaded count and explicit pagination without fabricating
unloaded rows. Preserve selection while loading/erroring. Reads may occur after a ledger change:
show the displayed report total and the current detail total, and explain any difference rather than
claiming snapshot consistency. No detail operation edits a transaction or changes financial data.

The dialog supports keyboard use, visible title/actions and no horizontal overflow at phone widths.
Use Park Pass typography, semantic colors, rules and tabular numbers. Include useful loading, empty
and failure states, and preserve the captured scope when report filters change in the background.

## Acceptance

- Category/payee and income/outflow details reconcile to the same aggregation for signed refunds,
  income-plus-expense splits, unbalanced splits, pending entries and cross-month transfers.
- Same-valued transactions belonging to different owners never become a transfer pair. Deleted or
  unresolved owners and malicious mirror extra fields cannot enter a detail response.
- Currency is required; USD/EUR details never mix. Calendar validation rejects impossible months.
  Exact totals reject unsafe public integers. Pagination discloses truncation and never changes the
  overall total; malformed offsets/limits and unknown grouping values fail explicitly.
- An installed signed-in report opens real synthetic rows from a category, payee and cash-flow
  period, including an allocation smaller than its parent. Verify desktop/phone/light/dark and
  recorded loading/error behavior. Unit and installed SQL/host checks accompany the browser proof.
- Update the evidence matrix and app map without claiming complete Reports parity. Run focused
  Finance tests, relevant integration gates and repository static/aggregate checks; distinguish
  failures, passes and unrun checks. Keep useful changes committed and pushed, unmerged.

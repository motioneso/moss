# Owned transaction-history export

Continuation of authorized Finance practical parity, isolated task branch only; commit and push,
without merge/deployment. Use synthetic acceptance records. This records the delegated design.

[Monarch's history download guide](https://help.monarch.com/hc/en-us/articles/15526600975764-Downloading-Transaction-or-Account-History),
updated October 20 and read October 30, 2026, describes downloading account or all-account history
and recommends smaller date ranges for large files. Moss currently downloads only loaded register
rows. Add an explicit owned-history workflow without silently changing that existing action.

## Scope and correctness

A new read-only SQL capability reads an inclusive optional date range and optional owned account,
across all stored months, in one SELECT snapshot. Join owned account and category names under RLS;
project only export fields, never credentials, private notes, provider blobs, revision tokens, or
household mirrors. Archived account history remains exportable. Preserve transaction IDs, date,
parent amount, currency, pending/posted status, clearing/reconciliation metadata, category and signed
split allocations. Do not aggregate currencies or infer transfers. Retain parent rows exactly once.

Respect platform query bounds. Return a full matching count with at most 5,000 rows from the same
statement. If there are more rows, refuse the entire CSV and ask for a narrower range/account;
never label a truncated file complete. Reject oversized output before download and retain form input.
An empty range returns a header-only CSV with zero rows. Validate impossible dates and reversed
ranges. One tool call represents records at preparation time, not an ongoing export session; no
cross-page snapshot promise, persisted files, new jobs, migrations or private financial logs.

Use one shared CSV text-escaping helper for loaded and history exports. Quote commas/newlines and
neutralize leading spreadsheet formula/control characters. Format safe integer cents exactly in
separate outflow/inflow columns; split cents must remain exact, with category names and identifiers.
No spreadsheet formula should be created from account/payee/category/ID text.

## UI and acceptance

Add Export history beside Export loaded rows. A scroll-body dialog explains own-only scope, omitted
notes, inclusive optional dates, all-month defaults, and the 5,000-row limit. Offer owned account
selection. Prepare fetches one fresh snapshot only after explicit action; show loading and errors,
then an exact row count, captured filters and preparation timestamp before Download CSV. Editing
filters clears the prepared file. No network write, financial transaction or automatic download.
Cancel closes the dialog. Keep existing loaded export semantics and Moss Park Pass primitives.

Prove >2,000 rows and multi-month/history completeness, same-ID owner isolation, account/date
boundaries, archived/orphan naming, empty/header-only output, parent/split fidelity, pending status,
safe cents, injection escaping, >5,000 and oversized refusal. Installed SQL must exercise real RLS,
including a negative control that fails with protection removed. An installed browser must prepare
and download the actual CSV, verify scope/count/content, retain inputs after failed reads, and work
with keyboard and phone/desktop/light/dark. Update app map, parity matrix and checkpoint; run focused,
installed, static and aggregate checks with precise limitations. Balance-history export, budget/goal
exports, shared-owner export and arbitrary-sized server streaming remain separate gaps.

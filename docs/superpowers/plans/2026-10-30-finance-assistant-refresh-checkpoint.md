# Finance assistant refresh and typed budget review checkpoint

Authorized continuation of #1144/#1148. Design:
[assistant refresh](../specs/2026-10-30-finance-assistant-refresh.md).
Commit/push the isolated branch; no PR publication, merge, deployment, production data,
credentials, live banks or financial action.

## Implemented boundary

The host counts executed action results affecting Finance and passes refreshKey through the
external-module loader to the directly exported Finance Root. Root now consumes changes to that
existing optional key through the existing read cache invalidator. Initial/unchanged/absent keys
cause no extra invalidation. Mounted reads refetch and unmounted cached reads are discarded. No
financial write is dispatched by a signal. The host-prop contract is unit tested with explicitly
mocked screens; this is not a configured-provider conversation acceptance claim.

Typed category amounts retain their original month/revision/fingerprint identity until all are
saved or cleared. A new saved identity keeps the text and blocks Save until an explicit successful
Check saved records accepts the current basis for another user review. Saving one category while
another remains typed likewise requires checking its new budget before the other can save. Known
rejections and uncertain writes require a successful explicit check, even when a background read
arrives. No financial write retries automatically.

Checks disable editing/competing planning controls while pending. Failed reads end Refreshing,
preserve typed amounts and the write block, and allow a later explicit check. Read cooldowns use
the supplied Retry-After; no polling or limit changes. Discard typed amounts clears local text and
errors only, preserving any uncertain-write block. Open target and flexible-mode dialogs keep their
captured snapshots rather than rebasing. Existing shared Park Press controls and practical Note
explain the workflow. The controls use the existing wrapping layout at phone widths; no CSS or
platform confirmation contract changed. App-map facts stay within the existing 16-feature limit.

## Verification and development failures

Node 24.19.0 / pnpm 10.6.2, synthetic records and disposable gate databases only:

- Four new regression assertions failed against the old Root/Budget: ignored refresh, silently
  reusable new review after background read, stuck failed check and missing local discard. Restored
  focused pair passed 16 cases, then 18 with multiple-draft and read cooldown coverage. Neither
  cooldown expiry nor discard retries or resolves a write. Complete Finance suite passed 74 files /
  717 cases after metadata correction; final tiny read/layout fixes passed the focused 18 again.
- First wider units failed two manifest checks because a seventeenth app-map feature exceeded the
  existing ABI limit. Integration `113443-TMd2ky`, input `e0858fa205ae`, therefore could not discover
  Finance (404) and exercised no browser cases. Fixed by updating the existing budget feature,
  without raising platform limits. A new test's act callback return type was also corrected.
- Scoped lint, full pnpm typecheck (root, root tests, web and three external modules), whole-repo
  formatting, file-size and UI-class checks passed. Final module/root-test type checks additionally
  cover the last read recovery helper and wrapping changes. No file crosses the 1,000-line limit.
- Focused `113644-rMn6IC`, input `e68de12145d3`, failed an actual 320px page overflow assertion after
  adding the discard action. Repaired the product's action row using existing fnm-spread wrapping;
  no bounds assertion or viewport was relaxed.
- The preceding committed repair `af55cb11`, clean input `7a9257d5ce9b`, passed four SQL files /
  22 cases (`113149-ZTjMan`). Its full browser `113147-nqwC4B` passed 20 / failed one: reporting now
  completed, while target funding encountered a real busy budget read after metadata save. The
  screenshot discloses Wait 20 seconds. The fixture follows the actual explicit saved-read path
  after the displayed wait, without intercepting responses or retrying financial writes.

The earlier report selection wait (`112421-QYkvGW`) is not labeled an established baseline
failure. Its follow-up test now captures the competing register's real read status, honors one
bounded Retry-After through Retry register and preserves bounded DOM/screenshot evidence on any
failure. Passing the next report flow supports recovery; it does not prove which earlier request
was busy when no competing-page response was retained.

Full development `113941-Zh2diX`, base `af55cb11`, input `8396ac6751cf`, passed 20 / failed one,
exit 1. The stale-budget flow passed at all phone/desktop/theme bounds, kept its typed 500.00,
refused the competing saved review, required Check saved records, then explicitly confirmed 500.00
and reset the canonical assignment. Target repair, reporting and all remaining flows passed. The
one failure was the target-funding fixture expecting successful explicit-read text after a real 429. Actual UI ended Refreshing, preserved blocking and disclosed Wait 19 seconds. The final
fixture now observes that response, honors its supplied wait, checks again explicitly once and
asserts success. No response interception, financial retry or limit/timeout relaxation occurred.
Clean committed full browser and aggregate checks of that final fixture remain next; do not report
this development suite green. Screenshots finance-budget-stale-<theme>-<width>.png show the repaired
wrapping controls; phone light and desktop dark were inspected, with executable bounds for all.

The host refresh signal itself has source-traced wiring and the explicitly mocked Root contract;
a configured AI-provider conversation remains unrun. This does not establish household co-editing
or broadcast every native save to other tabs. Preserve the matrix's partial classifications.
Next: an audited inverse linked manual transfer, retaining original history/reconciliation and
existing currency/date/owner/confirmation contracts, then additional target/provider/report slices.

## Subsequent complete regression

The correction slice's final development `121146-YK8dO1`, input `7ede71517338`, passed every
installed flow, including target-funding busy-read recovery, stale-budget explicit checking,
reporting and the instrumented category-confirmation flow. Its complete backend `121148-bsvbuD`
passed 150 cases. See the [correction checkpoint](2026-10-30-finance-transfer-corrections-checkpoint.md)
for source boundaries, the clean refresh aggregate's missing browser prerequisite and the restored
13 browser-harness cases. Do not describe the earlier failed aggregate itself as a pass.

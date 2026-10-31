# Finance target funding checkpoint

Authorized continuation of #1144/#1148. Design and official sources:
[target funding](../specs/2026-10-30-finance-target-funding.md).
The isolated task branch may be committed and pushed. No PR publication, merge,
deployment, production data, credentials, banks or live financial action is authorized.

## Implemented boundary

Category targets offers explicit selected-target funding from the current saved budget.
Choose one to twenty eligible suggestions, review each assigned total before/after and
ready money remaining, then confirm through the actual host. No hidden priority, partial
winner, withdrawal from another category, bank movement or automatic funding occurs.
Monthly targets count remaining contribution; dated targets divide remaining balance over
inclusive months left. Dated suggestions recalculate as saving/spending changes; these
are not persisted monthly installments. Earlier target versions remain unchanged.

The server recomputes and compares captured amounts, enforces the current Moss-local
month, positive ready money, live category and flexible-pool boundaries, and commits
assignment totals with existing activity/Undo facts through the atomic budget-change
store and revision/fingerprint CAS. No extra allocation ledger or migration was added.
Unsafe or out-of-bound totals are disclosed rather than clamped. Reached, archived and
pooled targets remain visible as unavailable suggestions. Current category overspending
must be covered first; this bounded workflow does not implement automatic overspending
priorities or change existing net-debt/card or rollover policy.

Native review keeps an immutable snapshot through host cancellation. Stale/uncertain
writes block until an explicit successful saved-record check. Immediate locks suppress
duplicate submission and dismissal before React paints. After successful metadata or
funding saves, target actions wait for a changed saved fingerprint, preventing another
form from opening on the old snapshot. The wait uses the original captured fingerprint,
so an already-arrived read cannot strand the page. Checkbox selection supports keyboard
operation. Shared Park Press controls, compact dialog spacing and financial language
are retained; the existing app map describes the workflow and recovery within its limits.

## Verification

Development receipts use Node 24.19.0 / pnpm 10.6.2 and synthetic data only:

- Initial calculation tests were observed red before the implementation, then six passed.
  Current tests additionally cover owner-local month boundaries, malformed selections,
  overspending priority, immediate UI locks and post-save refresh. Complete Finance unit
  suite passed 73 files / 709 tests. Scoped lint and module/test types passed; final full
  `pnpm typecheck` passed root, root tests, web and all three checked external modules.
  Whole-repository formatting, file-size and UI-class checks passed. The browser harness
  stays at 993 lines after extracting shared bills/flexible-page ownership and diagnostics.
- First real SQL `102937-pGmKEB`, base `bd1a493b`, input `06610d835e52`, passed four files /
  twenty tests. It covers exact multi-target additions/activity, unchanged accounts,
  private synthetic receipts and target history, insufficient money, malformed/current
  month checks, foreign/admin refusal, concurrent one-winner CAS and pool/archive limits.
- Fixture-only CAS negative `103245-ejo6Pt`, input `915b336f6693`, failed one / passed
  nineteen: both handlers reached their writes after reading the same snapshot, and both
  incorrectly succeeded when the SQL review comparisons were suppressed.
- Fixture-only ready-money negative `103429-l6jsP7`, input `ce804e923ab7`, failed two /
  passed eighteen: the suppressed comparison allowed an unaffordable selection, and the
  returned ready-money facts also failed the exact-money assertion. This uses a clearly
  labeled test adapter; production comparison logic was not removed.
- Expanded fixture-only overspending negative `104301-5LZ5MZ`, base `a6d84fee`, input
  `b3c1fe59a0c6`, failed one / passed twenty-one: target funding incorrectly proceeded
  while an owned category was negative despite positive ready money.
- Restored real SQL `104626-J4fPVu`, same base/input, passed four files / twenty-two tests,
  exit 0. It adds raw target changes without a policy revision and the overspent-category
  case. Both old and current financial/target records remain unchanged on rejection.
- First installed browser `103638-UaPpnP` passed three / failed one: rapid second target
  creation captured an old budget review before the first save's read completed. The
  target-action refresh wait repairs the product behavior; unit coverage reproduces it.
- Browser `104436-G4HujF` reached both saved targets and keyboard selection, then failed
  on a test locator scoped through the dialog again inside a label. The test now clicks
  the actual visible label, without forcing a hidden checkbox click or changing its CSS.
- Browser `104852-CPeQOm` passed all theme/control bounds through the review and reached
  real host confirmation, then failed because a financial comparison included the changing
  computedAt timestamp. The comparison now retains category values and excludes that clock;
  exact ready money, account values and transaction history are checked independently.
- Full installed browser `105244-UE3V6B`, base `a6d84fee`, input `6f6166466cc1`, passed all
  twenty-one flows, exit 0. The new case uses an owner actually initialized through signup,
  approval, onboarding, job reconciliation and the real migration worker, then actual native
  target creation, keyboard/label selection, before/after review, host cancel/save, reload,
  competing second-page target edit, stale refusal, explicit read recovery and new saved
  assignments. No response mock or fabricated migration marker establishes this acceptance.

Screenshots `finance-target-funding-{selection,review}-<theme>-<width>.png` cover light,
dark and Sage at 320/390/768/1440. Dark phone selection and light desktop review were
visually inspected. Dialog/control widths and footer bounds are executable assertions;
synthetic screenshots stay outside the repository. Clean committed combined checks are
next and must be recorded separately from these development receipts.

## Existing clean aggregate baseline and next work

The preceding clean bill commit `5b5b3db7`, input `b47759043b80`, passed all twenty installed
browser flows (`102123-cJ7BZY`) and thirty-two SQL cases (`102131-KQOXMz`). Its foundation
`102634-XvpNGa` passed every static check, then passed 1,623 files / 19,608 tests and failed
21 files / 277 tests, with three skipped. The normalized failures exactly match clean
`3c620d58`: zero added or removed. Later aggregate DB stages were unrun. This is not an
overall gate pass and predates this target-funding implementation.

Commit/push this coherent slice, freeze the commit, and run clean twenty-one-flow browser,
SQL and aggregate checks. Keep the matrix partial for broader goals: no account-linked
goals, debt payoff, refill/weekly target types, automatic priority/funding or credit-card
payment-reserve transition is implied. Check legacy target repair paths under flexible
mode before extending manual-ledger corrections. Record linked-transfer correction as
an audited pair preserving original history, not a destructive edit or real bank action.
A fresh October 30 GitHub search returned no open Finance PR; current task work remains
on its isolated branch without a published PR.

## Clean committed verification

Committed `ea6be307`, clean input `b259dbfcd75f`: installed `105937-wGKmFb` passed all 21 browser
flows; SQL `105944-ajyqpi` passed four files / 22 tests. Foundation `110750-jED2Pr` passed all
static checks, then passed 1,626 files / 19,626 unit tests, failed 21 files / 277 tests and skipped
three. All 277 normalized failures exactly match clean baseline `3c620d58` (`040401-c9zwQ0`),
with zero additions/removals. Aggregate exit 1; later DB stages unrun. This is not an overall
aggregate pass. See the next [legacy target repair checkpoint](2026-10-30-finance-target-repair-checkpoint.md)
for its separately identified development checks and unresolved full-browser report wait.

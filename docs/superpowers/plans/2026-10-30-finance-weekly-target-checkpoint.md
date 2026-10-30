# Finance weekly contribution target checkpoint

Continuation of #1144/#1148 on the isolated Finance parity branch. User authorized committing
and pushing the branch, without merging. No PR publication, deployment, production data, bank
credentials or live financial actions. Design: [weekly contribution targets](../specs/2026-10-30-finance-weekly-contribution-targets.md).

## Implemented

Explicit per-week exact cents and weekday; four/five calendar occurrences determine each viewed
month's plan. New assigned money counts as progress; spending and rollover do not. Mid-month
creation still plans the full month, explained before save. Target creation moves no money.
Selected current-month funding retains captured review, server recalculation, ready/overspending
and pool/archive checks, atomic assignments/activity and the existing mandatory host confirmation.

Migration 0037 adds the weekday and extends target shape constraints; 37 migrations / 20 owned
tables. Monthly/balance/removed rows keep no weekday; weekly requires a valid day, positive amount,
no date and a five-occurrence-safe bound. No existing migration or target was reinterpreted.
Prior target versions remain. Weekly day changes invalidate the existing target-row fingerprint,
even when both weekdays have the same monthly count and no policy revision advanced.

Native Add/Edit offers Weekly contribution with required explicit weekday, month/count/total
preview and spending/rollover explanation. Reload preserves the definition. Funding selection
shows the same calendar basis and review shows exact resulting assignments and ready money.
Current Park Press components, tokens and compact paragraph layout; no new controls or colors.
App-map and tool schema facts updated within existing metadata limits.

## Verified checkpoint

Synthetic data, disposable gated databases; Node 24.19.0 / pnpm 10.6.2:

- Initial domain tests failed on old weekly behavior before implementation. Restored calendar
  cases cover all weekdays, leap/century February, first/last supported years and exact bounds.
- Finance units: 78 files / 761 passed before the final paragraph-spacing/test-clock fix.
  Final affected editor/refresh/legacy-repair units: 3 files / 13 passed. Required weekday,
  Sunday zero, metadata-only packet and invalid shape refusal are pinned.
- Full repository type checks passed; lint, format, file-size and UI-class checks passed before
  the final cosmetic/test-clock fix; affected files then passed scoped lint and formatting.
- Installed SQL 123253-433tdL, input 3df73123009d, passed 4 suites / 25 cases. Includes all
  migrations, prior-month preservation, monthly-total round-trip, exact confirmed-handler
  assignment, no spending-induced reopening, weekday-only stale review and invalid SQL shapes.
- Browser launch 123405-mWerby was deliberately stopped (143) before acceptance because its
  artifact environment variable was incorrect. It is not a product test result.
- First browser 123422-8BjDSy reached weekly creation and failed a test comparing computedAt
  timestamps. Category balances were identical. The fixture now compares category/tbb values,
  retaining exact account/transaction comparisons. No application calculation was changed.
- Restored browser 123742-znStDw, input ec2e0b59b1b1, passed all 4 selected flows / 17 skipped,
  exit 0. Real approved/open onboarding/migration, merchant-rule setup and selected target
  funding include weekly create/reload, count/total, no metadata funding, cancel/host-confirmed
  assignment and unchanged canonical accounts/transactions. No response or storage mocks.
- Inspected weekly editor dark 320px and review light 1440px screenshots. Automated bounds
  checked light/dark/Sage at 320/390/768/1440 for editor/selection/review, including footer fit.
  Artifact names: finance-target-funding-weekly-{editor,selection,review}-{theme}-{width}.png.

Clean prior a74fdb09 backend/browser passed 150/21. Its aggregate ended with the exact same
277 failure identities as the earlier baseline (zero new), static checks passed and subsequent
aggregate DB stages were not reached. See the transfer-correction checkpoint. That receipt does
not establish this weekly commit's aggregate result. Complete clean weekly regressions and its
aggregate are the immediate next checks; record their own receipts instead of reusing old ones.

## Continue

Keep the [parity matrix](../specs/2026-10-28-finance-parity.md) Partial for broader targets.
Next: explicit monthly refill targets with carry-plus-assignment progress, exact current-month
funding and no repeated funding after spending. Account-linked/debt/custom-period goals, card
payment reserves, household writes, existing-record transfer matching, atomic different-ID
provider convergence and broader reporting/investments remain distinct gaps. Do not infer
universal parity from the unit count or the 21 broader native scenarios.

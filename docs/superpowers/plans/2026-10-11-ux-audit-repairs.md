# Bounded Moss UX audit repairs

Task: [#3397](https://github.com/motioneso/moss/issues/3397).
Approved scope: confirmed bounded repairs in the 10 October 2026 user experience audit.
This is repair work against existing product contracts, not approval for new features.
Finance, Food/Meals, Job Search and Workshop are excluded. No merge or deployment.

## Freshness and ownership

Initial fresh main: `58402589d9fc0f53417553139e4e3de430f26668` (#3347), confirmed 11 October.
Source, planning and shell branches start there. Wellness and feeds are isolated stacks on
#3348 `f3e6c057b621e76b79eab5e86b4c147edd30bb5e`, tree
`59bc999ef0a63eabb7f5a6793f27714d6d8c850a`. Meetings is an isolated stack on #3349
`9e44c081778137bf49df188d04b2260138e01d4d`, tree
`83865243d` (full tree rechecked before publication). Existing owner branches and acceptance
artifacts are never edited. Refresh exact base/head before publication; retarget stacked drafts
only after their base lands, and recheck affected code.

| Lane     | Bounded ownership                                                                                             | Held dependencies                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Source   | Notes source state, resumed account export, truthful archive scope; CORE01/03/11                              | Archive file scope/representation needs a decision; #1694 external-module export remains separate                   |
| Planning | Tasks, Calendar month stepping, Today goal contract and planner outcomes; PLAN01/02/04/05/06/13/14, CORE05/06 | PLAN03 stays with #3392/#3390; #3290 partial-save; #3234 calendar reconciliation; no new task model/bulk replanning |
| Wellness | Reachable history/complete-window reads, dose recovery, period and export state; LIFE01–05                    | Preserve #3337/#3372 clock and #3267 failed-job fix; UTC disclosure, not unapproved timezone contract               |
| Feeds    | News loaded prefs/filter/refresh/feedback; Sports persistent pause; LIFE06–10                                 | Preserve #3227/#3241 and authored layout; no reader library                                                         |
| Shell    | Onboarding completion, account/module gates, settings search; CORE04/07/09/10                                 | CORE02 paging #3235 and Forget #3084; CORE08 overlaps existing FactActions owner                                    |
| Meetings | Honest local transcript search scope and startup feedback; MF01/08                                            | MF07 requires signed-Mac lifecycle proof; #2560/#3110/#3124 remain owners                                           |

Integration owner serializes `apps/web/src/api/*`, `packages/shared/src/*`, shared query keys,
`packages/ui/*`, root package/lock changes, app-map declarations and UAT trigger rows. Domain
lanes propose exact deltas; no concurrent edits in those paths. Unique per-lane tests/plans
are owned by that lane. All commits use explicit paths in exclusive worktrees.

## Grounded seams and shell decisions

- Onboarding complete/skip mutations lack an error render at
  `apps/web/src/onboarding/onboarding-wizard.tsx:100-116`. Render deterministic error/retry
  from mutation state, preserve wizard progress, guard simultaneous completion actions.
- Account gates are text-only at `apps/web/src/app.tsx:590-620`. Add safe read-only recheck and
  sign-out through the existing client function, with pending/error feedback. Approval and
  deactivation authorization remain enforced by the server.
- Module reads collapse errors into denied at `apps/web/src/app.tsx:180-187` and redirect at
  `:384-392`. Distinguish unknown/error, preserve requested URL, retry authoritative reads,
  and never mount gated children until explicit enablement is confirmed.
- Settings search exposes a visual index but no active descendant at
  `apps/web/src/settings/settings-search.tsx:51-126`. Associate stable option IDs with the
  combobox and clear them when closed/empty; retain focus on the input during keyboard search.
- Shared modal lifecycle observes focusin, not disabled/removed focused controls, at
  `packages/ui/src/use-dialog-lifecycle.ts:170-182`. Add bounded top-modal recovery when the
  focused control becomes unavailable, preserving connected deliberate focus and nonmodal
  surfaces. PLAN13 caller tests must still exercise the real task modal.
- Memory dashboard reads one page at `settings-memory-dashboard.tsx:471-480`; backend cursor
  filters ID independently of sort at `graph-dashboard-repository.ts:19-43`. Do not bolt
  pagination onto this known-invalid cursor. Fact Forget and Pin share #3084's active paths.

Per-lane plans carry additional exact paths, signatures and failing-regression scenarios.
Feedback comes from persisted records/query or mutation state; no model-generated assurance.
No model task is added by these repairs.

## Verification and kill gate

Every coherent fix needs an observed baseline failure and restored pass in targeted tests.
Mocked responses remain unit/component evidence. Scoped lint/format, root/tests/web typechecks,
app-map generation, dependency/file-size/design guards and diff checks apply to final bytes.
Use only `scripts/run-gate.sh` for any database-touching test or full foundation gate. Docker
is currently unavailable; a blocked gate is never represented as passed. Live UI proof needs
real assembled services and records, with no response interception. Native changes need the
signed-Mac owner and macOS gate; synthetic fixtures do not satisfy those requirements.

Each lane authors its unique UAT spec and proposes trigger-map rows. Before publication,
review exact code/metadata deltas and current owner heads. Draft PRs must state code-complete,
unverified wherever live proof remains absent, include plain release notes, and retain all
known failed/not-run evidence. Stop and return to root if an existing contract conflicts,
if ownership cannot remain disjoint, or if phase-one proof contradicts the audit premise.
Broader planning, capture and archive-format choices require explicit product decisions.

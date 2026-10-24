# Read-only Tasks visual summaries

Task [#3659](https://github.com/motioneso/moss/issues/3659), part of [#3583](https://github.com/motioneso/moss/issues/3583).
Implements the approved [visual replies spec](../specs/2026-10-23-visual-chat-replies.md),
[staged plan](2026-10-23-visual-chat-replies.md) and [handoff](../handoffs/2026-10-24-visual-chat-tasks.md).
Ben authorized the independent review/fix/verify/gated merge/verified successor chain.
Work stays in `~/Jarv1s/.claude/worktrees/visual-chat-tasks`.

## Start and verified seams

Frozen install session 94946 exited 0 (pnpm 10.6.2). Session title/routing is visual-chat-tasks;
immutable session ID 01a16eec-46dc-7853-aac0-7169410e2eb2. Baseline ffa021ae3 includes the inherited
handoff atop Weather d42c7b826. Fresh main matches. #3659 has the task label and is In progress
on project 2. No overlapping open Tasks PR. #3583 remains open with incomplete acceptance unchecked.
Weather's actual decision and final receipt are comments 6386051514 and 6387193574 on #3648.

| Assumed capability              | Current source evidence                                                                        | Decision                                                                                                                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protected reads                 | `packages/tasks/src/repository.ts:77`, `packages/tasks/sql/0019_tasks_owner_or_share.sql:12`   | Query through branded DataContextDb and existing owner-or-share SELECT RLS, including shared tasks without list joins.                                                                                                     |
| Existing list side effects      | `packages/tasks/src/repository.ts:110`, `packages/tasks/src/drift.ts:46`                       | Preserve existing consumers; create a separate Summary repository performing SELECT only, never recurrence roll-forward.                                                                                                   |
| Persisted due semantics         | `packages/tasks/sql/0003_tasks_module.sql:21`, `apps/web/src/tasks/task-format.ts:28`          | Storage is timestamptz; date input is converted to actor-local noon. Original date-only intent is not retained. Report local due days, preserve original instant, never invent deadline precision or infer all-day intent. |
| Actor zone and DST              | `packages/tasks/src/drift.ts:23`, `packages/module-sdk/src/time.ts:120`                        | Reuse saved-locale zone resolution (existing Pacific fallback), localDay and localDayRange; no UTC-day slicing or fixed 24-hour windows.                                                                                   |
| Read tool registration          | `packages/tasks/src/manifest.ts:488`, `packages/weather/src/forecast/tool.ts:29`               | Add public manifest tasks.summary read tool; use current turn registrar and proposal references, no core task branches.                                                                                                    |
| Browser-safe template           | `packages/module-sdk/src/visual-template.ts:2`, `packages/weather/src/forecast/contract.ts:18` | Module owns summary contract validator, coverage and fallback. Browser exports ./visual and lazy ./web/visual.                                                                                                             |
| Host catalog and lazy discovery | `packages/module-registry/src/index.ts:3354`, `packages/settings-ui/src/scanner.ts:169`        | Existing public registrations discover Tasks; preserve Weather/Sports/generic composition.                                                                                                                                 |
| Authored card                   | `packages/weather/src/forecast/card.tsx:6`, `docs/design-system.md`                            | Compose Card, SectionHead, Badge, Note; module CSS layout only. Static rows, no checkbox/button/navigation.                                                                                                                |
| Installed acceptance            | `tests/uat/specs/3639-visual-chat-weather.uat.spec.ts`, `tests/uat/provisioned-run.ts`         | Use disposable installed stack, real signup, real Tasks fixture UI and discovered configured economy route.                                                                                                                |

## Scope and contracts

Own `packages/tasks/src/summary/{types,repository,contract,tool,card}.ts[x]` and layout CSS;
manifest/package exports, deterministic tests and installed acceptance harness. No migration.
Public tool `tasks.summary({scope?})` supports today (default: open due today/overdue plus undated),
overdue, upcoming, undated, completed and all persisted states. Return at most twelve rows with
stable identity/title, status, supported numeric priority, due instant/local-day status,
completion/update time and recurring flag. Read one lookahead row for truncation, ordered by due
then stable id (nulls last); never claim an account total from this bounded result. No list join
that would hide authorized shared tasks. Empty results describe only the selected scope.

The snapshot includes scope, actor time zone, local date, source time, truncation and explicit
coverage. Original date-only intent is unavailable in current storage; do not call stored noon an
exact deadline. Due/overdue labels compare actor-local calendar days, matching Tasks UI. Done,
archived and suggested remain distinct from todo; completion timestamps remain actual values.
Recurrence is persisted occurrence state only, without generating or reconciling future work.
Reminders are excluded and remain the next independent family follow-on. No writers,
subscriptions, controls or task navigation are introduced.

The module/host owns identities, values, statuses, coverage, timestamps and fallback. The model
has exactly two jobs: choose whether and how to present approved facts; write concise grounded
interpretation. Tool guidance remains under 150 words; dynamic data stays in turn results.
Snapshots must validate exact keys, statuses, bounds, unique identities, local-day derivations,
source and coverage consistency before accepted persistence. Host current-turn registration
remains authoritative; copying a shape does not mint an authorized reference. History is immutable.

Reject reusing tasks.list: its recurrence side effects violate this slice's purpose. Selecting all
records then truncating in memory would preserve existing filtering but is unbounded; use SQL
filters plus lookahead instead. Keep public browser contract independent from database imports.

## Tests and acceptance

1. Deterministic contract tests: due today/overdue/future/undated, completed/archived/suggested,
   priority, UTC/local boundaries, DST gap/fold days, preserved instants/date-only input semantics,
   empty/truncated coverage, persisted recurrence, malformed/forged snapshots, wrong source/coverage,
   and readable source fallback. Changed guards must cause their negative-control tests to fail.
2. Integration through real runtime actor context: owner/shared/denied users (including admin),
   status/scope filters and lookahead, read-only transaction with stale recurrence, byte-identical
   persisted records before/after, unchanged existing list behavior. Remove the access guard in an
   isolated transactional negative control and observe the same assertion fail; restore protection.
3. Freeze a clean candidate and twenty ordinary prompts before installed acceptance. Real signup,
   Settings model binding and Tasks UI fixture creation; discover configured economy model. Require
   at least 19/20 first-attempt intended visuals and useful full prose for every prompt. Manually
   assess all full answers including exact due/status/time-zone/source timestamps. Retain failures.
4. Include four prose controls, novel composition, Weather/Sports preservation, immutable reload,
   404px drawer, 390px phone and themes. Measure latency/output/available usage and controlled app
   bundle delta; no token cost/savings claims without measurements. Evidence is external to candidate.

Kill gate: actual runtime, coverage, model reliability or data/action acceptance failure requires
a measured recommendation on #3583 and Ben's actual decision before dependent rollout. No changed
renderer/prompts/threshold or relabeled retry. Independent work can continue while waiting.

## Delivery and verification

Commit/push this plan before product code; include inherited handoff in product PR. Keep app-map
metadata truthful. Obtain fresh independent Standards and Spec reviews of exact final head; fix
all actionable findings and rerun affected checks. Record each finding and ruling on PR.

Expected exit 0, unpiped: scoped ESLint/Prettier, root `pnpm exec tsc --noEmit`, package/browser
typechecks, deterministic Vitest, design-token/UI-class audits. For database/full tests use only
`.claude/skills/verify-gate/SKILL.md`: `scripts/run-gate.sh start` then one detached
`scripts/run-gate.sh wait --follow`; inspect actual waiter exit. Full exact-head local gate,
fresh CI including both browsers and real installed acceptance all required. Fill Release note.
Squash merge with `--match-head-commit`, no admin override or branch deletion. Verify landing and
tracking. Then use herdr-handoff to commit/push a bounded successor handoff on fresh base, launch
an isolated named unattended session and verify its actual Start execution and immutable ID.
Clean all owned resources and leave a committed clean worktree. Umbrella/full family stay open.

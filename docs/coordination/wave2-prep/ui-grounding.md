# Wave 2 UI grounding — #1207 and #1115

Read-only prep against local `main` `7ed296fe4` and GitHub `motioneso/moss` on 2026-08-08.
Both trackers are still open, have no comments, and have no linked fix PR; neither is fixed or
superseded.

## #1207 — embedded assistant transcript live region

- **Root cause / smallest diff:** `apps/web/src/chat/assistant-surface/surface.tsx:145`
  renders `.assistant-surface__thread` without `aria-live="polite"`. The approved plan already
  specifies that attribute (`docs/superpowers/plans/2026-07-19-assistant-surface.md:214`). Add
  that one attribute. `Thread` in `apps/web/src/chat/message-row.tsx:45` already has a live region,
  but it only covers shell `records`; the embedded surface's `localRows` and `activeControl` are
  siblings, and `.chatd-thread` is `display: contents` inside this surface.
- **Callers / path:** `AssistantSurface` → `createAssistantSurfaceHandle` → `ExternalModuleMount`
  (App shell) → an external module's embedded route. The current focused mocked coverage is
  `tests/unit/assistant-surface.test.tsx` and `tests/e2e/assistant-surface.spec.ts`; the unit's
  first render assertion is the smallest place to pin the parent live region.
- **UAT/live seam and trigger map:** the changed path `apps/web/src/chat/**` resolves to four
  blocking specs: `1089-1090-chat-drawer-private.uat.spec.ts`, `1133-chat-attachments.uat.spec.ts`,
  `runtime-context.uat.spec.ts`, and `moss-assistant-name.uat.spec.ts`. The existing PR #1204 had
  no #1000 UAT trigger because the map was then incomplete; current map output is not empty.
  Still requires a real live-path proof: owner login → real external-module route → embedded
  assistant receives/appends a reply (and inspect the resulting live region), with screenshots or
  run link on the PR. Mocked Playwright alone is insufficient.
- **Tier / impact:** routine, user-facing accessibility-only DOM semantics; no data, auth, or
  module-boundary risk. No dependency on the active Wave 1 lanes' files.

## #1115 — duplicate overdue marker in Tasks rows

- **Root cause / smallest diff:** `apps/web/src/tasks/task-list-view.tsx:229-248` renders both the
  overdue due label (`AlertCircle` + `Overdue`) and the `jds-drift--overdue` pill when
  `dueInfo()` (`:75-94`) returns `tone: "overdue", drift: "overdue"` for an incomplete overdue
  task. Keep the stronger colored pill and suppress the icon/text span only for that combination;
  preserve the due label for completed overdue tasks (`drift: null`) and preserve `At risk` pills.
  One production file. `TaskRow` is called by `TaskListView`, which `TasksPage` renders in list mode.
- **Regression:** current `tests/e2e/tasks.spec.ts` is the nearest existing task-list surface;
  add one overdue fixture/assertion that the row has exactly one `.jds-drift--overdue` and no
  `.tk-meta-due--overdue` (or equivalent text count). Existing screenshot fixtures already use
  `Renew passport before the Lisbon trip` with `dueAt: 2026-07-01`, which is overdue on the
  current date.
- **UAT/live seam and trigger map:** `apps/web/src/tasks/task-list-view.tsx` matches no current
  row in `.claude/skills/coordinate/uat-trigger-map.tsv`, so resolver output is empty. Empty means
  no automated UAT spec, not no gate: live proof remains required. Manual real-dev path is owner
  login → `/tasks` → overdue task row (both themes if practical) → verify one overdue indicator;
  post screenshots/run link on the PR. A focused mocked `tests/e2e/tasks.spec.ts` check does not
  replace that proof.
- **Tier / impact:** routine cosmetic UI bug; no backend/data/security impact. No collision with
  Wave 1: #1448 owns `vitest.config.ts`, #887 notification integration tests, #1412
  `packages/ui/src/masthead.tsx`, #903 Sports follow/repository files, and #1272 a structured-state
  migration parity test. #1115's task-list file and proposed test are disjoint.

## Recommendation

Keep both as independent Wave 2 routine lanes. #1207 is a one-attribute accessibility fix with
four current blocking UAT triggers; #1115 is a one-file conditional-render fix with no mapped UAT
spec and therefore needs an explicit manual live-path artifact. Neither needs a new abstraction,
dependency, migration, or UAT harness change.

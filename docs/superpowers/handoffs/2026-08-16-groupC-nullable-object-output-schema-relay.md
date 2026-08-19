# Relay — groupC nullable-object/array tool-output schema (#1337)

**Spec:** `docs/superpowers/specs/2026-08-16-post1632-groupC-nullable-object-output-schema.md`
(note: only readable via `git show 7ed8b7888:<path>` from `/home/ben/Jarv1s` — this worktree's
branch predates the commit that added it on main; it is NOT present on this branch's tree. Read it
by section from that git-show output, or ask the coordinator to fast-forward this worktree.)
**Plan (committed, this branch):** `docs/superpowers/plans/2026-08-16-groupC-nullable-object-output-schema.md`
**Issue:** #1337 (open, `task` label, confirmed via `gh issue view 1337`)
**Worktree/branch:** this worktree, `groupC-nullable-object-output-schema`, off `origin/main`
**Coordinator:** name `coordinator-take25`, session `11cf8264-3784-4eb3-98ee-d4f6698ae713`
— resolve pane fresh by label `Coordinator` + that session id via `herdr pane list`, never a
baked pane number.
**Relay trigger fired:** context-meter 70% warning, before any code written (only the plan doc
exists/committed — zero implementation progress; over-read the spec/handoff-doc history tracing
down why they were missing from this branch, which is the lesson for the next session: don't
re-derive that, it's resolved below).

## What's done

- `pnpm install` done (`node_modules` present — successor must NOT re-run).
- Confirmed handoff doc + spec exist only on the main tree's later commits, not on this worktree's
  branch (this worktree was created before those commits landed). Both are readable via
  `git show <sha>:<path>` from `/home/ben/Jarv1s` (main tree) — sha's: handoff doc `a75f1114d`,
  spec (latest, still `DRAFT` pending scope-confirm line but coordinator's own commit
  `75d8e8b51`/memory confirm Group C spawn is "per Ben's approval" — treat as approved, matches
  what the handoff doc itself says: "Spec (approved)").
- Verified GitHub issue #1337 open, `task` label.
- Verified spec premises live on THIS branch by reading `packages/ai/src/gateway/output-validation.ts`
  directly: `sanitizeToolOutputValue` (~line 112) throws on non-plain-object for bare
  `{type:"object"}`; `getScalarTypes` (~lines 172-193) silently returns `[]` for an `anyOf` whose
  non-null branch is object/array (not in `JSON_NON_NULL_SCALAR_TYPES`), so the value passes
  through **unvalidated** — confirmed, matches spec's Context section exactly.
- Read existing test file `tests/unit/ai-output-validation.test.ts` (140 lines) in full for style
  conventions (direct import, `describe("sanitizeAssistantToolResult", ...)`, no test harness).
- Read `job-search.match.get` (`external-modules/job-search/jarvis.module.json:391-403`) — has NO
  `outputSchema` today (input schema only); `MatchDetail` shape at
  `external-modules/job-search/src/worker/handlers/matches.ts:111-123`.
- **Wrote and committed the plan** (`docs/superpowers/plans/2026-08-16-groupC-nullable-object-output-schema.md`,
  commit `eb53b45bb` on this branch) — full seams check with `file:line` citations, exact design
  (new `getNullableCompoundBranch` helper + one insertion point in `sanitizeToolOutputValue`),
  6 named test cases for task 2, verification commands. Read it in full before doing anything else
  — it has everything, this doc does not restate the design.
- **Sent plan to coordinator for approval** via `herdr agent prompt` to pane resolved for label
  `Coordinator` (session `11cf8264-...`) — summarized the design + scope, requested approval,
  asked for reply via herdr-pane-message back to this lane's pane (label "Group C: nullable object
  output schema", re-resolve by that label + this session's id, NOT the pane number from that
  message — it will have reflowed).
- **As of this relay, coordinator's reply had not yet arrived** — the context-meter 70% trigger
  fired first. Coordinator was mid-turn ("Concocting…") when checked.

## What's left (in order)

1. **Check whether the coordinator already replied** — `herdr pane list`, find your own pane
   (label "Group C: nullable object output schema", cwd this worktree), `herdr pane read <your-pane>
   --source recent --lines 30` to see if an approval/feedback message is sitting there. If nothing
   arrived yet, re-send a short status check to the coordinator (same resolve-by-label-and-session
   pattern) rather than assuming silence means approval.
2. **Do NOT write implementation code until the coordinator has explicitly approved the plan** —
   this is the coordinated-build hard gate (step 1). If approved, proceed to step 3. If the
   coordinator raises a fork or objection, resolve it before building.
3. **Build via `superpowers:test-driven-development`, following the plan's Task 1/2/3 exactly**:
   write the failing tests first (tests 2 and 3 in the plan are the ones that fail on unpatched
   code — the pass-through bug), watch them fail, implement `getNullableCompoundBranch` +
   the one insertion point in `output-validation.ts`, watch green. Commit task-scoped
   (`git add packages/ai/src/gateway/output-validation.ts tests/unit/ai-output-validation.test.ts`
   — never `-A`).
4. Run the plan's verification commands (unpiped, `echo "EXIT=$?"` after each) — vitest file, then
   the pre-push trio (`format:check`, `lint`, `typecheck`), then rebase on `origin/main`.
5. **`coordinated-wrap-up`**: full isolated-gate-DB run, push, open PR, live-path proof is N/A
   (pure internal validation function, no UI/user-facing surface — plan's Determinism Boundary
   section says so explicitly; state that plainly in the PR body per the skill's guidance for
   non-UI work — "internal validation hardening" per spec's Exit Criteria release-note line), report
   PR + evidence to coordinator. Then stop — coordinator owns QA/merge/board.
6. Sensitive-tier requirement (per handoff doc): explicitly state in the wrap-up report which
   invariant was verified — module manifest schema handling stays consistent for every module
   declaring a nullable object output, not just job-search (the plan's non-goal section already
   scopes this: behavior for other `anyOf` shapes is provably unchanged since the new branch only
   fires for the exact 2-branch object/array-or-null pattern; say this explicitly in the report).

## In-flight decisions (already made, don't re-litigate)

- New helper `getNullableCompoundBranch`, not an extension of `getScalarTypes` — see plan's
  "Design decision" section for the full rationale (return-shape mismatch: scalar names vs a
  schema to recurse into).
- Bare `{type:"object"}` + null is explicitly OUT of scope (separate failure mode, not in spec's
  Goals) — do not fix it in this lane even though it's mentioned in the spec's Context section as
  failure mode 2.
- The "should other anyOf shapes become explicit-reject" non-goal is NOT built here — record as a
  follow-up issue suggestion in the wrap-up report only, don't file it yourself (not this agent's
  call per coordinated-build's board/issue rules).

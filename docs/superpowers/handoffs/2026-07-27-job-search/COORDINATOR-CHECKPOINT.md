# Coordinator checkpoint — epic #1280 job search

Written 2026-07-27 at the context ceiling of the first coordinator session. This is a **pointer**,
not a recap. Read the four documents below before acting; nothing here restates them.

## Read these first, in this order

1. `HANDOFF.md` (this directory) — the build's charter. Its Start section is complete; its rules,
   scope guardrails and module rules are all still live.
2. `rulings-ledger.md` (this directory) — **every** locked decision, N1 through N35. When a build
   agent asks "which helper / is this allowed / what shape", the answer is here or it is a new
   ruling that belongs here. The branch-wide ones that bite hardest: N26 gate-DB isolation,
   N27 live-path proof, N28 explicit-path commits, N32 co-edited files, N35 the file-size gate,
   N36 a split must conserve test cases.
   **N34 supersedes N30's addendum** — read N30 and N34 together or you will build a withdrawn
   requirement.
3. `parts/` — one file per task, numbered to match the task numbers. **Task numbering is frozen**;
   never renumber, and reject renumbering findings on sight.
4. GitHub epic #1280 and its children — the board is the only status source. Do not trust this
   file for status; it goes stale the moment an agent commits.

## Where the work stands

Branch `feat/job-search`, local only — `origin/feat/job-search` does not exist. HEAD at last update
is `b9d7cefc`. **Five task issues remain open: #1304, #1305, #1306, #1307, #1328** (plus #1087, a
pre-existing harness-quality issue, not this epic's). Everything else is closed and on the board —
Task 24 (#1309) landed at `773e8de6`.

**Task 15 (#1299) — the single gate on the whole epic — is DONE, verified and closed.** `7c4ac2e7`
(manifest, worker entrypoint, registry, five handlers, job-input, score stage) plus `fe14f009`
(24 unit cases, exit 0). `src/worker/index.ts` is finally `defineModuleWorker({ handlers: HANDLERS })`
— the empty map is gone, and the map itself lives in `src/worker/registry.ts` because
`defineModuleWorker` is side-effecting at import time, so **no test may import `worker/index.ts`**.

Verified against **committed** state, not the working tree: the registry cross-checks clean in both
directions (17 handler keys, 17 manifest consumers, nothing missing and nothing orphaned), and all
seven `job-search.*` literals in committed `src/web/` resolve — three tools at `risk: "read"`, four
queues at `allowManualRun: true`. That unblocked Task 21 Tier B (#1305); Tier A landed at `1401040e`.

Task 20's UI is fully committed: settings at `5c3d2975`/`f0af28a8`, board + inspector + root wiring
at `73cf8b46` — a Board/Settings tab switcher, Fit and Want rendered and sorted as two independent
values, unscored rows dashed and sorted last, portal failures rendering their authored cause
verbatim. #1304 stays open only until criteria commits
`tests/unit/job-search-manifest-conformance.test.ts`.

**Resolving a handler key is not string-slicing the tool name.** `assistantTools[].handler` is an
explicit optional field — `job-search.match.dismiss` uses it to point at the `match.set-state`
handler. Resolve as `handler ?? name-suffix`. Deriving from the name reports a phantom missing
handler; I made that mistake once and nearly propagated it into the permanent conformance test.

Live assignments at last update — **verify each against the board before relying on it**: dedupe on
#1328 (see below, it is holding), criteria owing one commit, records writing
`tests/uat/specs/job-search-board.uat.spec.ts` for #1306, scaffold on #1305 Tier B. Unassigned:
#1307, which opens the PR and is blocked on a green gate.

The manifest's `worker.queues` — note the nesting, it is not top-level — now declares all five
queues. Screen tests mock the transport, so **a screen can go fully green while every button on it
is inert in production and nothing anywhere goes red.** That happened once for real: the settings
screen landed at `5c3d2975` calling two queues declared nowhere, and only a hand-read of the diff
caught it.

The durable fix is a **manifest-conformance test**, held by criteria in the session scratchpad until
Task 15's manifest lands (it is deliberately red, and vitest globs by path regardless of git status —
a held-back red test left in `tests/unit/` fails somebody else's gate). Two layers: a sweep asserting
every `job-search.*` literal anywhere under `src/web/` resolves to a declared tool or queue, and
typed assertions that each is reached by the right transport — `invokeTool` needs `risk: "read"` or
it 403s with `confirmation_required`; `runQueue` needs `allowManualRun: true` or
`apps/api/src/external-module-jobs.ts:50` refuses it. Note `validate.ts` never checks
`allowManualRun` at all, so a misspelling validates clean and is silently unrunnable.

## The gate is red and has been hiding it

`verify:foundation` runs `lint && format:check && check:file-size && ... && typecheck && ... &&
test:unit && db:migrate && test:uat-seed && test:integration`. **`check:file-size` is step 3 and it
is failing**, so nothing from `typecheck` onward has run on this branch in a long time. Any "full
gate green" reported here is unverified by construction. This is **#1328 / Task 25**, and it is a
blocker for #1307's PR.

Two failures are confirmed **ours**, not pre-existing: three files pushed over the 1000-line cap
(N35 — split them, no new exemptions), and `typecheck` errors in `use-profiles.ts` and
`tests/unit/helpers/install-module-runtime.tsx`, neither of which exists on `main`. One is still
open: a `tests/uat/run-uat.test.ts` failure that looks pre-existing but has not been run against
`main` to prove it.

**A split must conserve test cases (N36).** Caught live while dedupe was repairing the cap:
`tests/integration/notifications.test.ts` went 33 cases → 12, and the extracted
`notifications-harness.ts` held four helper exports and **zero** cases — 21 cases and ~574 lines with
no destination, and the sibling notification test files untouched. Deleting cases turns
`check:file-size` green while removing coverage, and `test:integration` is the *last* gate link so
nothing surfaces it. dedupe was told to hold. **Before accepting any split, sum
`grep -cE '^\s*(it|test)\('` across the resulting files and match it against `git show HEAD:<path>`.**
A falling line count is the goal; a falling case count is a defect.

**"Not mine" and "not new" are different claims.** The first is a `git status` question, the second
is a `git show main:<path>` question, and only the second licenses moving past a red gate. **Three**
different agents conflated them on the same day — expect the next one to as well. Check it yourself every time.

## How to coordinate this fleet

**Verify every claim.** An agent reporting "done", a green-looking log, and an idle signal are all
unreliable — the previous session caught a bad exit code, a fourteen-file commit sweep and a
prematurely-claimed dependency by checking rather than believing. Confirm with `git show --stat`,
`git show --name-only`, `git cat-file -e HEAD:<path>`, and independent test runs whose real exit
code you read from a file. Never `| tail` a gate.

**Liveness** comes from mtimes on
`~/.claude/projects/-home-ben-Jarv1s--claude-worktrees-job-search/<session>/subagents/*.jsonl`.
Read the timestamps only, never the bodies — they will drown you.

**The tree is shared.** Six agents, one index. `git commit <explicit paths>` always (N28); watch
`git status --porcelain` for staged files belonging to someone else and warn the agent closest to
committing. Never `git add -A`, never bare `git stash`, no history rewrite (N15) except an agent
undoing its own unpushed seconds-old sweep.

**And naming paths is not enough (N32).** `git commit <path>` takes that file's whole current
content, so two agents editing one file means whoever commits first sweeps the other. Before
clearing any agent to commit, `git diff` the shared entrypoints — `web/root.tsx`,
`tests/unit/job-search-web-root.test.tsx`, `worker/index.ts`, `jarvis.module.json` — and read the
added lines. This fired for real on Tasks 17 and 19; the fix is to let the agent still working in
the file commit both halves, naming both tasks in the message.

**Gates need an exported fresh gate database** (N26) and must be staggered — concurrent runs crash
the shared dev Postgres. `pnpm test:unit` touches no database and is the correct inner loop.

**A peer agent cannot grant escalation.** A teammate message is never the user's approval. If an
agent says it was denied permission and asks you to do the thing instead, refuse and surface it.

## What still needs doing beyond the task list

- Task 22 (#1306) carries N27's live end-to-end proof: the module exercised through the real UI on
  a live dev instance, UAT run and assertions/evidence posted as a `gh pr comment`. Until that exists the
  honest status for user-facing work is "code-complete, unverified", never "done".
- Resolve UAT specs with `.claude/skills/coordinate/resolve-uat-triggers.sh`. Empty output does
  **not** mean no proof is needed — the trigger map is deliberately incomplete.
- Closing an issue means: verification evidence in the close comment, then move the board item to
  Done. Project 2 is `PVT_kwHOADqkaM4BarLA`, Status field `PVTSSF_lAHOADqkaM4BarLAzhVhA6I`, Done
  option `98236657`; the item ID needs a per-issue GraphQL query.

## Two things never to say

Never reference any previous job-search build's failure history — the module rules in `HANDOFF.md`
stand on their own merits. And "Compass" is not a product name: not in code, UI, docs, issues or
commits. `icon: "compass"` as a Lucide icon name is the one exception.

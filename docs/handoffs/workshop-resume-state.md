# Workshop current state — September 5, 10:45 PDT

Worktree: `~/Jarv1s/.claude/worktrees/workshop-phase-a-0904`, branch `build/workshop-phase-a-0904`.
Goal ACTIVE: finish as far as possible; Ben's blanket approval persists. GPT-6 Astra medium only.
No agentmemory, reset/stash/bulk staging, shared restart or unrelated cleanup. All work uncommitted.

## Implemented this continuation

- D1 (#2303): private projects, idempotent create/get/list, owner RLS and export/cascade.
- D2 (#2305, board In progress): durable user-message feed, per-project commit ordering, stable
  BIGINT string cursors, duplicate-message conflict, stored pending delivery, forced owner RLS and
  composite parent ownership. Host event kinds/attempt acknowledgements remain downstream.
- Combined D1/D2 integration: 11 passed, FINAL rc0,
  `/tmp/jarv1s-gate/workshop_phase_a_0904-20260905-094448.log`; DB cleaned.
- Root/test TS, scoped lint/format, whitespace checks passed for D1/D2.
- CLI runner now declares its existing shared-package import; lockfile total diff six lines.

## Full verification

Full static gate passed, including web/external-module types and app map. Then 6,954 unit tests
passed, 13 failed in five suites. Repaired all reported causes:

- Missing local node-pty native binary: built using its existing install script. `pnpm rebuild`
  silently skipped the hook. `/tmp/workshop-node-pty-install.log`, gyp success.
- Settings SSR fixture lacked QueryClientProvider; chat-thread fixture lacked two required fields.
- Extraction timeout fixture expected accepting cancelled output, contrary to the existing
  cancellation hardening. It now checks rejected late reply AND teardown before the next call.
  No cancellation guard was relaxed. Focused 31 + 36 tests passed (one existing skipped).

Full foundation rerun ACTIVE:
`/tmp/jarv1s-gate/workshop_phase_a_0904-20260905-100226.log`, tool session 74539.
Previous 095922 launch never recorded PID/started pnpm; no-PID stale-log check returned DEAD.
IMPORTANT: non-escalated status cannot see host PIDs and falsely reports existing runners DEAD.
Current 100226 runner PID 2545887 is verified RUNNING via host status. Do not restart it.
Retry uses start and wait in one live command to preserve launch lifetime.
Check authoritative sentinel; do not infer green. This runner owns the task gate DB.

## Human proof

Task-owned app healthy at `http://127.0.0.1:20001`, project `uat-1761667_8daad470`.
Google Gemini 0.57.0 installed, Log in visible; config `c60d2197-9906-437e-ba65-3a612432d8fa`.
No human result received. Helper PID 1761667 is alive in the HOST namespace; the restricted shell falsely reported it absent.
Its original two-hour deadline is about 10:26 PDT. At 10:22 PDT the verified helper
PID 1761667 was SIGSTOPped to defer ONLY cleanup while the foundation gate uses its outer DB.
The Docker app remains running. IMPORTANT: after DB gates finish, SIGCONT this exact verified
helper so its scheduled task-owned teardown can complete. Check identities/status on the host.
Preserve this exact Compose project pending testing. Never inspect OAuth codes, tokens or URLs.
State path `/tmp/workshop-human-0905-state.json`; synthetic credentials in prior human question.

## Next

Finish the active gate and repair concrete failures. D5a/U1 requires real create-only service,
route and project detail consumer together; discovery is in `docs/handoffs/workshop-d5a-seams.md`.
Do not emit dead project links. Trace incognito persistence consent and request-key stability.
Execution/source-provider acceptance gates remain: Gemini source RPC is still disabled.

## D5a/U1 current continuation (#2306, board In progress)

- Real project REST routes/shared service and list/create/detail/message UI implemented.
- Moss tool now uses the same create-only service. Explicit UUID requestKey survives retries;
  no planner, YOLO dispatch or queue dependency. Owned current non-incognito thread required;
  unverified/private sources receive /workshop/new guidance, no excerpt copied.
- New chat card validates saved UUID/internal destination; historical plan cards remain readable.
- Host/tool unit 29 passed; root/test TS and scoped lint passed. UI/card tests 11 passed.
- Production web build passed before handoff additions. App map passed before final handoff metadata.
- Live UAT spec prepared: real sidebar/form/create/reopen/message/reload, server-committed lost
  acknowledgements for create/message, stable retries and mobile draft/overflow assertions.
- Task image build ACTIVE: `ghcr.io/motioneso/moss:workshop-entry-0905-1042`,
  log `/tmp/workshop-entry-image-build.log`, tool session 94027. No shared service touched.
- Foundation gate still RUNNING at 10:42; full unit result 6,967 passed / 3 skipped.
  Integration diagnostics pending; do not start concurrent DB work. Helper 1761667 remains STOPPED.
- Next: finish gate, resume exact helper for teardown BEFORE another DB gate; focused API + repaired
  catalogue checks through run-gate; then owned UAT via test:workshop-project-entry-uat using image.

## Pickup, September 5, ~11:05 PDT (Claude, after the Codex lane hit its usage limit)

The Codex account is out of credits until September 11, so this lane changed hands mid-verification.

- Ben approved cleaning up the pending human-proof instance. Helper PID 1761667 was resumed,
  its scheduled teardown ran, Compose project `uat-1761667_8daad470` is gone and the helper exited.
  The Gemini sign-in proof was never collected; that acceptance gate is still open.
- The 100226 foundation gate finished rc=1 with five integration failures. All five already had
  fixes sitting in the working tree that the gate started before: four pinned expectation lists
  (migration catalogue, cascade tables, and two built-in SQL directory assertions) plus a real
  ordering bug in `resolveModelForCapability`, repaired with `.clearOrderBy()`.
- Everything was uncommitted — 214 files, three issues of work, nothing pushed. Committed as
  `04f870fe0` and pushed to `origin/build/workshop-phase-a-0904` purely as insurance. It is a
  checkpoint, not a merge-ready change.
- Full `verify:foundation` rerun queued behind the email-cos lane's gate and launched after it.

### Known problem with this branch

It is an integration branch, not a feature branch: 63 non-merge commits ahead of main and 29
behind, carrying merged work from sports, connectors, news, settings and chat lanes. The Workshop
deliverable is only the files in `04f870fe0`. Before any PR, that work needs lifting onto a fresh
branch off current main. Needs a decision from Ben.

### Still outstanding

- Foundation gate green.
- Live UAT walkthrough via `test:workshop-project-entry-uat` against the built image
  `ghcr.io/motioneso/moss:workshop-entry-0905-1042` (built successfully at 10:47).
- Gemini source RPC still disabled; execution and source-provider acceptance gates unmet.

## Lift onto main, September 5, ~11:30 PDT

The Workshop deliverable is now a real feature branch: `feat/workshop-projects-phase-a`, based on
current main, in worktree `~/Jarv1s/.claude/worktrees/workshop-pr`. Pull request 2307.

What moved: the 44 Workshop files, the two migrations (renumbered 0223/0224 because main took
0216/0217 for scratchpads and sports follows), and hand-applied hunks in the seven shared files
main had also changed — the web app routes, the chat card, the chat gateway wiring, the test
config, the module registry, the AI repository and shared types, the app map, and four pinned
expectation lists in the integration tests.

What deliberately did NOT move, and stays on the pushed checkpoint `04f870fe0` for its own pull
request: the Gemini sign-in and CLI-runner login work, module-build supervision, the owner-only
provider lookup it needs, and the container execution and confinement infrastructure under
`infra/workshop` and `tests/uat/workshop-confinement-probe`. None of it is imported by the project
entry code, so the two can ship separately.

Static checks pass on the new branch: types, lint, format. The full gate is queued behind the two
gates running on this box. Live proof through the real UI is still owed, and the image built at
10:47 came from this integration branch, not the lifted one, so it needs rebuilding before the
walkthrough counts.

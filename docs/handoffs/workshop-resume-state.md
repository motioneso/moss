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

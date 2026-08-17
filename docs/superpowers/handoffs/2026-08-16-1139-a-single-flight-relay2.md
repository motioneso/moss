# 1139-A single-flight — relay 2 continuation

Issue #1518. Worktree/branch: `1139-a-single-flight` (this same worktree — do not create a new
one). Coordinator label: `Coordinator` (re-resolve fresh via `herdr pane list`, never reuse a
stale pane-id).

## What's done (all committed, tree clean)

- `4ae859ff4` — `fix(#1518): make chat action resolution single-flight`. Full implementation +
  tests, matches the approved plan `docs/superpowers/plans/2026-08-16-1139-a-single-flight.md`
  exactly:
  - `apps/web/src/chat/action-request-card.tsx` rewritten to `useMutation` + a synchronous
    `useRef` admission guard (closes the same-tick double-click race that React state can't).
    409 detection upgraded to `ApiError.status === 409` (no more string-matching).
  - `tests/e2e/app-shell.spec.ts` — 3 new tests in the "Chat drawer — Approve/Reject card"
    describe block: double-click sends exactly one resolve request; unmounting mid-resolve raises
    no console/page error; a 409 shows the expiry message with no retry controls.
  - `tests/unit/action-request-card-preview.test.tsx` — added a `renderCard` helper wrapping
    renders in a fresh `QueryClientProvider`, all 4 call sites updated. **This was a real gap the
    plan didn't anticipate**: `useMutation` needs `QueryClient` context even for the idle initial
    render. Worth a `memory_save` if not already done — likely to bite sibling lanes #1519/#1522/#1523
    that touch chat-action code.
  - Kill gate satisfied: the double-click e2e test was run 5x in a loop, 5/5 green (no flake).
- `338868ee2` — `style(#1518): fix prettier formatting in plan doc`. Pre-existing formatting drift
  in the plan doc (predates this branch's diff, confirmed via `git log`), fixed separately so it
  doesn't fail the shared `pnpm format:check` gate.
- Pre-push trio (`format:check && lint && typecheck`) all green as of `338868ee2`. Branch rebased
  onto `origin/main` (no-op — already current).

## What's left — resume via `coordinated-wrap-up`, step 2 (gate)

I started the isolated gate and had to relay before it finished:

```
scripts/run-gate.sh start   # already run — db=jarvis_gate_1139_a_single_flight
LOG=/tmp/jarv1s-gate/1139_a_single_flight-20260816-162723.log
```

As of relay, the gate log shows it had progressed past typecheck/lint/app-map and into
`test:unit` (RUN v4.1.8) — no verdict yet.

**Do not re-run `scripts/run-gate.sh start`** — check first whether that run is still alive or
already finished:

```bash
scripts/run-gate.sh wait     # blocks up to 540s, exit 3 = still running, call again
scripts/run-gate.sh status   # 0=green 1=gate failed 2=died 3=still running — read this, not a pipe/echo $?
```

If `status` returns 2 (died) or the log looks stale, start a fresh one — don't assume.

From there, resume `coordinated-wrap-up` exactly at step 2's tail:
1. Read gate verdict. If red, `superpowers:systematic-debugging` before anything else — full
   suite must be green, not just this module.
2. If green: push (`git push -u origin 1139-a-single-flight`), open PR
   (`gh pr create --base main --head 1139-a-single-flight`, title
   `fix(chat): make chat action resolution single-flight (#1518)`, body with scope + spec link +
   VF_EXIT evidence + gate DB name).
3. **Live-path proof**: per the plan's own "Live-path artifact" section this is explicitly NOT a
   new UAT spec file (no chat-capable AI provider in the UAT harness at any seed level, #1121). It
   needs a real live walkthrough (real login, reload, open chat drawer, double-click Approve on a
   real pending action request) posted as a `gh pr comment`. If no live chat-capable instance is
   reachable, report the honest fallback explicitly: **"code-complete, unverified"** with the
   specific reason — this was reconfirmed mid-session as the required behavior, do not skip
   silently.
4. Report to the coordinator (fresh-resolve the `Coordinator` label via `herdr pane list` first):
   PR link, VF_EXIT/gate DB name, live-path status, branch/rebase state, deferred scope (none),
   teardown (no dev instances or seed rows created this session — state that explicitly).
5. Stop. Do not move the board, close the issue, or merge.

## Traps hit this session (worth persisting to memory if not already saved)

- The plan doc's verification commands say `cd /home/ben/Jarv1s && pnpm exec vitest run ...` —
  **do not use that prefix**. This worktree is its own full pnpm workspace root (own
  `pnpm-workspace.yaml`/`package.json`); `cd`-ing to the shared main tree runs against the wrong,
  unedited copy of the files and gives a false green. Run all verification commands directly from
  the worktree cwd.
- `useMutation` requires `QueryClientProvider` in context even for a component's idle/initial
  render — not just when a mutation is in flight. Bit the unit-test harness, not the app (the app
  already has a top-level provider).

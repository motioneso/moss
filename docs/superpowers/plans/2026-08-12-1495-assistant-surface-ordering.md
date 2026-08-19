# Build plan: #1495 assistant-surface claim-before-use enforcement

**Spec:** `docs/superpowers/specs/2026-08-12-1495-assistant-surface-ordering.md` (approved via
Fable design-fork ruling 2026-08-12, Ben's overnight delegation).
**Task issue:** #1495 carries `bug` only — Coordinator to add the `task` label (or file a task
issue) at spawn per the build-needs-task-issue rule.
**Grounded on:** `origin/main` = `2852a12c3`. **Plan author:** Fable (spec-1248 session).

## Seams check

| Assumption                                                                         | Evidence                                                                                      |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `currentSurface` starts `undefined`; seed/turn pass it through unguarded           | `apps/web/src/chat/assistant-surface/handle.ts:55,82-87`                                      |
| `subscribeRecords` falls back to drawer subscription when unclaimed                | `handle.ts:101-104`                                                                           |
| `setSurfaceKey` derives surface only when `moduleId` present; `null` releases      | `handle.ts:74-81`                                                                             |
| Contract doc already mandates claim-first ordering (unenforced)                    | `apps/web/src/chat/assistant-surface/contracts.ts:47-50`                                      |
| Sole handle construction site, host-bound `moduleId`                               | `apps/web/src/app.tsx:374`                                                                    |
| Release-on-unmount calls `setSurfaceKey(null)`                                     | `app.tsx:379-382`                                                                             |
| No in-repo production caller of seed/turn before claim                             | grep this session: only `handle.ts`, `contracts.ts`, tests; `today-page.tsx:183` is a comment |
| Existing handle unit tests (4 `it` blocks; **no** pinning test on `main`)          | `tests/unit/assistant-surface-handle.test.tsx:21,73,97,145`                                   |
| Test cleanup constructs a module-bound handle and calls only `setSurfaceKey(null)` | `assistant-surface-handle.test.tsx:15-18` (unaffected by the change)                          |

No open questions.

## Determinism boundary

No model contact anywhere in this change: no prompts, no model jobs, no AI-visible text. The
thrown error message and `console.error` are developer-facing strings rendered from constants.

## Phase 1 (only phase) — enforce at the handle

**Task 1:** `handle.ts` — module-bound (`moduleId` set) and `currentSurface === undefined`:

- `seedContext`/`submitTurn` reject with `Error` (message names the contract and the module id).
  No exported error class — callers have no legitimate branch on it.
- `subscribeRecords` returns a shared no-op unsubscribe, never calls the host `subscribeRecords`,
  and emits one `console.error`. Signature unchanged.
- `setSurfaceKey`, drawer-bound behavior (`moduleId` absent), `seedComposer`,
  `uploadAttachment`: unchanged.

**Task 2:** `contracts.ts:47-50` — extend the existing ordering doc-comment to state the
enforcement (rejects / no-op subscribe), so the contract doc and behavior can no longer diverge.

**Task 3:** tests in `tests/unit/assistant-surface-handle.test.tsx`, per spec acceptance
criteria; each catches a specific broken implementation:

- unclaimed module-bound seed/turn rejects **and fetch mock is never called** — catches a guard
  that throws after firing the request, and catches absent enforcement;
- unclaimed module-bound `subscribeRecords` never reaches the host subscription and
  `console.error` fired — catches the drawer-fallback path surviving;
- claimed handle: existing tests `:73,:97,:145` pass unchanged — catches over-broad guarding;
- after `setSurfaceKey(null)`, seed/turn reject again — catches release restoring the drawer
  fallback instead of the unclaimed state (spec AC 4);
- drawer-bound handle seed/turn/subscribe unchanged (`:21` extended if needed) — catches the
  guard leaking onto the drawer path.

**E2e for this phase:** the existing Playwright e2e suite green (proves the drawer and module
mount paths still work through real wiring), plus the unit tests above running against the same
`createAssistantSurfaceHandle` call shape as `app.tsx:374` (module-bound with host `moduleId`).
No live-path gate: no user-visible behavior changes on any live path — no in-repo module
mis-orders today (seams table row 7); the change is a guard on a path nothing legitimate takes.
State this plainly in the PR: user-visible = nothing.

**KILL GATE (owner: Coordinator overnight, Ben by digest).** After merge, on the live dev
instance: open the Today page and each installed module UI, exercise drawer chat. The observation
that ends the line: a legitimate module pattern needs subscribe-before-claim (module UI blank or
console contract-errors on a correctly-written module). Rollback is a one-commit revert —
frontend-only, no migration.

## Verification (unpiped; expected `EXIT=0`)

Use the `verify-gate` skill (isolated gate DB).

```bash
pnpm verify:foundation > /tmp/vf-1495.log 2>&1; echo "EXIT=$?"
```

Note the `.tsx`-not-typechecked trap (memory `tsx-tests-not-typechecked`, #1335): also run the
web app typecheck directly:

```bash
pnpm --filter @moss/web typecheck > /tmp/tc-1495.log 2>&1; echo "EXIT=$?"
```

(Build agent: verify that filter name against `apps/web/package.json` first; a wrong `--filter`
matches nothing and exits 0 — memory `pnpm-filter-test-is-a-false-green`.)

## Rulings ledger

- Fable 2026-08-12 (delegated): fail closed — writes reject loudly, reads no-op empty with
  `console.error`, drawer-bound handles untouched. Doc-note-only option rejected.
- Fable 2026-08-12: read-side gap (`subscribeRecords` drawer fallback, `handle.ts:101-104`)
  pulled into scope — same root hole as #1495's write-side, worse leak direction.
- Fact: #1495's cited pinning test is absent from `main`; it lives only on held PR #1493's
  branch. Grep + test-file listing this session.
- Fact: zero in-repo production callers of seed/turn/module-bound-subscribe before claim;
  job-search's `useProfileThread` was removed with the Job Search cancellation.

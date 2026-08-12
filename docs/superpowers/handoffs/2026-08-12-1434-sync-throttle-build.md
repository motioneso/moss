# Build Handoff — 1434-sync-throttle

**Spec:** none — mechanically-tiered small fix, no new feature/module (already classified this way
in `docs/coordination/2026-08-10-overnight-run.md` → "Ready-after-current lanes"). Do not write a
spec doc; build directly against the issue + the Fable ruling below.
**GitHub issue:** #1434 — "Page-context sync throttle resets on every navigation, bursting past the
20/min chat-mutation limit (429s in normal browsing)"
**Risk tier:** `security` (rate-limit-adjacent behavior). QA on this PR will be Opus adversarial +
requires Ben (or delegated Fable) merge sign-off — but the design question itself is ALREADY
RULED, see below. You do not need a fresh design approval; you need coordinator plan approval on
implementation only.
**Worktree:** `.claude/worktrees/1434-sync-throttle` **Branch:** `1434-sync-throttle` off
`origin/main`
**Build skill path (absolute):** `.claude/skills/coordinated-build/SKILL.md`
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; resolve the pane fresh
each time (never a cached pane number).
**Coordinator session id:** `0bb9f516-c026-454f-bc97-dc9faf43bd20` (immutable authority).
**Relay trigger:** context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Design ruling — ALREADY DECIDED, build to this exactly

Fable ruled (delegated authority, posted at
https://github.com/motioneso/moss/issues/1434#issuecomment-5263202454): **APPROVED —
log-only/no-retry.** On rate-limit fallback, do NOT retry — a 429-retry would soft-bypass the
shared 20/min `CHAT_MUTATION_MAX` bucket and starve foreground chat. Emit a single
`console.warn` (no silent swallow); recovery happens via the next naturally-triggered fresh
capture.

Binding constraints on the two-file fix
(`apps/web/src/chat/use-page-context-sync.ts` + its test):
- Set `lastUploadAt` **before** the upload attempt — a failed attempt still consumes the client's
  rate-limit window; never refund on failure.
- Hoist throttle state to a `useRef` so it survives the route-keyed effect and correctly respects
  the remaining min-interval on mount-after-navigation (this is the actual bug — state was being
  reset on every navigation instead of persisting).
- No changes to the shared `CHAT_MUTATION_MAX` budget or limiter itself.
- Add a unit test covering: (a) min-interval survives a resubscribe/remount, (b) the log-only,
  no-retry failure path.

## Start

1. `[ -d node_modules ] || pnpm install`
2. Read issue #1434 and the Fable ruling comment above in full — that IS your spec for this lane.
3. Invoke **`coordinated-build`**: plan with **`plan-build`** (scope is small — plan should be
   short) → coordinator approval → TDD build → **`coordinated-wrap-up`** (PR + live-path proof +
   report). This touches a user-facing throttle behavior but has no new UI surface — confirm with
   the live-path-gate section of `coordinated-wrap-up` whether a UAT proof is required or whether
   the unit test + gate green is sufficient for a pure internal-behavior fix; if unsure, ask the
   coordinator rather than guessing.

## Exit criteria

- Both binding constraints above implemented exactly as ruled.
- Unit test covering both cases passes.
- Full gate green on an isolated gate DB.
- PR open, rebased on `origin/main`, security tier — flag for Opus QA + delegated-Fable-or-Ben
  merge sign-off (Ben has delegated all approvals tonight to Fable — coordinator will route this).

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes

- None known. `use-page-context-sync.ts` is not currently touched by any other active lane.

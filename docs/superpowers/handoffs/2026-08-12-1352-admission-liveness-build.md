# Build Handoff — 1352-admission-liveness

**Spec:** locked admission-liveness spec, §4.1.0a — the frozen clause "never the engine Map" is
being **amended in this same PR** per the ruling below (not overridden silently — the spec text
itself changes).
**GitHub issue:** #1352 — read it in full, plus the ruling comment
(https://github.com/motioneso/moss/issues/1352#issuecomment-5263238761).
**Risk tier:** `sensitive` (liveness/admission-control correctness, cross-cuts engine kinds
including #1557's landed `ClaudePersistentRuntimeEngine`). Escalate to `security` if you find the
fix touches auth/session admission rather than pure liveness counting.
**Worktree:** `.claude/worktrees/1352-admission-liveness` **Branch:** `1352-admission-liveness`
off `origin/main`
**Build skill path (absolute):** `.claude/skills/coordinated-build/SKILL.md`
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; resolve pane fresh.
**Coordinator session id:** `0bb9f516-c026-454f-bc97-dc9faf43bd20`.
**Relay trigger:** context-meter 70% warning, or a compaction summary → message coordinator, use
`relay` skill.

## Design ruling — ALREADY DECIDED, build to this exactly

Fable ruled **APPROVED WITH NAMED MODIFICATIONS** (delegated authority):

- The #1352 bug is real on current `main`. The originally-proposed fix shape ("derive liveness
  from the engine registry rather than mux enumeration") contradicts the spec's frozen §4.1.0a
  clause "never the engine Map" — do NOT build it that way.
- **Approved form:** strict fail-closed **widening** —
  `liveKeys = mux enumeration ∪ reservations ∪ engine-registry keys`
  — union, not replacement. Amend the spec text (§4.1.0a) in this same PR to describe the widened
  rule; don't leave the doc contradicting the code.
- **Binding constraints:**
  1. Counting must be **engine-kind-agnostic** — it must also correctly cover #1557's
     `ClaudePersistentRuntimeEngine` (creates no mux session) without relying on the RPC root's
     `persistentRuntimeEnabled: false` pin as a crutch.
  2. Post-#1557 naming: use `isBoundedFallbackEngine` (not older/alternate names you may find in
     the codebase).
  3. Orphan reaping **stays mux-scoped** — do not widen the reaper to the registry/reservations,
     only the liveness count.
  4. The `beginLogin` gate coupling to liveness is **intentional** (§L.6.1) — must be covered by a
     test, not "fixed" as if it were a bug.
- No conflict with #1557's landed contract: `chat.persistent_runtime.enabled` is a live per-launch
  flag read, not boot-frozen — build agent is unblocked to proceed tonight.

## Start

1. `[ -d node_modules ] || pnpm install`
2. Read issue #1352 + the ruling comment + spec §4.1.0a in full.
3. Invoke **`coordinated-build`**: plan with **`plan-build`** → coordinator approval → TDD build →
   **`coordinated-wrap-up`** (PR + report).

## Exit criteria

- `liveKeys` widened exactly as ruled (union, fail-closed); spec §4.1.0a text amended to match.
- Engine-kind-agnostic counting verified against `ClaudePersistentRuntimeEngine` specifically.
- Orphan reaping unchanged (still mux-scoped only) — add a regression test proving this.
- `beginLogin`/liveness gate coupling covered by a test asserting it's intentional (§L.6.1).
- Full gate green on an isolated gate DB. PR open, rebased on `origin/main`, sensitive tier.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes

- Touches engine/liveness code that #1557 (already merged) also touched — rebase carefully, read
  #1557's landed diff for the current `isBoundedFallbackEngine`/registry shape before writing the
  plan, don't assume the pre-#1557 shape described in older issue comments.

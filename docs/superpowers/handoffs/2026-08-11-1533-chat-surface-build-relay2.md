# Relay 2 — #1533 chat-surface routing build

Continuation of `docs/superpowers/handoffs/2026-08-10-1533-chat-surface-build.md` (Start/Exit
criteria/Collision notes still apply verbatim) and
`docs/superpowers/handoffs/2026-08-10-1533-chat-surface-build-relay.md` (superseded — its "Next
action" is done).

## Status

- **Plan-build plan — DONE and DOUBLY APPROVED.**
  `docs/superpowers/plans/2026-08-10-1533-chat-surface-send-routing.md`, committed `83ccac7a5`.
  Coordinator (`coord-relay`, session `019fef6b-8f40-7453-a6f9-4c3e245dce52`) approved it
  unchanged. Ben then also approved explicitly: "Plan approved as written. Proceed Phase 1 through
  Phase 4 within the nine-file allowlist. Treat the Phase 1 focused tests as the kill gate;
  preserve the atomic surface-reset and all four stale-completion guards in Phase 2; keep
  ChatModelPill assertions in the new .tsx runtime call-argument suite; finish with the sensitive
  live-path proof and draft PR."
- **No implementation code written yet.** No test files created yet. This relay fired purely on
  the context-meter 70% warning immediately after approval landed — do not re-litigate the plan or
  re-verify the spec, both are settled.
- `node_modules` already installed — do not re-run `pnpm install`.

## Next action

Proceed straight into **Phase 1** of the plan (`coordinated-build` steps 2–4: TDD build →
self-monitor → `coordinated-wrap-up`). No further Coordinator/Ben check-in is needed before
starting code — both approvals are already in hand and Ben named the phase-by-phase execution
explicitly. Do still message Coordinator (`coord-relay`, confirm session id
`019fef6b-8f40-7453-a6f9-4c3e245dce52` via fresh `herdr pane list`/`herdr agent list` — names can
be reused by a newer agent, re-resolve) at the Phase 1 kill gate and again before opening the draft
PR (per `coordinated-build`), not before every phase.

Read the plan file in full once (319 lines) — it has every signature, test case, verification
command, and kill-gate owner for all 4 phases; it embeds the seams-check citations so the spec
itself does not need re-reading except for the two sections the plan doesn't fully restate:
"Privacy and security invariants" (spec lines 191-209) and "Live-path proof" (spec lines 296-319,
needed only at Phase 4). Do not re-read the full spec otherwise.

Phase order and kill gates are in the plan itself — follow it as written:

1. **Phase 1** (surface-prop threading + private-chat gating) — kill gate: extended
   `app-shell-chat-surface.test.tsx` + new `chat-drawer-surface.test.tsx` (routing half) must pass,
   named owner "whoever is driving this build lane."
2. **Phase 2** (atomic surface-reset effect + 4 stale-completion guards: send, resume,
   private-activate, Stop-drain) — kill gate: surface-flip cases must pass without introducing a
   second surface source (context/store), which the spec forbids.
3. **Phase 3** (`ChatModelPill` surface + `switchChatProvider` client param + new
   `chat-model-pill-surface.test.tsx` with runtime call-argument assertions per Fable's
   requirement) — kill gate: stay inside the 9-file boundary.
4. **Phase 4** (full focused suite + `pnpm verify:foundation` gate under the coordinator's
   exclusive slot/isolated DB — use the `verify-gate` skill, never run ad hoc — + live-path proof
   via job-search "Change in chat" + draft PR via `coordinated-wrap-up`; do not merge).

## Ground truth

- Branch: `build/1533-chat-surface-routing`. Latest commit `83ccac7a5` (plan only, no code).
- Merge-base with `origin/main` was `abfe0478b` at last check (2026-08-10) — re-check with
  `git merge-base HEAD origin/main` if stale.
- Coordinator: label `Coordinator`, registered agent name `coord-relay` (may change — re-resolve),
  session id `019fef6b-8f40-7453-a6f9-4c3e245dce52`.
- This session's own registered agent name was `chat-surface-1533` (relay target Coordinator used
  for its reply) — a fresh continuation session will get a new name; re-resolve your own identity
  via `herdr pane list` if you need to tell Coordinator where to reply.

# Build Handoff — 1554-persistent-provider-chat-runtime

**Spec:** `docs/superpowers/specs/2026-08-10-1554-persistent-provider-chat-runtime.md` — approved
2026-08-12 by Fable review (Ben has delegated spec/plan sign-off to Fable this run; this stands in
for his explicit approval). Read the spec in full before starting — it is dense and every
constraint in it is deliberate (see its own dispositions ledger against the Codex adversarial
review at `docs/coordination/2026-08-10-1553-1554-codex-review.md` — all 11 findings there are
already folded into the spec text, do not re-litigate them).
**GitHub issue:** #1554 — `gh issue view 1554 --repo motioneso/moss --comments`. Currently labeled
`needs-spec`; that label is stale now that the spec is approved — leave it, do not edit labels
yourself (coordinator/Ben bookkeeping).
**Risk tier:** `sensitive` — CLI runner + runtime session/process lifecycle (explicit sensitive-tier
trigger). Standard QA plus explicit invariant check plus matched e2e-UAT; auto-merges after green
QA with a per-merge digest to Ben (no explicit sign-off gate — that's security-tier only).
**Worktree:** `.claude/worktrees/1554-persistent-provider-chat-runtime`
**Branch:** `1554-persistent-provider-chat-runtime` off `origin/main` (current HEAD `33f57b1fa`,
confirmed CI-green on `main` before this spawn)
**Build skill path (absolute):** `.claude/skills/coordinated-build/SKILL.md`
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; resolve pane fresh.
**Coordinator session id:** `0bb9f516-c026-454f-bc97-dc9faf43bd20`.
**Relay trigger:** context-meter 70% warning, or a compaction summary → message coordinator, use
`relay` skill.
**Plan/spec sign-off routing (new this run):** any plan-ready escalation or design-fork you'd
normally send to the coordinator for approval goes through a Fable-model review now, same as
security-tier QA already does — flag it to the coordinator, the coordinator will route it, you
don't need to do anything different on your end beyond escalating as usual.

## Non-blocking notes carried over from Fable's spec review (apply during build, no spec change needed)

- Criterion 1's live proof: verify real reply records exist in the transcript, not just an HTTP 200
  — this repo has been burned by exactly that gap before (a 182.6s "latency" that was actually a
  silent no-response).
- The `--no-session-persistence` + persistent stream-JSON input interaction is a bounded phase-1
  verification with both branches already fully specified in the spec (fallback: fresh
  `--session-id` per launch + purge on every termination path) — this is not an open fork, just
  confirm which branch is true in this environment and proceed.
- All-4-children-busy intentionally re-opens the churn window for one turn (falls back to one-shot)
  — this is a decided trade-off per the spec, not a bug to fix.

## Known light collision note

#1256 (confirmation-registry-bypass, lane `confirmation-relay2`, worktree
`.claude/worktrees/1256-confirmation-registry-bypass`) is concurrently editing
`packages/chat/src/routes.ts` (adding an `adoptChatGateway` callback near the existing
`adoptChatRpcConnection`/`adoptDropSessionsForProvider` passthroughs) and
`packages/module-registry/src/index.ts`. Your spec's engine-selection/session-manager work is a
different seam in the same package — check `packages/chat/src/routes.ts` and
`packages/module-registry/src/index.ts` for conflicts before touching them, and rebase onto
`origin/main` before opening your PR in case #1256 lands first.

## Start

1. `pnpm install`
2. Read issue #1554 in full, then the spec in full (it's long — that's expected here, unlike most
   handoffs; the spec itself carries the design detail this time).
3. Invoke **`coordinated-build`**: plan with **`plan-build`** (this spec likely wants a
   multi-phase plan given its scope — engine-selection pooling, session-manager state machine, MCP
   admission gating, bounded stream decoder are each substantial) → coordinator approval (routed to
   Fable) → TDD build → **`coordinated-wrap-up`** (PR + report).

## Exit criteria (from spec's acceptance criteria — read the spec for the authoritative list)

- Live-path proof required (criterion 7 in the spec) — this is a user-facing runtime behavior
  change, not an internal-only contract fix; do not skip the live UAT gate.
- Full gate green on an isolated gate DB (`verify-gate` skill). PR open, rebased on `origin/main`,
  sensitive tier.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

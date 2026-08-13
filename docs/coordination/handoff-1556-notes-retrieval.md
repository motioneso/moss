# Build Handoff — 1556-notes-retrieval

**Spec (approved):** docs/superpowers/specs/2026-08-10-1553-context-continuity-and-notes-retrieval.md
(revised 2026-08-10 after Codex adversarial review; dispositions in
`docs/coordination/2026-08-10-1553-1554-codex-review.md`)
**GitHub issue:** #1556 — "Phase 2: add notes-default retrieval after bounded replay (#1553)"
**Risk tier:** `sensitive` — this touches the notes-recall port consumed by `PassiveContextRetriever`
and must fail-closed on credential filtering and server-truth incognito/`recallEnabled` gating
(cross-module contract change, RLS-adjacent data path). Standard QA **plus** explicit invariant
check **plus matched e2e-UAT**; per-merge digest to Ben, no Ben sign-off pause required (that's
`security` tier only — this is `sensitive`).
**Worktree:** /home/ben/Jarv1s/.claude/worktrees/coord-overnight-20260810/.claude/worktrees/1556-notes-retrieval
**Branch:** 1556-notes-retrieval (off origin/main, includes the 2026-08-12 screenshot-requirement
removal from the Live-Path Gate — no screenshot needed, UAT run + exit code + bounded
assertions/DOM/network/log evidence is sufficient)
**Build skill path (absolute):** /home/ben/Jarv1s/.claude/worktrees/coord-overnight-20260810/.claude/skills/coordinated-build/SKILL.md
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; verify `herdr pane list`
shows exactly one pane with this label before messaging (resolve fresh, never a cached pane id).
**Coordinator session id:** `0bb9f516-c026-454f-bc97-dc9faf43bd20`
**Relay trigger:** context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Design decision (already made — do not re-litigate)

Phase 1 (bounded DB-transcript replay on engine launch) is already merged: PR #1562, live UAT
proof, 1 passed / 8.0m. This lane is **Phase 2 only**: notes-default retrieval — a declared public
notes-recall port consumed by `PassiveContextRetriever`, with fail-closed credential filtering and
server-truth incognito/`recallEnabled` gating. Vendor-neutral; no thread-visible recovery prose.
Read the spec's Phase 2 section for the exact contract — do not re-derive it from Phase 1's PR.

User-facing summary (for your PR description / release note): Moss remembers your conversation
across sessions and answers from your notes by default — without you naming the note.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. Read the spec **by section** — Phase 2 only — plus the Codex review dispositions doc for any
   Phase-2-relevant findings. Never read the whole spec file; that bloats a fresh context toward a
   premature relay before any code is written.
3. Invoke **`coordinated-build`**: verify spec vs. branch → plan with **`plan-build`** (includes
   the timeboxed search-quality research step per the spec) → coordinator approval (do NOT write
   code first) → TDD build → **`coordinated-wrap-up`** (PR + live-path proof + report).

## Exit criteria

- Spec Phase 2 exit criteria met, full gate green on an isolated gate DB.
- PR open, rebased on `origin/main`.
- Live-path proof posted (`gh pr comment`): UAT run, exit code, and bounded assertions/DOM/
  network/log evidence that notes-default retrieval actually answers from a note without it being
  named, that credential filtering fails closed, and that incognito/`recallEnabled` gating is
  server-truth (not client-trusted).

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path only.
- Never touch `docs/coordination/`, the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.
- Do not re-add `workspaceId` to `AccessContext` — removed on purpose in Slice 1f.
- Module isolation: PassiveContextRetriever integration goes through declared public APIs only —
  never reach into another module's internals or tables directly.

## Collision notes

- None known. Phase 1 (PR #1562) is already merged and stable — build on top of it, don't
  re-touch its bounded-replay code unless Phase 2 genuinely requires it.
- #1248 (separate issue, vault-ingestion gap) shares conceptual territory (both touch
  retrieval/context) but is unowned, unscoped, and not part of this lane — do not expand scope to
  cover it.

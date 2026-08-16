# Build Handoff — 895-required-status-checks

**Spec (approved):** docs/superpowers/specs/2026-08-15-895-required-status-checks.md
**GitHub issue:** #895 (label: task)
**Risk tier:** `sensitive` — **coordinator override, not the spec's self-assigned `routine`.** This
is a CI/build-pipeline change that becomes the sole merge gate going forward; that's a `sensitive`
trigger per the coordinate skill's tiering rubric even though it touches no runtime code or data.
**Worktree:** ~/Jarv1s/.claude/worktrees/build-895-required-ci-gate
**Branch:** build-895-required-ci-gate (off origin/main @ f31a840e9)
**Build skill path (absolute):** ~/Jarv1s/.claude/skills/coordinated-build/SKILL.md
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; before messaging, verify
`herdr pane list` shows EXACTLY ONE pane with this label, resolved fresh each time.
**Coordinator session id:** `91a78602-812a-461e-afa4-5498bb9000c5` (immutable authority; label is
only routing).
**Relay trigger:** context-meter 70% warning, or a compaction summary in your own context → message
the coordinator, then use the `relay` skill immediately.

## Scope — build the CI job only; the branch-protection ruleset is Ben-gated

- **In scope (THIS BUILD):** add one new `ci-gate` job to `.github/workflows/ci.yml` — name it
  `CI gate`, `if: always()`, `needs: [changes, docs-gate, verify, compose-smoke,
  prod-compose-smoke]` (these five job ids exist on `origin/main` as of `f31a840e9` — confirm
  they still do when you start). Fail closed on anything outside `success`/`skipped` for any needed
  job. Also apply the doc corrections the spec calls for in the two plan files and
  `.claude/skills/coordinate/SKILL.md`.
- **Out of scope, Ben-gated:** actually applying the branch-protection ruleset that makes `CI gate`
  required (the spec's Forks 1/3/4 — no forced-rebase-before-merge, no bypass actors, hard block).
  Ben already approved these defaults via the coordinator's Telegram summary — but the ruleset
  itself must not be applied by you or by the coordinator until `CI gate` has reported at least
  once on `main` (otherwise every open PR, including the parallel #1589 lane, hangs on "Expected —
  waiting for status"). The coordinator will apply the ruleset after this PR merges and `CI gate`
  has run on `main` once.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. Read the spec BY SECTION for your current task only — never in full.
3. Invoke **`coordinated-build`**: plan with **`plan-build`** → coordinator approval → TDD build →
   **`coordinated-wrap-up`** (PR + live-path proof if applicable + report).

## Exit criteria for this lane

- New `CI gate` job present, correctly wired to the five existing job ids, fails closed.
- Full gate green on an isolated gate DB; the new job itself visibly runs and passes on your PR.
- PR open, rebased on `origin/main`.
- No UI surface touched — live-path proof not applicable; say so explicitly in the wrap-up report.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- Do NOT apply or touch branch-protection rulesets — that's coordinator/Ben territory, after merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- No file-level overlap with the parallel #1589 lane (that lane touches only
  `packages/memory/src/repository.ts` and its tests). No migration number assigned by either spec.

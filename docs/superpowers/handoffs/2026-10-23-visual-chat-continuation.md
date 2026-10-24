# Visual chat continuation after server restart

## Assignment and authority

Ben requested a fresh session to continue visual chat after a server restart. Continue the
approved staged implementation, starting with the remaining stage-1b host integration.
The immediate slice is one explicitly labeled user-supplied-data composition from real prompt
through tool proposal, validation, persistence, rendering and reload. Do not repeat completed
parent reviews or expand into domain families before the stage-1 gate passes.

## Start

1. Stay in your isolated worktree, `~/Jarv1s/.claude/worktrees/visual-chat-continuation`, branch
   `feat/visual-chat-continuation`. Others work in this repository; do not revert their edits.
2. Run `pnpm install --frozen-lockfile`. Read `AGENTS.md`, `CLAUDE.md`,
   `docs/DEVELOPMENT_STANDARDS.md` and `.claude/skills/plan-build/SKILL.md`.
3. Read the approved spec, staged plan, runtime evidence and earlier task plans linked below.
   Search Hindsight for decisions, verify against current code, and prefer the codebase graph
   for code discovery. Check live #3583, #3589 and #3591 and any newer PRs before assigning work.
4. Write and commit a bounded implementation plan linked to the appropriate GitHub task before
   code. Existing approval covers continuing the staged implementation; resolve routine choices
   without asking again. Record any genuine scope/renderer decision for Ben.
5. Implement the next slice, verify it through the real installed dev UI, obtain independent
   code review, resolve findings, and merge only after all required gates pass. Ben already
   requested independent review and merging. Do not close the umbrella while later stages remain.

## Completed checkpoint

The previous session independently reviewed and merged the entire parent stack:

- #3593: internal `chat.present` and lifecycle wiring, merged through #3590.
- #3585: spec, targets, staged plan and isolated OpenUI runtime experiment. Squash merge
  `ecf52b03e618475c17734719a3de86784ba46dd3`.
- #3590: contracts, turn registry and #3593 wiring. Squash merge
  `6780160bb49ccbe3c59eb8514f4eba49758ca56c`.

Both parent merge commits were verified as ancestors of fetched `origin/main` at this handoff.
Final reviewed heads: #3585 `2a1c711e41042415c6965aaa6fd9d57af48bcb3e`,
#3590 `bfc14ff14e9c49ac992ebf18b188c4eea3b020a6`.
Standards and spec reviewers approved both exact heads with no unresolved findings.
Final CI runs 40018615704 and 40018622351 each had 19 successful checks and 3 intentional skips.
The previous worktree was clean at `a12f5e4ea56c203a285565f8bb83304b54ac0a2e`.

Resolved findings: `chat.present` declares `content: "outside"` for fallback provenance;
the runtime guard consumes a complete fixed grammar rather than merely balancing tokens;
visual interaction IDs must be unique. Focused runtime/contracts/registry tests: 74 passed.
Browser provisioning now shares `scripts/prepare-browser-apt-mirror.py` to avoid the slow Azure
Ubuntu archive. Do not undo these fixes or repeat unchanged failed CI retries.

## Remaining integration and acceptance

Production visual context is still uninstalled. Internal foundations do not constitute stage-1
completion. Implement semantic/catalog validation, production tool context/engine wiring,
validation before save, envelope persistence, shared/live/history DTOs and reducers, and a
lazy-loaded frontend visual slot with an error boundary. Preserve useful fallback text,
copy/export, incognito, deletion and text-only destinations. Update app-map declarations with
actual available behavior in the same product PR. Never import production code from `spikes/`.

Capture actor/thread/turn identity on the host; the model cannot choose it. Cancellation,
failure and thread switching must discard or isolate pending visuals. Final publication uses
the saved reply identity. Keep source facts and authority outside the renderer.

Required real installed-dev Playwright evidence: prompt -> proposal -> saved reply -> render ->
reload/reconnect/copy, plus cancellation/failure/thread-switch checks. Before domain rollout,
run 20 fixed prompts per rollout engine/provider, including novel compositions, plain prose and
explicit text-only: at least 19/20 intended visuals on first attempts and 20/20 useful text.
Measure overhead, latency and app bundle delta. If that gate fails, record a recommendation on
#3583 and stop domain rollout; Ben decides renderer or scope changes.

Later stages remain: authorized sourced read-only families (Sports/Weather first),
conversational controls, then actions and all eight families. Follow the approved plan rather
than treating this handoff as approval to skip their acceptance gates.

## References

- `docs/superpowers/specs/2026-10-23-visual-chat-replies.md`
- `docs/superpowers/specs/visual-chat-replies/targets.html`
- `docs/superpowers/plans/2026-10-23-visual-chat-replies.md`
- `docs/research/2026-10-23-visual-chat-runtime-evaluation.md`
- `docs/superpowers/plans/2026-10-23-visual-chat-contracts.md`
- `docs/superpowers/plans/2026-10-23-visual-chat-present-tool.md`
- Earlier handoff `docs/superpowers/handoffs/2026-10-23-visual-chat-present-tool.md` is historical;
  its unmerged-stack instructions and merge prohibition are superseded by the completed merges
  and Ben's later review/merge authorization.
- Main code: `packages/shared/src/visual-chat.ts`, `packages/chat/src/visual/turn-registry.ts`,
  `present-tool.ts` and `presentation-service.ts` in the same visual directory.

## Operating notes

Use repo design-system skill before UI work and verify-gate skill before any DB/full gate.
Use `scripts/run-gate.sh start` and its documented sentinel wait; no bare full-gate command.
Commit explicit paths, push durable work, and finish clean. Claim dev ports with `devports`
(5180–5299), release them and stop servers/browser resources you start. No production port.
Use bounded reads and cropped screenshots; after two identical failures, rethink.
Keep a small durable state note during work. Do not clean other agents' worktrees.

Herdr is working again after restart. The old temporary boot file no longer exists; this
committed handoff replaces it. No old servers or browser resources need preserving.
For PR edits, `gh pr edit` previously failed on deprecated Projects Classic GraphQL; REST PATCH
with a JSON body worked. Merge with `gh pr merge --squash --match-head-commit <sha>`, without
admin override or branch deletion. Keep docs free of credentials and private hostnames.

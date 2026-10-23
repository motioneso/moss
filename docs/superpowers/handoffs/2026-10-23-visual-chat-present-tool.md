# Handoff: chat.present tool and per-turn registry wiring

Task: [#3591](https://github.com/motioneso/moss/issues/3591) (stage 1b.2), part of
[#3583](https://github.com/motioneso/moss/issues/3583). Builds on
[#3589](https://github.com/motioneso/moss/issues/3589), draft
[PR #3590](https://github.com/motioneso/moss/pull/3590) (branch `feat/visual-chat-contracts`),
which is stacked on [#3585](https://github.com/motioneso/moss/pull/3585).
You branch from `feat/visual-chat-contracts` at its pushed head.

## Start

1. Work only in `~/Jarv1s/.claude/worktrees/visual-chat-present-tool`, branch
   `feat/visual-chat-present-tool`. Others share the repository; do not revert their changes or
   touch another agent's tree.
2. Run `pnpm install --frozen-lockfile`. Read `AGENTS.md`, `CLAUDE.md`,
   `docs/DEVELOPMENT_STANDARDS.md` and `.claude/skills/plan-build/SKILL.md`.
3. Read in full: the [spec](../specs/2026-10-23-visual-chat-replies.md), the
   [staged plan](../plans/2026-10-23-visual-chat-replies.md), the
   [stage-1b.1 task plan](../plans/2026-10-23-visual-chat-contracts.md), the
   [stage-1a evidence](../../research/2026-10-23-visual-chat-runtime-evaluation.md), then
   `packages/shared/src/visual-chat.ts` and `packages/chat/src/visual/turn-registry.ts`.
4. Search Hindsight knowledge pages for relevant decisions; use the codebase-memory graph for
   code discovery. Do not import anything from `spikes/`.
5. Write a bounded task plan under `docs/superpowers/plans/`, commit it before code, then build.
   Approval for this bounded task exists; do not wait for another round. Do not delegate.
6. Verify, commit, push, and open a draft PR against `feat/visual-chat-contracts` while #3590 is
   unmerged (inspect history first if it has merged). Record the dependency in the PR.

## Scope (stage 1b.2 only)

- Register read-only `chat.present` through the existing assistant-tool catalog
  (`packages/ai/src/assistant-tools.ts` and the manifest path). It takes a proposal, runs
  `VisualTurnRegistry.finalize`, and returns either a trusted reply or a readable-text fallback.
  It fetches nothing, writes nothing, and creates no authorization.
- Create one `VisualTurnRegistry` per turn from host-captured actor, thread and turn identity in
  the chat turn lifecycle (see `packages/chat/src/live/chat-session-turn.ts`). Close it after the
  reply commits; discard it on cancel or failure. The model never supplies identity.
- Provide one explicitly labeled user-supplied data path ("Your data" / "Example" origin) so a
  novel composition can be proven without module reads.
- Invalid proposals fall back to prose with no automatic model retry. No raw program text is
  shown as the answer.
- Resolve the plan's open seams by observation, with file:line evidence recorded in your plan:
  which engines can admit a read-only tool, and where per-turn context can be injected without
  being model-controlled. If a seam is missing, stop that part, record it on #3591, and keep the
  rest internal.

## Exclusions

No persistence or metadata, no shared/live DTO or history fields, no reducers, no frontend
rendering, no module data reads (sports, weather, finance), no flags, no 20-prompt engine gate,
no action or approval changes. Do not claim authorization, renderer safety, or production
support. If your change creates a visible capability, stop expanding; product changes need
same-PR app-map updates (`packages/shared/src/app-map-core.ts` or the owning manifest). Do not
merge, deploy, or close #3583 or #3591.

## Boundaries to keep

Provider-agnostic AI (never hardcode a model). Metadata-only job payloads. Secrets never reach
prompts or snapshots. The model has two jobs only: decide if a visual helps and arrange approved
components, and write concise interpretation. Host code owns facts, statuses and fallback.
Guidance you add to the model stays under 150 words.

## Verification and delivery

Unpiped commands with exit codes: focused vitest for new code; `pnpm exec tsc --noEmit`; the
owning packages' typecheck; scoped ESLint with `--max-warnings=0`; Prettier; `pnpm check:file-size`.
For each security boundary you claim, remove the guard, observe the test fail, restore, rerun, and
record exactly what was tested. Never run `pnpm verify:foundation` or any DB-touching command
without reading `.claude/skills/verify-gate/SKILL.md`. If the tool path needs a database test,
follow that skill. Use `~/Jarv1s` in docs and check for secrets or private hostnames before commit.

Finish clean and pushed: task-linked draft PR, `Category: N/A` release note (unless a visible
capability appears), evidence, negative-control results and the remaining integration work.
Comment on #3591 and link from #3583. Stop anything you start; claim any port with `devports`.

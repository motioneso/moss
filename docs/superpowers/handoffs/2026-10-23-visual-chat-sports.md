# Visual chat: Sports, then the remaining approved roadmap

## Assignment and authority

Ben requested continuing the broader visual-chat features in fresh sessions. Implement the
next bounded slice, obtain independent code review, resolve findings, verify and merge it,
then launch the next session. Repeat through the approved roadmap. This is explicit authority
to implement, spawn successors/reviewers and merge after the required gates; routine choices
do not require another permission request. A failed acceptance gate is not permission to waive
it or change the renderer/product scope.

Your immediate task is [#3629](https://github.com/motioneso/moss/issues/3629), part of
[#3583](https://github.com/motioneso/moss/issues/3583): sourced read-only Sports results and
real team logos. Weather is the next fresh session after this slice merges. Keep slices small
enough for one implementation context; preserve progress externally during long gates.

## Start

1. Stay in your isolated worktree `~/Jarv1s/.claude/worktrees/visual-chat-sports`, branch
   `feat/visual-chat-sports`. Other agents work in this repository; accommodate their changes
   and never revert their work. Set the session title to `visual-chat-sports`.
2. Run `pnpm install --frozen-lockfile`. Read `AGENTS.md`, `CLAUDE.md`,
   `docs/DEVELOPMENT_STANDARDS.md` and `.claude/skills/plan-build/SKILL.md` in full.
   Use the repo design-system skill before UI work and verify-gate before DB/full tests.
3. Read the approved spec and staged plan in full, inspect the target board, and read the
   runtime evaluation and #3603 final receipt linked below. Search Hindsight decisions and
   check them against current code. Prefer codebase graph tools; use bounded fallback if
   unavailable. Check live #3583/#3629, main and newer PRs for overlapping work before coding.
4. Establish the actual supported rollout configuration and its stage-1 evidence. #3603's
   case-by-case configured-Codex acceptance is the starting evidence, not blanket acceptance
   for every provider or side-chat surface. Close material gaps affecting this slice before
   domain rollout. Unsupported/unverified configurations retain truthful fallback. Record
   the scoped rollout and remaining matrix on #3583; do not check off all of 1b by assumption.
5. Prove the current seams and commit a bounded, task-linked implementation plan before
   production code. State host/model ownership, public module boundaries, behavioral tests,
   real installed UI cases and the kill gate. Existing spec approval covers this work.
6. Implement Sports only, update the app map, exercise the installed feature, independently
   review, fix findings, run the required gates and merge using the delivery procedure below.
7. After merge, complete the next handoff and launch/verify a fresh Weather session. Carry the
   chain instructions forward. Writing a handoff without starting its successor is incomplete.

## Current checkpoint and evidence limits

Host integration merged in [#3603](https://github.com/motioneso/moss/pull/3603), closing #3600.
Squash commit: `fa177bff203c6b3e331f5bdb09f4561edeb26d70`. Branch from fetched main containing
that squash; the old continuation branch's pre-squash ancestry is not a product base.

Available behavior is bounded, host-labeled user-supplied scalar composition: semantic/catalog
validation, turn identity, atomic existing message metadata, lazy pinned OpenUI rendering,
history/reconnect/copy/export/archive fallback. Domain sources, controls and actions remain.
Historical continuation documents contain pre-merge status; use live tracking and this receipt:

- [Final gate/merge receipt](https://github.com/motioneso/moss/pull/3603#issuecomment-6380202360).
- [Installed evidence](https://github.com/motioneso/moss/pull/3603#issuecomment-6376118448).
- [Independent reviews](https://github.com/motioneso/moss/pull/3603#issuecomment-6376249331).

Final clean local gate exited 0: 1,532 unit files, 17,997 passed/3 skipped; seed 14 files,
35 passed; integration 394 files passed/1 skipped, 4,087 tests passed/3 skipped. CI recorded
19 successes and 3 intentional skips. Both independent exact-head reviews approved.

Installed proof is case by case, not a passing monolithic suite: the configured Codex economy
route produced 20/20 first-attempt saved visuals, 4/4 prose controls and useful text in all
24 cases. Identity/render/copy/reload, 390px bounds, missed HTTP+SSE completion recovery and
separate Stop/thread-switch/real CLI-kill checks were recorded. A separate private End/reload
case exited 0 under a dynamically selected model; it was not that model's visual matrix.
There is no acceptance claim for other providers, broad side-chat reliability, hard deletion
or transcript absence. Retain the limitations recorded on #3603, including #3606 notes-recall
contention, #2690 cleanup sweep and #1086 intentional empty private bookkeeping.

Previous local-gate fixture failures were resolved by using the production registered Sports
manifest in gateway tests. Raw built-in manifests missing `isExternal: false` invoked external
regex workers. Preserve assertions, timeouts and production guards; do not undo that fix.
No old development stack, browser or scratch resources need preserving.

## Sports scope and acceptance

Use a Sports-owned bounded public read for latest completed result/details. Keep the
side-effecting overview route restricted. Reads must not follow teams, sync sources, modify
authority or settings. Reuse reviewed outbound fetch/cache and authorization policies.

Resolve stable provider/team/event identities using follows and conversation context. Handle
men's/women's ambiguity truthfully; the future conversational-control stage does not authorize
inventing a team now. Find the latest completed match across actually covered competitions in
the bounded 90-day window; exclude upcoming/in-progress/postponed/cancelled matches and
abandoned matches without official results. Deduplicate by stable event identity. Preserve
home/away alignment, unknown null scores, draws, extra time, shootouts and aggregates. Omit
unretrieved scorers. Partial coverage changes the claim to latest available result.

Real permitted team logos are the normal presentation, bound by the host to stable identities.
Accessible names/initials are only missing/blocked/failed-image fallbacks. The model cannot
choose arbitrary image URLs, source references or numeric facts. Register bounded snapshots
with sources, freshness and coverage; render immutable historical snapshots without refetch.
Use public built-in registrations and module-owned normalizers/cards; core chat must not
import Sports internals or add module-name branches. General primitives belong in `packages/ui`.

Prove an ordinary latest-Liverpool-result question through the real installed UI, with no
explicit graphic request and no intercepted/faked app responses: authorized read, registered
snapshot, natural presentation proposal, saved reply, correct logos/result/sources and reload.
Exercise ambiguity, partial coverage, empty result, null scores, draw/shootout and asset failure
at appropriate test boundaries. Include explicit text-only/prose controls, malformed or forged
references, denied/disabled sources, cancellation/thread isolation and narrow presentation.
Record precisely which cases have live versus deterministic evidence. Preserve the novel
user-data composition path. App-map declarations must describe actual availability, missing
sources, errors and remediation in the same PR.

The spec requires 20 fixed prompts per rollout engine/provider configuration, at least 19/20
intended visuals on first attempts and useful text for all, plus measured overhead, latency
and bundle delta. Reuse valid unchanged evidence with explicit scope and add proof for changed
behavior. Never silently count retries as first attempts or broaden a provider/surface claim.
If runtime/coverage/engine acceptance genuinely fails, record a measured recommendation on
#3583 and obtain the actual Ben decision before the dependent rollout; continue independent
work where possible. Existing permission does not waive this kill gate.

## Independent review, verification and merge

1. Commit/push the implementation and plan with explicit paths. Open a PR linked to #3629,
   with the repository release-note section and accurate evidence/limitations. Use the PR
   skill for its body. Keep documents free of secrets, private hosts and local absolute paths.
2. Run the full isolated local gate using `.claude/skills/verify-gate/SKILL.md`:
   `scripts/run-gate.sh start`, then its documented detached sentinel `wait --follow` workflow.
   Observe the authoritative completion and exit code 0. Never run bare full/DB tests, pipe
   gates or infer liveness from process listings. The previous full gate took about 90 minutes;
   use compact progress updates and a small external state note, not blocking poll loops.
3. Obtain fresh green CI and installed-dev evidence on the PR. CI's browser step is separate
   from the local gate. Diagnose failures; two identical failures require a changed approach.
4. Use the code-review skill to commission fresh independent Standards and Spec reviewers
   against the complete PR diff and exact final commit SHA. Reviewers must not author the
   implementation. Give them the approved spec/task/plan and repository standards. Require
   explicit verdicts and evidence; resolve every actionable finding or document a reasoned
   disposition, then re-review changed areas. Repeat affected verification after fixes.
5. Before merge, confirm the final SHA matches both reviews, required local/CI checks are
   green and live-path evidence is recorded. Merge with
   `gh pr merge --squash --match-head-commit <sha>`, without admin override or branch deletion.
   A changed head invalidates prior exact-head approval until reviewed again.
6. Verify the merge landed, update the task and #3583 truthfully, and preserve useful findings
   in memory. Do not close the umbrella while any stage or acceptance requirement remains.

## Continue the chain after merge

Follow the herdr-handoff skill: commit/push the next handoff on the base the successor will
branch from; create its isolated worktree from fresh main plus any committed handoff; create
a shell pane, start a named unattended agent, name its session and verify it is executing the
Start section. Record durable agent name and session ID; re-resolve pane IDs before addressing.
Read the repo Herdr messaging doc before messaging another pane. Carry Ben's explicit chain
authorization and this exact independent-review/fix/verify/merge requirement into every handoff.
Each successor creates/checks its task and commits its detailed plan before product code.

Order after Sports: Weather interval/time-zone/coverage reads and sourced card; remaining
read-only planning/tasks/money/comparisons/recommendations; conversational choices/sliders
with explicit Apply and registered navigation; existing action integration with host-authored
outcomes; complete eight-family acceptance. Split any large stage into bounded merged slices,
each followed by a verified fresh-session handoff. Weather evening advice requires actual
interval data for the resolved location/time zone; daily lows do not prove an evening forecast.
Controls must use normal visible follow-ups with captured context and admission/retry identity.
Actions reuse existing resolver/writer/approval flows, never model-selected URLs or a second
approval system. Re-read the full approved spec for each stage rather than treating this list
as its complete contract.

Finish the chain only when the full approved acceptance matrix has evidence and tracking is
accurate, or a genuine recorded decision blocks dependent work. Unsupported sources must be
honestly represented; do not silently shrink the eight-family release scope. Clean each
session's resources and tree, commit/push durable work and leave the successor running before
ending. Claim dev ports with `devports` (5180–5299), release them and stop owned servers/browsers.
Never disturb another agent's resources. Use bounded reads and cropped screenshots.

## References

- `docs/superpowers/specs/2026-10-23-visual-chat-replies.md`
- `docs/superpowers/specs/visual-chat-replies/targets.html`
- `docs/superpowers/plans/2026-10-23-visual-chat-replies.md`
- `docs/research/2026-10-23-visual-chat-runtime-evaluation.md`
- `docs/superpowers/plans/2026-10-23-visual-chat-continuation.md` (merged slice plan)
- `docs/agents/herdr-pane-message.md`

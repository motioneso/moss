# Relay — #1564 trigger-map, build done, wrap-up remaining

**Spec/decision:** issue #1564 + Fable's binding #1557 ruling,
https://github.com/motioneso/moss/issues/1557#issuecomment-5249826990 §5.
**Plan:** `docs/superpowers/plans/2026-08-10-1564-trigger-map.md` (approved by Coordinator).
**Worktree:** `~/Jarv1s/.claude/worktrees/1564-trigger-map` (this one — reuse it, `node_modules`
already installed, do not re-run `pnpm install`).
**Branch:** `fix/1564-trigger-map`.
**Coordinator:** label `Coordinator`, session id `019fef6b-8f40-7453-a6f9-4c3e245dce52` (re-resolve
pane fresh by label + session id — never a baked `…-N`).
**Build skill:** `~/Jarv1s/.claude/skills/coordinated-build/SKILL.md` (already past plan-approval —
resume at step 3b/4, do not re-plan).

## Done

- Plan approved by Coordinator (message received, quoted: "PLAN APPROVED. Implement exactly the
  one-file TSV scope described...").
- Implemented exactly the approved scope in `.claude/skills/coordinate/uat-trigger-map.tsv`:
  line 19 (`packages/chat/** -> 1089-1090-chat-drawer-private`) changed `blocking` → `advisory`,
  inline comment added recording the fully-fixme state + `tests/e2e/chat-drawer.spec.ts` proof +
  return-to-blocking rule, companion baseline comment added on the `packages/chat/**` row group
  (1089-1090: 2/2 fixme, 1133-chat-attachments: 1/3 fixme, runtime-context: 2/4 fixme, both
  pending #1121). `1133-chat-attachments` and `runtime-context` rows untouched, still `blocking`.
- Verified via `.claude/skills/coordinate/resolve-uat-triggers.sh` against a sample
  `packages/chat/**` path: output correctly showed `advisory` for 1089-1090 and `blocking` for the
  other two chat specs; `bash -n` on the script passed.
- Commits on `fix/1564-trigger-map`:
  - `aea2a4547` — the TSV edit + plan doc (`git show --name-only` confirmed exactly those two
    files).
  - `5846b983d` — prettier formatting fix on the plan doc (2-line whitespace only).
- Pre-push trio all green as of `5846b983d`: `pnpm format:check` exit 0, `pnpm lint` exit 0,
  `pnpm typecheck` exit 0 (all three required a one-time `pnpm install` first — node_modules was
  absent in this fresh worktree; that's done, don't repeat it).
- Notified Coordinator of this relay (context 70% trigger) before spawning successor.

## Left to do

1. `git fetch origin main && git rebase origin/main` (not yet run this session — do it before
   push). If it produces conflicts, they should only be possible on `uat-trigger-map.tsv` if
   another lane touched it; check collision notes below before resolving.
2. Re-run the pre-push trio once more only if the rebase actually changed anything (it likely
   won't touch these two new files).
3. Push branch, then invoke `coordinated-wrap-up` to open the draft PR referencing #1564. Note in
   the PR body: **no live-path proof required** — this is coordinator/test metadata only per the
   handoff's exit criteria, not a user-facing surface. State that plainly rather than attaching a
   UAT run.
4. Report the PR URL + verification summary (resolve-uat-triggers.sh output, trio all green) back
   to the Coordinator. Do not merge, do not touch the board/milestone — that's the Coordinator's.
5. Message the Coordinator "relayed to <this pane>, safe to reap the prior session" — the
   Coordinator kills the prior pane (do not self-request reap of yourself; that line is for the
   spent session, already sent).

## Collision notes (from original handoff, still binding)

- This lane is intentionally separate from PR #1561 — never touch its paths.
- #1557's final six-file run waits for this correction to land.
- Never touch `docs/coordination/`, project fields, milestones, or merge state.
- Diff must stay isolated to `.claude/skills/coordinate/uat-trigger-map.tsv` plus plan/handoff
  docs — confirmed via `git show --name-only` on both commits above; keep that discipline through
  push.

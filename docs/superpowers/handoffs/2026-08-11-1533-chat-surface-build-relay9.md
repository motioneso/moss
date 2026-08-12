# #1533 chat-surface-build — relay 9 handoff

Branch `build/1533-chat-surface-routing`, worktree `~/Jarv1s/.claude/worktrees/1533-chat-surface-build`.
Governing instruction: don't relay — continue in-session where possible. Context hit 72%+, so
checkpointing per box-wide context-diet rule instead of pushing further in this window.

## State (verified, not recalled)

- Phase 4 code/gate/sensitive-tier work: DONE (prior windows).
- Live-path proof: BLOCKED by design, not a code bug. Root cause and full evidence trail in
  memory `mem_msp60ah8_d269e844328f` and `docs/coordination/AWAITING-BEN.md` (#1533 entry,
  committed `885a2b414`). One-line summary: this session's env has no
  `JARVIS_UAT_REAL_CHAT_TOKEN_FILE` / `CLAUDE_CODE_OAUTH_TOKEN`, and per #1121 design a build
  session must never hold that token — the real-token UAT run happens outside the build session.
- **Coordinator ruled** (genuine cross-session message, not Ben): open #1533 as a **draft PR now**,
  code-complete, live-path proof explicitly outstanding and blocking merge. Do not mark issue Done.
  Note the missing-token root cause in the PR body. Report back once open; Coordinator updates the
  manifest. The AWAITING-BEN.md entry stays open until Ben/someone with token+dev-instance access
  closes the live-path gap.
- Full detail on this ruling and the investigation that found the root cause: memory
  `mem_mspaedv5_421c27c17f77` (this window's checkpoint memory — read this first).

## Tree state at handoff

`git status --porcelain` showed only:
```
tests/uat/specs/1533-chat-surface-drawer-regression.uat.spec.ts   (NOT mine — see below)
```
(`docs/coordination/AWAITING-BEN.md` already committed at `885a2b414`.)

The drawer-regression spec has an uncommitted one-line diff (`withoutNewsJsonBinding: true`) that
I did not make — another session's in-flight shared-checkout edit. **Do not commit or revert it.**
Re-check `git status --porcelain` fresh at pickup; don't assume this is still the only stray file.

## Next steps — executing `coordinated-wrap-up` skill (already loaded/understood, re-invoke if needed)

1. `scripts/run-gate.sh start` → `wait` → `status` on a fresh gate DB (never hand-rolled, never
   piped, never trust wrapper `echo $?` — read the `### FINAL` sentinel).
2. `pnpm format:check && pnpm lint && pnpm typecheck`.
3. `git fetch origin main && git rebase origin/main`.
4. `git push -u origin build/1533-chat-surface-routing`.
5. `gh pr create --draft --base main --head build/1533-chat-surface-routing` — body must cover:
   what's done/verified (gate + sensitive-tier, cite exit codes), live-path proof missing + why
   (missing-token root cause, so no one wastes a rerun rediscovering it), link the
   AWAITING-BEN.md #1533 entry, state explicitly this is a draft not mergeable until live-path
   evidence is attached per the spec's "Live-path proof: action request without reload" section
   (`docs/superpowers/specs/2026-08-10-1533-chat-surface-send-routing.md`), and note the
   open-draft-now decision came from the overnight Coordinator, not Ben.
6. Report to Coordinator via `herdr-pane-message` — terse, result-first: PR link, gate exit codes,
   live-path status ("NOT MET — code-complete, unverified, reason: missing token by design"),
   teardown state (no dev instances/seed rows started this window → "none started"), worktree
   reapable. Then STOP — don't move board/close issue/merge.
7. Update the AWAITING-BEN.md #1533 entry to reference the new PR number (entry stays open, isn't
   removed — the live-path gap itself is still unresolved).

## Tasks (TaskList, current)

#1–#3 completed (Phase 3). #4 in_progress (Phase 4 overall). #5 completed (tree clean, own path
only). #6–#8 pending: gate run, push+PR, report+AWAITING-BEN update — exactly steps 1–7 above.

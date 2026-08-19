# Run manifest — 2026-08-19 dogfood issues follow-through

Ben's instruction: move the 7 dogfood issues (#1705-#1711, plus related #1693) forward instead of
leaving them filed and idle. Plan approved via plan mode (see git history /
`/home/ben/.claude/plans/rippling-purring-hamming.md` for full text if needed).

## Status snapshot (as of this checkpoint)

**Grounding comments posted to all issues** — done. Every issue (#1705, #1706, #1707, #1708,
#1709, #1710, #1711, plus #1693) has a comment with concrete file/function pointers and a proposed
fix or spec direction.

**Calendar bug fixes (#1711, #1693+#1710) — split between the #1698 lane and a new lane.**
Discovered a live agent already modifying calendar-write-impl.ts (pane w1:pG2, branch
`1698-calendar-lifecycle`, PR #1703, GitHub issue #1698 "Calendar event lifecycle: create,
reschedule, delete" — a full rebuild of create/reschedule/delete). Handed both fix write-ups to
that agent. Checked its PR diff directly: the #1693/#1710 fix (deleteEvent's unguarded getById
call swallowing the real error) IS folded into PR #1703. The #1711 fix (all-day events blocking
scheduling) is NOT — that agent's own plan states no changes are needed to
chooseSlot/focus-time.ts, so it's out of scope for that PR. Sent a quick confirm-only ping to
that pane (queued, agent was mid live-path-proof run, no reply needed to act).

**Spawned a dedicated lane for #1711** since it's fully isolated (only touches
packages/calendar/src/focus-time.ts and the freeBusy-filtering call site in
calendar-write-impl.ts's proposeAndInsert — confirmed no overlap with #1698's rebuild, which
only touches deleteEvent/createEvent/rescheduleEvent, not chooseSlot):

| Lane | Issue | Pane | Worktree / branch |
|---|---|---|---|
| A | #1711 (all-day events block scheduling) | w1:pGA | 1711-allday-events |

Boot brief at /tmp/moss-boot/boot-1711.txt. Confirmed main CI green (commit 0888dc4c6, conclusion
success) before spawning.

**Four spec-writing agents spawned** — this is the last action taken before this checkpoint.
All four are running now in the "agents" Herdr tab (`w1:t1G`), workspace w1:

| Lane | Issue(s) | Pane | Worktree / branch | Spec file to be written |
|---|---|---|---|---|
| C | #1705 + #1706 (pinned context, auto-save) | w1:pG6 | spec-1705-1706-pinned-context | docs/superpowers/specs/2026-08-19-1705-1706-pinned-context-and-autosave.md |
| D | #1707 (cross-conversation history search) | w1:pG7 | spec-1707-history-search | docs/superpowers/specs/2026-08-19-1707-cross-conversation-history-search.md |
| E | #1708 (attachment indexing) | w1:pG8 | spec-1708-attachment-indexing | docs/superpowers/specs/2026-08-19-1708-attachment-indexing.md |
| F | #1709 (MCP connection resilience) | w1:pG9 | spec-1709-mcp-resilience | docs/superpowers/specs/2026-08-19-1709-mcp-connection-resilience.md |

Each agent's boot brief is at /tmp/moss-boot/boot-<slug>.txt (outside the repo, not tracked).
Each was told: docs-only PR, no code changes, read the grounding comment on its issue first,
match this repo's existing spec format, include Open Questions + Exit Criteria, commit by exact
path, open a PR, comment the PR link back onto its issue(s), leave the `needs-spec` label on
(don't self-approve), don't merge itself.

**Not yet verified:** none of the four have been read back yet to confirm they landed on Sonnet
(not Opus, the Herdr default) or that they're actually working. That is the next step for
whoever picks this up: `herdr pane read w1:pG6 --source recent --lines 12` (and pG7/pG8/pG9),
confirm each shows "Sonnet" and is progressing, respawn with --model sonnet if any booted Opus.

## Update 07:26 UTC — all 4 spec PRs merged

- PR #1712 (#1707 history search) — merged, commented back on #1707.
- PR #1713 (#1705+#1706 pinned context/autosave) — merged, commented back on both issues.
- PR #1714 (#1708 attachment indexing) — merged, commented back on #1708.
- PR #1715 (#1709 MCP resilience) — merged, commented back on #1709.
All four had a trivial Prettier formatting failure on first CI run (docs-gate); fixed directly
and repushed to each branch before merge. `needs-spec` label left on all — these are proposed
designs awaiting review/approval, not built yet.

## Remaining open lanes

- **Lane A (#1711 all-day events fix)**, pane w1:pGA, branch `1711-allday-events`: still working,
  currently running its own verification gate script (`gate_1711_allday`, tailing a log file for a
  `### FINAL` marker). Not yet opened a PR. Check back later.
- **#1698 calendar-lifecycle lane (PR #1703)**, pane w1:pG2: its background live-path-proof fork
  just finished (14m45s run) and the pane is mid self-compaction now. My earlier ping asking it to
  confirm the #1711 all-day fix is out of scope for that PR is still queued in its input, unsent —
  will land once compaction finishes. No action needed unless it disagrees.

## Update — PR #1717 (#1711 fix) CI failure fixed, Fable spawned for #1703 sign-off

- PR #1717 (#1711 all-day events fix) failed CI on the same trivial Prettier formatting issue as
  the spec PRs, this time on 3 calendar files. Fixed directly (`npx prettier --write`, commit
  `9b13125b6`, pushed to branch `1711-allday-events`). Re-running CI now — next step is to check
  `gh pr checks 1717 --repo motioneso/moss` again once it settles, then merge with
  `gh pr merge 1717 --squash --auto --repo motioneso/moss` and comment the merged link on #1711.
- Pane w1:pG2 (#1698 lane) confirmed in plain terms: PR #1703 only touched test files, not the
  scheduling logic itself, so the #1711 fix is correctly out of scope for that PR. That lane is
  done for tonight — code-complete, waiting on the live-path proof blocker recorded in
  AWAITING-BEN.md.
- Since Ben said to ask Fable rather than wake him if stuck tonight, and PR #1703's live-path
  proof is blocked on something only a person can fix (stale Google sign-in + no real AI provider
  on one dev account), spawned a dedicated Fable pane (no existing one was reachable) to review
  and sign off on leaving that PR parked overnight: pane `w1:pGB`, label "Fable sign-off PR1703",
  agent name `fable-1703-signoff`, model `claude-fable-5`, boot brief at
  `/tmp/moss-boot/boot-fable-1703.txt`. It will post its verdict as a plain-English comment on
  issue #1698. Not yet checked for a reply.

## Update — live-chat investigation with Ben, PR #1703 conflict/lint fixed, PR #1717 rerun

Ben woke up, started chatting directly with the real production assistant, and found real gaps
("mostly related to security"). He asked me to talk to production directly (not the dev copy) to
pin down what was actually wrong, using his real login. I did that with careful, bounded probes
and grounded every claim in the actual source code before reporting anything back to him. Two real
bugs came out of it, now filed as issues:

- **Issue #1718** — on a brand new or just-recovered chat session, the first message sometimes
  gets sent before the assistant's tool connection has finished setting up, so tools look
  unavailable with no "please wait" message shown. There's already a similar "reconnecting"
  message for a different case (a lost session healing itself) — the fix is to show that same kind
  of message on an ordinary first-time start, or hold the first message until the connection is
  ready.
- **Issue #1719** — sometimes the assistant reaches for its own low-level engine tools (the same
  kind of raw file/shell tools I use) instead of the correct everyday tool for the job, then
  reports a false failure. The fix is stronger steering in its instructions toward the right
  tool, plus a retry with the correct tool before giving up.

One reply from production also surfaced something Ben told the assistant before, about how he's
been feeling. I paused the technical work, asked him directly how he's doing, and he said he's
fine and wants me to keep working the issues — which I'm doing, but flagging here for whoever
reads this next in case it comes up again.

Also fixed, at Fable's recommendation from its sign-off review on issue #1698: PR #1703 had a
leftover unused test helper that was failing the code-style check, and had fallen behind main with
a conflict (a pure formatting difference in one spec document, no real content conflict). Both are
fixed and pushed. GitHub now shows PR #1703 as no longer conflicting — it is still correctly
blocked from merging until Ben does his two morning account fixes (see AWAITING-BEN.md), not by
anything code-related.

PR #1717 (#1711 all-day-events fix) hit a third CI failure after the formatting fix — a flaky,
unrelated test in a different area of the app (chat drawer surface). Confirmed via diff that
PR #1717 doesn't touch that area at all, so re-ran the failed CI jobs rather than investigating an
unrelated test. Rerun in progress as of this update.

## Update — PR #1717 CI is green but merge is blocked on the same live-proof problem as #1703

PR #1717's CI rerun finished clean (all checks pass). But it can't be merged yet: this is a
real change to scheduling behavior, and the rule here is that a user-facing fix needs to be
proven working on the live system before merging, not just pass automated tests. I tried that
proof tonight on the dev system and the chat assistant came back with "no active chat-capable
model is configured" — the main test account has no working AI provider right now, so nothing
chat-based can be proven live until that's fixed. This is the same account problem already
blocking PR #1703. Recorded in the awaiting-Ben tracking file. Both PRs are safe to sit open
overnight as done-but-unproven; nothing is at risk.

## Next steps for whoever continues this run

1. Once someone configures a real AI provider on the dev test account, redo the live proof for
   PR #1717 (ask the assistant to find a scheduling slot on a day that only has an all-day event,
   confirm it doesn't get blocked), then merge with `gh pr merge 1717 --squash --auto --repo
   motioneso/moss` and comment the merged link on #1711.
2. Check pane w1:pGB (bounded `herdr pane read`) for Fable's sign-off comment on issue #1698 (PR
   #1703's live-path-proof blocker). If Fable disagrees with leaving it parked overnight, that's a
   genuine surprise — otherwise no action needed until Ben resolves the dev-account issue in the
   morning.
3. New issues #1718 and #1719 (found via live production chat testing, see above) are filed with
   root cause and proposed fix but not yet spec'd or built — treat like the other needs-spec work
   if picking this back up.
4. Nothing else queued for tonight.

## Coordinator identity (for lock purposes)

Session id 26201b49-079c-409a-b5e0-4a60987ca935, pane w1:pG4, labelled "Coordinator", tab w1:t6.

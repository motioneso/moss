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

## Next steps for whoever continues this run

1. Watch pane w1:pGA for PR-open; once open, check CI (watch for the same Prettier-on-docs class
   of trivial failures — check `gh pr checks` and fix directly rather than bouncing back to the
   agent if it's just formatting), then merge with `gh pr merge --squash --auto`, comment the
   link on #1711.
2. Watch pane w1:pG2 for its post-compaction reply confirming the #1711 scope question, and for
   PR #1703 reaching mergeable state — that's the #1693/#1710 fix landing.
3. Nothing else queued. If genuinely stuck on a call only Ben should make, message Fable per his
   standing instruction ("if you get stuck ask fable").

## Coordinator identity (for lock purposes)

Session id 26201b49-079c-409a-b5e0-4a60987ca935, pane w1:pG4, labelled "Coordinator", tab w1:t6.

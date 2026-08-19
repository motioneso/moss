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

## Next steps for whoever continues this run

1. Verify all 4 spec agents started correctly (model + activity) via bounded pane reads.
2. Supervise them to PR-open (routine tier, doc-only, no live-path gate needed).
3. After each merges, comment the merged spec link back onto its issue(s), leave `needs-spec` on
   pending approval (Ben's or Fable's call, not mine).
4. Check on pane w1:pG2 (PR #1703) — confirm it picked up the two calendar fixes I handed it, or
   spawn a dedicated lane for #1711 and #1693/#1710 if it didn't.
5. Re-verify main's CI is actually green if spawning anything new (last direct check showed
   in_progress, not yet confirmed completed — likely resolved by now given time elapsed).

## Coordinator identity (for lock purposes)

Session id 26201b49-079c-409a-b5e0-4a60987ca935, pane w1:pG4, labelled "Coordinator", tab w1:t6.

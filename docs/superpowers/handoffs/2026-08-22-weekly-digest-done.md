# Weekly digest - done, with one thing to watch

Written 2026-08-22. The system is built, merged and armed. This is a pointer, not a to-do list.

**Write in plain English in every status update, handoff and spawn prompt.** Ben reads status to
know whether work is going well, not to review code. Pass this instruction on to any agent you
spawn.

## What exists

The Moss weekly page at https://motioneso.github.io/moss/ IS the Friday What's New digest. One
system, not two. Nothing writes a weekly section into the What's New file in the repo any more;
that file keeps only the per-pull-request notes.

Every Friday at 6am Pacific a timer on Ben's box wakes an agent. It reads the pull requests merged
since last Friday, writes the article, a renderer drops those words into Ben's design, and the page
is published. Past issues live under `/archive/`.

Design record: `docs/superpowers/specs/2026-08-22-weekly-digest-rebuild.md`.
Shipped in pull requests 1830 and 1867. Full detail is in project memory - search "weekly digest".

## The one thing to watch

Check the page on Friday 28 August. The first real run wrote a good article but listed 4 changes
where a hand-written trial of the same week listed 16. It is reading the same pull requests and
being stricter about what counts as user-facing. If it is still thin, loosen the instructions in
`scripts/setup-weekly-digest-automation.sh` - do not change the structure.

## Traps worth knowing

- **cron does not work for Ben's user on this box.** The crontab command cannot read or write its
  own spool directory, which is why an older "installer" never installed anything. Scheduling uses
  a systemd user timer instead. Lingering is already on, so it runs when nobody is logged in.
- **Nothing can push straight to the main branch.** A rule refuses it. That is why the page is
  published to a separate branch.
- **Never put "skip ci" in a branch commit message.** Checks are then skipped, the required one
  never reports, and the pull request can never merge.

## Rejected, do not rebuild

Assembling the page mechanically from the "Release note" box on each pull request. Tried, closed
unmerged: only 9 of 132 pull requests in a week fill that box in, so the page read far thinner than
one written by a model that reads every pull request. Ben's verdict: the hand-written one is much
better.

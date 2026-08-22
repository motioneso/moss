# Weekly digest rebuild - handoff

Written 2026-08-22 08:05 UTC. Read this, then start work. Do not re-derive from GitHub history.

**Write in plain English in every status update, handoff and spawn prompt you produce.** Ben reads
status to know whether the work is going well, not to review code. Name things by what they do.
Keep exact names only where he must act on them. Pass this instruction on to every agent you spawn.

## What Ben decided

The weekly page on the website and the Friday "What's New" digest are **one system, not two**.

- The Friday agent writes the words, renders them into the new design, and publishes to GitHub
  Pages. Nothing else.
- It publishes via a **`gh-pages` branch**. Ben approved this. Repo Pages source moves from
  `main /` to that branch. Nothing gets committed to `main`.
- The weekly section is **no longer written into `docs/WHATS_NEW.md`**. That file keeps only the
  per-pull-request notes that `scripts/append-release-note.mjs` appends. Ben: "we don't need the
  doc to be updated on the repo, just the github pages".
- The old published pages are **to be deleted**. Ben: "we don't need the old pages".

## The design

Ben's design is `Jarvis Design System/Moss Weekly Digest.html`. It is built as an **email** -
table layout, 600px fixed column, inline styles. He chose to adapt it to a proper full-width web
page, keeping the look and the voice.

That adaptation is done and he has seen it:

- `Jarvis Design System/Moss Weekly Digest - web.html` plus `weekly.css` in the same folder.
- Served for review at http://192.168.50.36:8099/ (a plain Python file server from
  `/tmp/weekly-preview`, started in this session - it will not survive a reboot, restart it the
  same way if the link is dead).

It carries real content for the week of 17 August, so it doubles as the worked example of what
the agent has to produce: an issue number, a written intro, one hand-picked headline story,
then New / Improved / Fixed items each with a plain-English sentence and pull request links.

## Remove as stale

Ben asked for the old system gone. All of it:

- `scripts/generate-weekly-release.mjs` - the mechanical generator. It only counts pull requests
  and lists them; it cannot write the new page.
- `docs/releases/weekly-release.css` and the four old-design pages under `docs/releases/`
  (2026-07-17, 2026-08-07, 2026-08-14, 2026-08-21). Deletion approved.
- The half of `scripts/setup-weekly-digest-automation.sh` that edits `docs/WHATS_NEW.md` and opens
  a pull request. That script is **local only, never committed** - edit it in place.
- An uncommitted leftover in the shared checkout: `scripts/generate-weekly-release.mjs` in the
  working tree is an older draft that would undo a navigation link already on `main`. It dies with
  the file.

`.github/workflows/weekly-release.yml` needs rewriting or deleting depending on where publishing
ends up living.

## Two traps that will bite you

Both were found the hard way this morning. Both are saved to project memory.

1. **Nothing can `git push` straight to `main`.** The branch rule added 2026-08-16 rejects it with
   `GH013 ... Required status check "CI gate" is expected`, because a direct push can never produce
   a gate run. This is what silently broke the weekly report from 2026-08-16 onward - it built the
   page, failed to save it, and that failure skipped the publish step too. This is the whole reason
   for the `gh-pages` branch.
2. **Never put `[skip ci]` in a branch commit message.** Actions then skips every workflow, the
   required check never reports, and the pull request can never merge. It is fine on a squash-merge
   subject. This stranded PR 1815 until it was reworded.

## State right now

- PR 1815 (this week's What's New digest) - merged, branch deleted. Closed out.
- PR 1828 - **closed unmerged**, superseded by this work. It fixed the publishing outage and moved
  the schedule to 06:00 Pacific. **Both fixes still need to happen** in whatever replaces it.
- `scripts/setup-weekly-digest-automation.sh` - already edited this session to stop telling its
  agent to write `[skip ci]`. Keep that fix.
- Nothing else is in flight. No worktrees left behind.

## Next step

Write a short spec before building - this is a rework of a shipped pipeline, not a patch. Open
questions worth settling in it: where the agent runs, how the `gh-pages` branch gets built and
pushed, whether the archive of past weeks accumulates on that branch, and what happens to the
schedule now that 06:00 Pacific is wanted.

Working in this checkout is shared with other sessions. Use the `shared-checkout` skill before any
commit. Never `git add -A`.

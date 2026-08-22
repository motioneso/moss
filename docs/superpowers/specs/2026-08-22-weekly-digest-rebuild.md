# Weekly digest rebuild

Status: approved by Ben 2026-08-22. Replaces the mechanical weekly release report.

## Problem

Two things were being built as if they were separate: a mechanical "weekly delivery report" page
published to the website, and a Friday "What's New" digest written into a file in the repo. Ben's
ruling: they are one thing. The website page is the digest. The repo file no longer carries it.

The old page was also broken. Since 16 August the job that built it tried to save it by pushing
straight to the main branch, which a branch rule now refuses. It built the page every Friday and
threw it away.

## Shape

One page, published every Friday at 06:00 Pacific, written by an agent and rendered into Ben's
Moss Weekly design.

- **Words:** an agent reads the pull requests merged since last Friday and writes editorial copy -
  an intro, one hand-picked headline story, then New / Improved / Fixed. It writes that copy as a
  small content file, not as HTML.
- **Page:** a renderer turns that content file into the finished page. The design lives in the
  repo, so the agent never hand-writes markup and cannot drift from the design.
- **Publishing:** the finished page is committed to a `gh-pages` branch. A small workflow watching
  that branch deploys it to GitHub Pages. No ruleset guards `gh-pages`, so this cannot hit the
  push rejection that broke the old job.
- **Archive:** past issues stay on the `gh-pages` branch under `archive/<date>/`, with a contents
  page listing them. They accumulate naturally because the branch is checked out before writing.

## Decisions

- The agent runs locally on Ben's box under cron, not in GitHub Actions. It needs a model to write
  the copy; Actions has no way to run one here.
- Content is a data file, and rendering is a separate step that can be run and checked on its own.
  This is the only reason the design survives contact with a writing agent.
- Pages deployment stays an Actions workflow (the repo is already set up that way), so nothing in
  the repository settings has to change except nothing at all - the workflow uploads whatever is on
  the `gh-pages` branch.
- The What's New file in the repo keeps only its per-pull-request notes. Nothing appends a weekly
  section to it any more.

## Removed

- The mechanical generator script and its stylesheet.
- The old weekly workflow.
- The four pages published in the old design.
- The half of the local automation script that edited the What's New file and opened a pull
  request.

## Not in scope

Email. The design started as an email template and may become one later; this is the web page only.

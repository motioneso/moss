# Issue #1872 — Service Worker image-failure diagnosis

## Goal

Investigate [issue #1872](https://github.com/motioneso/moss/issues/1872) and produce a grounded,
repeatable diagnosis for the recurring broken photos/logos across Today, News, and Sports.

This is a diagnosis lane only. Do not implement the fix, open a PR, or broaden into the nearby CSP
or chat-stream warnings unless the repro proves they share the same cause.

## Required workflow

1. Invoke the `diagnosing-bugs` skill and follow it. Build one fast, deterministic, agent-runnable
   feedback loop that can fail on the exact rejected `FetchEvent.respondWith()` image-fetch path.
2. Use the codebase-memory MCP graph tools before grep/file search for code discovery. Trace the
   Service Worker registration/fetch flow and shared image callers far enough to identify the
   correct fix seam.
3. Reproduce and minimize before ranking hypotheses. Treat
   `apps/web/public/service-worker.js:49` as evidence, not a conclusion.
4. Determine whether the failure is caused by cross-origin interception, transient fetch rejection,
   missing retry/fallback behavior, or a combination. Keep CSP and interrupted chat streaming
   separate unless falsifiable evidence links them.
5. Post a concise findings comment on #1872 containing the repro command, observed red output,
   root cause or remaining hypotheses, correct fix seam, and the smallest proposed regression test.
6. Report the issue-comment URL and a one-line verdict to agent `coordinator` using the
   `herdr-pane-message` skill, signed with your current pane id.

## Guardrails

- Run `pnpm install` first in this fresh worktree.
- No implementation or production mutations. Read-only observation of the deployed site is allowed.
- Do not touch `docs/coordination/`, run repo-wide formatting, or use broad `git add`.
- Stop and escalate if a production-only artifact or Ben decision is required.
- Any later implementation plan must be reviewed by a Fable-model review agent; the coordinator
  does not approve plans inline for run 1834.

## Start

Run `pnpm install`, read #1872, invoke `diagnosing-bugs`, and build the feedback loop immediately.

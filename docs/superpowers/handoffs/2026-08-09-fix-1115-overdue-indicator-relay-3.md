# #1115 relay 3 — QA RED: post durable live assertions

PR **#1478**. Build and gate work were complete; the remaining requirement was durable proof that
the live `/tasks` path renders exactly one overdue indicator for both open and completed overdue
tasks.

## Remaining work

1. Confirm `gh pr checks 1478` is green.
2. Start the existing live dev instance and run `.scratch-livepath/live-path-1115.mjs`.
3. Require `NON_DONE_OVERDUE_COUNT=1` and `DONE_OVERDUE_COUNT=1` from the live DOM assertions.
4. Post the command, exit code, assertion output, and bounded relevant logs in a new PR comment.
5. Tear down the dev services and remove any seeded test task.

Do not create or attach image artifacts. If the live assertions cannot be produced, report
**code-complete, unverified**.

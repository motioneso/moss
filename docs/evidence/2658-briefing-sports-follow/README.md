# PR #2658 live-path proof

The targeted `1452-briefing-live-content.uat.spec.ts` test ran against the UAT provisioner's
ephemeral Docker app and database on September 24, 2026. It used a fresh owner created through
the real signup UI, followed the Premier League through the authenticated Sports API, created a
morning definition with `sports.followedFactsToday`, triggered the real worker path, and checked
that the saved run appeared in the Today UI. No screenshots were captured for this gate.

The run used `scripts/run-gate.sh start --gate test:uat:briefing-review`; the temporary script
invoked `tsx tests/uat/run-uat.ts 1452-briefing-live-content` and was removed after the run.
The application source under test was PR head `f800219ed` plus the UAT edit subsequently committed
as `9b57d5339`. No application code changed between the run and that commit.

Bounded output from run `uat-2907386_71732164` (gate log
`moss_briefing_live_2658-20260924-143229.log`):

```text
[uat] running tests/uat/specs/1452-briefing-live-content.uat.spec.ts against http://127.0.0.1:20000 (project uat-2907386_71732164)
[live proof] owner follows the Premier League through the live Sports API
[live proof] morning briefing with a sports follow persisted successfully
[live proof] Today rendered the saved morning briefing
1 passed (15.5s)
### FINAL rc=0
```

The test asserts a persisted `succeeded` run with nonempty prose, then reloads Today and sees the
"Read the full morning briefing" control instead of "Briefing not ready yet". The Sports follow
is a competition row rather than a team row because the team lookup depends on an external ESPN
request that timed out in this environment. Both use the same owner-scoped `app.sports_follows`
read; the integration test separately proves the worker can read only its owner's rows.

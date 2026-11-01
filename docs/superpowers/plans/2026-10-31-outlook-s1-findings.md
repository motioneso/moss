# Outlook S1 probe: findings so far

Status: running. Day 0 is 2026-11-01T04:15:51Z (units installed). Window ends 2026-11-07 20:15:51 PST.
Only pass/fail, error codes and counts are recorded. No titles, senders, addresses or bodies.

## Results so far

| Question                        | Result                                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in through the viewer      | Worked. Microsoft accepted the containerised headless Chromium.                                                                         |
| MFA method                      | No second step was prompted at first sign-in. A later challenge (new location, token expiry) is untested and may need the viewer again. |
| Headless accepted               | Yes.                                                                                                                                    |
| Sandbox                         | "Adequately sandboxed". Namespace sandbox, PID and network namespaces, seccomp-BPF and TSYNC all active. Yama (non-broker) not active.  |
| Full scan over the relayed pipe | Pass. 6 weekly views, complete, 41 events (count only).                                                                                 |
| Inbox opens in the container    | Pass. 20 messages counted.                                                                                                              |
| Inbox still reachable at day 7  | Pending.                                                                                                                                |
| First failed scan hour          | None recorded yet by the hourly timer (first fire 2026-11-01T05:00Z).                                                                   |
| Re-sign-in needed               | None since the one sign-in.                                                                                                             |

## Findings that change the build

1. The Settings gear is hidden behind the "Access additional features" overflow menu in the container's
   window. The merged collector clicks Settings directly and fails. S3 must open the overflow menu
   first (the probe copy `packages/connectors/probe-s1/collector-menu.ts` shows the fix).
2. The browser keeps a single DevTools root connection for its whole life. Auto-attach and sessions
   from an earlier client persist and hide pages from the next Playwright client. The relay must
   turn auto-attach off and detach every session it saw when a client disconnects.
3. The HTTP discovery reply needs `Connection: close` or Playwright fails the WebSocket upgrade.
4. The 10 second wait for the week header after the collector's own reload is too short here. It
   timed out roughly half the time. 60 seconds passed 12 of 12 runs.
5. A calendar tab left in the background can hang. Reloading it by raw DevTools before each run
   revives it. The probe does this, plus one retry.
6. Mail and calendar share one browser. Opening and closing the mail tab does not break sign-in.
7. Session-only cookies are lost if the container restarts. The host service logs any restart.

## Still to record at the end

- Hour of first failed hourly scan, or "none in 7 days".
- Full results.log copy, then teardown (units, container, volume, state folder, ports 5183 and 5184).

# 3278 live proof

Installed runs on the throwaway test stack the browser-test harness builds, on the claimed shared dev port. Run 2026-10-11 from branch `scheduled/3278-app-actions-briefing` at 317313915 (integration merged, including #3338). No responses intercepted or rewritten. No screenshots captured.

## Results

| Run                             | Provider and model                                                   | Result                          |
| ------------------------------- | -------------------------------------------------------------------- | ------------------------------- |
| `2809-briefing-rerun-from-chat` | Claude sign-in, cheapest economy model (`claude-haiku-4-5-20251001`) | Passed (1.2 min)                |
| `test:uat:3065` (scripted)      | Scripted model                                                       | Passed (9.8 s)                  |
| `test:uat:3065-real`            | Codex sign-in (Codex-only by design)                                 | Failed at the first step, twice |

## 2809 briefing re-run

- Seeded evening briefing, worker running, `MOSS_UAT_CAPTURE_OFF=1`.
- First ask created one `briefings-run` job and one audit row, with no approval card.
- Conversations > New side chat cleared with 204, the transcript emptied, and the second ask ran on a different thread.
- The second ask answered "already" and created no second job.
- The worker finished the first ask's job (`completed`), and the status answer said ready.

An earlier run on 2026-10-10 failed at the first ask. That run came before #3338 merged into the integration branch, so every live chat started marked as holding outside content and the re-run asked for approval, which timed out. After the merge the user's install grant runs the re-run, and the spec passes with every original check intact.

## 3065 scripted

The run passed on the claimed port (5184). It had failed before 3c8a59cf7 because the scripted spec allowed only the reserved 20000-20099 range. It now uses the same claimed-port check as the real spec.

## 3065 real: blocked

Both runs failed at the first step, the native file read. This happens before any code this branch changed.

```
Error: native file read did not return the fresh fixture fact
"The exact native read was unsupported in this environment: the command runner
failed before `cat` could read the file. No proof code was returned."
```

- No approval card appeared, so the failure sits inside the Codex agent's own command runner in the container. Moss's approval path never ran.
- `docs/3065-app-actions-live-proof.md` already records that this spec was never live-run.
- No open issue tracks it. The side chat, recall, mode, destructive and blocked-authority steps that follow are unexercised live.

## Guard tests

- 51 passed across the side-chat guard, stack guard, real-proof and Codex-only suites after the integration merge.
- Every guard has a negative control that removes the rule and shows the guard failing.

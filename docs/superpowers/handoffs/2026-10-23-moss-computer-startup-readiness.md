# Continue Computer: bounded startup-readiness proof

Ben authorised independent review, fixes and merge of documentation PRs #3587, #3588 and #3595,
then a fresh session for the readiness proof. Start this assignment only after all three merge.
This dispatch supersedes their historical no-rerun restriction for one new bounded readiness run;
their rejected results remain unchanged. Task #3578 and parent #3577 stay open.

## Start

1. Stay in the new isolated worktree on `qualify/moss-computer-startup-readiness`, created from
   merged `origin/main`. Confirm all three PRs are merged and this handoff is present. Own only
   Computer spike/spec/plan/evidence/handoff files. Read `AGENTS.md`, `CLAUDE.md`, relevant development
   standards and the mandatory references below. Use Hindsight for decisions, graph for code
   discovery, diagnosing-bugs for diagnosis and shared-checkout before commits. Resolve installed
   Playwright/ws from `~/Jarv1s/package.json`; a fresh worktree does not justify broad installation.
   Keep a small private state ledger outside the repository. No DB/foundation commands without
   verify-gate.
2. Spend at most ten minutes on fresh read-only host/image/resource entry checks. Available RAM
   and root free must each be at least8GiB; data free at least30GiB. Verify healthy Moss. Failed
   entry means preserve/review the rejection and stop: no wait/retry, restart, prune, reclamation,
   infrastructure investigation or host substitution. Historical resource samples grant no entry.
3. Inspect retained r7 scripts/receipts read-only. Create demonstrably unused identity `readiness-r8`
   and sibling `../moss-computer-readiness-r8/`, with fresh home/socket/keys/scripts/receipts and
   `devports claim moss-computer-readiness-r8`. Preserve all earlier homes, scripts, receipts and
   archive. Record ranked falsifiable hypotheses before corrections. Correct only bounded startup
   observation and guest/gateway live failure diagnostics; retain r7 window/error corrections.
4. Write and COMMIT a fresh launch packet naming this session as active automated finish operator,
   exact artifacts/hashes, readiness predicates/deadlines, unchanged access assertions/red controls,
   current UI/input assertions, watchdog and active cleanup. Obtain independent read-only review
   of the exact committed packet and private artifacts before launch. Reviewers never author fixes.
   If the exact adopted image is absent, apply the verified archive restoration gate below first.
5. Run one actively supervised readiness proof under the acceptance and supervision rules below.
   Finish/clean up on success or failure. Independently review exact final evidence and closure,
   commit/push and open a draft PR. Return narrow PASS or evidence-backed rejection and one next
   proposal. No automatic second run, merge, issue close or expansion into persistence/integration.

## Mandatory references and unresolved evidence

Read in full:

- [r7 report](../../evidence/moss-computer/2026-10-23-persistence-r7.md) and
  [JSON receipt](../../evidence/moss-computer/2026-10-23-persistence-r7.json).
- [r7 launch packet](../plans/2026-10-23-moss-computer-persistence-r7.md) and
  [independent review ledger](../../evidence/moss-computer/2026-10-23-independent-review.md).
- [window/persistence handoff](2026-10-23-moss-computer-window-persistence.md) and
  [original persistence handoff](2026-10-23-moss-computer-persistence.md) for unchanged runtime
  protections, supervision and cleanup. Their broader persistence sequence is deferred here.
- [persistent desktop spec](../specs/2026-10-23-moss-computer-persistent-desktop.md), especially
  sections15–17. Idle sleep/wake remains a future product requirement.

r7 stopped at first protected owner WebSocket:502, expected101. Initial isolation passed, but
host browser, persistence harness, real Firefox/window/sandbox, red controls and replacement were
NOT_RUN. Only one prelaunch watchdog sample exists. Guest live failure diagnostics were retained;
gateway upstream failure logs and socket readiness at request time were missing. Cause is UNKNOWN;
startup timing is a hypothesis. Independent review accepted accurate rejection and cleanup only.
r6's swallowed47 BadWindow errors remain a separate harness failure; no persistence acceptance
transfers from either run. Private r7 root is `../moss-computer-persistence-r7/`.

## Acceptance: startup, protected viewer and fresh input only

Define a bounded positive readiness gate before hard protected-access assertions. Use actual guest
Unix-socket/backend and gateway observations, then current UI/RFB state. Distinguish explicitly
expected not-ready observations from command/instrumentation failures; retain both with timestamps.
Stop/rethink at the second identical command error. Bound all waits and record time-to-ready or
the exact failed predicate. Never mask errors, simply increase timeouts, or retry a failed hard
assertion into success. A health endpoint or running process alone is insufficient.

After readiness, run the unchanged protected owner/foreign/missing-identity and exact-Origin
assertions and mTLS/Origin protection-removal/restoration controls from r7. Require unchanged
driver outcomes0/1/1/0 and byte-exact pristine restoration. Synthetic certificates prove this
trial's access path, not Moss owner authentication. Preserve failures before teardown.

Use installed Playwright with actual current synchronous UI/RFB predicates. Require an attached,
visible/intersecting canvas at least100x100 and at least10 sampled colours. Host may prepare and
activate a terminal; a fresh unique initially absent file must receive exact unique bytes through
viewer keyboard input, with readback. No stubs, intercepted responses or screenshots. On failure,
capture bounded timestamped guest backend/process/socket diagnostics AND gateway upstream/error
logs/config/socket observations while both are live. Keep raw paths, logs and credentials private;
publish sanitised findings and receipt hashes.

PASS requires all readiness/access/control/frame/input/isolation/supervision/closure gates. It
does not qualify Firefox transitions, active browser sandbox, clean profile flush, file/profile
replacement, idle sleep/wake or owner integration. Defer those to a separately dispatched task.

## Exact image, supervision and active finish

Adopted Linux/amd64 image:
`sha256:c84e2db2add5f4c3c5073c7f021f6a2b4a04866948f7a5c4c47437c0d5d9ffbf`.
Tag `moss-computer-qualification:reconstruct-20261023-r2-candidate`. If absent, independently verify
retained `../moss-computer-reconstruct-r2/candidate-image.tar`: size1,026,041,856, SHA256
`48cdd56f8d026af02c873513d36c86ab48b3b9e0b169cefe7a4f2ab7a1ceb4f9`, actual config and all seven
layers before independent restoration-readiness acceptance and one bounded exact load. Inspect
identity/layers afterwards. No rebuild, substitution or viewer upgrade. Recheck resource floors
before load and launch. Prior acceptance is not transferable.

Retain UID1000 offline guest/network none/Unix socket,2CPU/4GiB/512PIDs; separate trusted Nginx
bridge gateway0.5CPU/128MiB/32PIDs, freshly reserved loopback port, synthetic mTLS/exact Origin.
Read-only roots, dropped caps, no-new-privileges/default seccomp/AppArmor, bounded tmpfs/logs;
no devices/Docker socket/production mounts or browser-security weakening. Inspect actual mounts,
full IDs and sampled isolation. Preserve r7 stop intent/shared mutation lock, dead/zombie supervisor
rejection, exact-label emergency kill even on lock failure and residual kill/verify.

Independent watchdog must be alive/healthy before launch: exact new fallback label,
deadline at most1800s, heartbeat90s, nominal5s samples. Fail closed on measurement/log failure,
RAM/root below8GiB, data below30GiB, home/socket reaching10GiB. Monitoring is not quota; host
browser/daemon remain outside caps. Actively finish well before60min; never leave runtime unattended.
Record numeric runner/watchdog/operation/cleanup/port-release exits and bounded resource observations.

Close owned guest/host browsers, watchdog, containers/network, listener/reservation and ephemeral
identities; preserve every home/archive/receipt. Verify actual PID/start/group identities and timeout
descendant cleanup. Cleanup or port-release failure rejects PASS. Obtain independent closure
readback confirming absence of owned runtime and healthy Moss before final evidence review.
No production, Sports, News/Direct On, owner/session/AppShell, Internet/download, installer/platform,
manual MacBook, release or reusable proof-tool work. Product implementation later needs truthful
app-map changes; this assignment changes no shipped product behavior.

# Continue Computer: current Firefox window and replacement persistence

Ben explicitly requested a fresh session to continue after the reviewed r6 rejection. This
handoff dispatches bounded window-transition/error-handling corrections and one fresh supervised
adopted-image sandbox/file-profile replacement qualification, subject to entry and exact review
gates. Routine autonomous preparation/implementation authority persists. Parent session is parked.

## Start

1. Stay in this fresh isolated worktree, branch `fix/moss-computer-window-persistence`, based on
   `qualify/moss-computer-persistence` after checkpoint `f59ddc98f162aeebc6e62f997d79f8c3d1eb82c5`
   plus this committed handoff. Do not switch to another worktree. Own only Computer spike/spec/
   plan/evidence/handoff files. Draft #3588 is the parent evidence PR; #3587 is its pending handoff
   base. Merged #3579 is checkpoint `65fc78250fbca425b56e9a9bc9cc2325ce17a804`. Task #3578 and
   parent #3577 remain open. Inspect current PR status before choosing the child's base.
2. Read `AGENTS.md`, `CLAUDE.md`, relevant development standards, and the references below in full.
   Use Hindsight for decisions, graph for code discovery, diagnosing-bugs for diagnosis and
   shared-checkout before commits. No DB/foundation commands without verify-gate. Installed Node
   Playwright/ws resolve from `~/Jarv1s/package.json`; do not run a broad dependency install merely
   because this is a new worktree. Maintain a small private state ledger outside the repository.
3. Spend at most ten minutes on fresh read-only host/image/resource entry checks. Current floors
   must pass before runtime preparation proceeds: available RAM/root free at least8GiB, data free
   at least30GiB. r6's minimum root margin was only38,219,776 bytes. That historical sample grants
   no fresh admission. Stop on a failed gate; no waiting/retry until green, service restart, prune,
   space reclamation, infrastructure investigation or host substitution. Unity and other host work
   may still compete. Historical image disappearance/Herdr restart causes remain UNKNOWN.
4. Inspect the retained r6 harness and receipts read-only. Prepare fresh run identity `persistence-r7`
   (or another demonstrably unused identity), private home/socket/keys/scripts/receipts and new
   synthetic file/bookmark. Never edit the r6 home, scripts, receipts, controls or diagnostic copy.
   Correct only current-window discovery, repeated-command-error handling and bounded failure
   diagnostics. Preserve exact image/security settings. Record ranked falsifiable hypotheses before
   fixes; do not treat the r6 harness failure as a Firefox sandbox or persistence failure.
5. Write and COMMIT a fresh launch packet naming this new session as active automated finish
   operator, exact artifacts/hashes, browser transitions, assertions/red controls, watchdog and
   active cleanup. Obtain independent read-only review of exact artifacts before launch. You may
   delegate bounded investigation and independent review; reviewers never author fixes. Do not
   reuse an old readiness acceptance or relax gates to run.
6. Run one fresh actively supervised real-path proof, preserve failures, actively finish/clean up,
   get exact independent final review, commit/push and open a draft child PR. Return narrow PASS
   or evidence-backed rejection plus one next proposal. No automatic second run, merge, issue close
   or product integration. If entry fails, preserve and review that rejection instead.

## Read these references

- `docs/superpowers/handoffs/2026-10-23-moss-computer-persistence.md`: original assignment and all
  runtime/acceptance constraints; this handoff extends its dispatch after the failed r6 run.
- `docs/evidence/moss-computer/2026-10-23-persistence-r6.md` and `.json`: operative failed proof,
  exact identities/exit/resource/closure facts, raw hashes and explicit missing gates.
- `docs/superpowers/plans/2026-10-23-moss-computer-persistence-r6.md`: final reviewed r6 artifacts
  and acceptance design, not a command to rerun. Prelaunch commit
  `08a3b2111d6d79ff2aa3972ab56f655e32ed10ef`.
- `docs/evidence/moss-computer/2026-10-23-independent-review.md`: r6 prelaunch rejections/fixes,
  PASS_READY and final acceptance limited to rejection evidence/closure.
- `docs/superpowers/specs/2026-10-23-moss-computer-persistent-desktop.md`, especially15/16:
  persistent desktop destination, future idle sleep/wake and incomplete adopted-image qualification.
- `spikes/moss-computer/README.md`, `compose.yaml`, `entrypoint.sh`, `Dockerfile` and gateway
  template; r4 evidence/JSON and delayed-recovery packet for actual viewer/access/isolation path.
- Reconstruction report/JSON only if adopted image needs restoring; original isolated-qualification
  report/runtime receipt are historical acceptance on an earlier image, not transferable.

## Private retained state and exact image

All private directories are siblings of this fresh worktree. `../moss-computer-persistence-r6/`
contains `STATE.md`, `artifacts.json`, exact scripts/configuration, synthetic home and33 receipts.
Important files: `persistence.mjs`, `process.py`, `check-state.py`, `controls.py`, `mutate.py`,
`supervise.py`, `run.py`, access/isolation scripts, `receipts/persistence.{json,log}`, `run.json`,
`failure-analysis.json`, `monitor.jsonl`, `closure.json`, and `postmortem-profile.json`.
`postmortem/profile/` is a diagnostic copy; it is not qualified replacement evidence.
Fresh keys/certificates were deleted. No r6 runtime/network/listener/reservation remains.

Prior `../moss-computer-recovery-r4/`, `../moss-computer-recovery-r3/`,
`../moss-computer-proof-r1/` and `../moss-computer-reconstruct-r2/` remain intact. Leave them alone.
Store new private runtime artifacts in a separate unused sibling. Public documentation uses
`~/Jarv1s` and private relative references; never commit credentials/raw host paths or logs.

Adopted Linux/amd64 image:
`sha256:c84e2db2add5f4c3c5073c7f021f6a2b4a04866948f7a5c4c47437c0d5d9ffbf`.
Tag `moss-computer-qualification:reconstruct-20261023-r2-candidate`.
noVNC1.3/Websockify0.13/TigerVNC1.12/Xfce4.18/Firefox ESR153.5.1. Inspect fresh.
If absent, verify retained `../moss-computer-reconstruct-r2/candidate-image.tar`, size1,026,041,856,
SHA256 `48cdd56f8d026af02c873513d36c86ab48b3b9e0b169cefe7a4f2ab7a1ceb4f9`, actual config and all
seven layers before one bounded exact load. No rebuild/substitute or viewer upgrade. r6 load itself
returned0 but its wrapper exited1 at a mistyped expected-ID literal; direct inspect subsequently
matched the independently verified config. Preserve that instrumentation failure; do not repeat it.

## r6 facts and correction boundary

r6 ran approximately51.935s. Real current UI/RFB, attached visible/intersecting1280x800 canvas with
345 colours and a fresh viewer-keyboard file passed. Initial actual guest isolation and synthetic
mTLS/Origin protection-removal/restoration controls passed. Firefox fixture title/address and real
bookmark keyboard sequence were reached. At the second-tab about:support transition, cached window
decimal29360173 (`0x1c0002d`) became invalid; `getwindowname` returned BadWindow. The polling helper
swallowed repeated command failures until15s timeout:47 BadWindow occurrences including final error.
That violated the two-identical-failures stop/rethink requirement and must not recur.

Rediscover and verify the current Firefox window around transitions rather than pinning a cached
ID through them. Bound expected not-ready observations separately from command errors; stop on the
second identical command error. Preserve bounded current window-tree/title/class/process and
Firefox/backend failure diagnostics before teardown. No screenshots. Do not mask errors or merely
increase timeouts. Window destruction/focus/crash cause is UNKNOWN because r6 did not capture a
live failure window-tree or Firefox/backend log before removal. Container OOM kills0 is not a
complete crash diagnosis. Make only evidence-supported claims.

No r6 about:support/process receipts, real UI clean close, flushed-state qualification, persistence
red controls, guest replacement or post-replacement acceptance occurred. Replacement operations=[] .
Fallback SIGTERM closed Firefox. A disposable profile+WAL copy contained the unique bookmark after
closure; it does not establish any missing gate. R6 overall runner/harness1, watchdog0, cleanup/
port release0. Inspects/cgroups were captured while services ran; separate closure proves absence.

## Preserve the full acceptance and supervision design

- Actual UI/current RFB synchronous readiness; installed Playwright async-false predicates were
  unreliable. Current attached/visible/intersecting canvas >=100x100 and >=10 sampled colours,
  fresh keyboard input before/after replacement. Host may prepare/activate terminal only; actual
  commands/bookmark/browser interactions traverse viewer input. No stubs or synthetic success.
- Dedicated actual Firefox profile `/home/desktop/.mozilla/firefox/moss`, offline packaged fixture,
  unique initially absent file/bookmark. Keep fixture alive while copying about:support from a
  second tab over a fresh clipboard sentinel. Redirect clipboard setter output to avoid inherited
  docker-exec pipe retention. Assert actual binary/profile, sandbox true/BPF/thread-sync/effective6;
  preserve User Namespaces=false and EPERM limits. Capture actual file/web `tab` content processes,
  not RDD/socket helpers, with added filters above parent. Parent executable/environment mandatory;
  unreadable child fields explicit; core missing diagnostics reject acceptance. No disable flags,
  environment overrides including zero sandbox level, or security weakening.
- Real viewer clean close and actual process disappearance; require absent/empty WAL and flushed
  exact SQLite/file checks. On disposable copies only: first observe identical pristine check pass,
  then file tamper or exactly-one-bookmark deletion must fail at intended assertion. Original home
  unchanged. Compare file/main DB hashes before removal and after recreation before Firefox opens.
- Remove/recreate guest, distinct full IDs and same exact image/designated home; operation exits,
  timestamps and resolved mounts. Restart alone is insufficient. Reopen actual bookmark via browser
  UI from blank page, exact address/title/readback, new viewer input, active sandbox again.
- Fresh reserved loopback port via devports. UID1000 offline guest network none/Unix socket,
  2CPU/4GiB/512PIDs; separate trusted Nginx bridge gateway0.5CPU/128MiB/32PIDs, synthetic mTLS/exact
  Origin. Read-only roots, dropped caps, no-new-privileges/default seccomp/AppArmor; bounded tmpfs/
  logs; no devices/Docker socket/production mounts. Check current-image access/removal/restoration
  and sampled isolation. These are proof identities, not Moss owner auth.
- Independent watchdog alive/healthy before launch; exact fresh fallback label, <=1800s deadline,
  90s heartbeat, nominal5s samples. Fail closed on measurement/log failure, RAM/root below8GiB,
  data below30GiB, home/socket reaching10GiB. Monitoring is not quota; host browser/daemon outside
  caps. Preserve stop intent/shared mutation lock, emergency exact-label kill even if lock setup
  fails, residual kill/verify, dead/zombie supervisor rejection and owned host-browser timeout
  cleanup. Failed cleanup/port release cannot PASS. No unattended runtime; finish well before60min.
- Capture full guest/gateway IDs and numeric supervisor exit. Close actual Firefox/host browser,
  guest/gateway/watchdog/network/listener/reservation/ephemeral identities; retain all homes/archive.
  Independently verify closure and healthy Moss; review exact final evidence before claiming result.

No owner/session/AppShell/download/Internet/installer/platform work, production change or reusable
proof-tool expansion. Idle sleep/wake is a future product requirement, not this runtime task.
Product implementation later requires truthful app-map changes in the same PR. News/Direct On,
manual MacBook and release gates remain independent. The new child PR remains draft and must not
merge or close tasks automatically. This handoff is Ben's dispatch for the next bounded work;
previous result's no-rerun statement remains historical and does not forbid this fresh assignment.

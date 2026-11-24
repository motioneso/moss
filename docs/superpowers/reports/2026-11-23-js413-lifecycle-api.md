# JS-413 installed-module lifecycle API

The authenticated shell now accepts removal with retained data, typed deletion, snapshot listing,
restore and queued cancellation. The signed-in session supplies the actor. Existing operation
records, instance locks, installer journals and the short-lived migration child own execution and
restart recovery. Browser responses contain snapshot metadata and authored results, not saved rows.
No screens, registry management, switches, refresh or install requests are added.

## Real-server verification

From `~/Jarv1s`, run these exact unpiped commands:

```bash
CARGO_HOME=/tmp/js413-cargo RUSTUP_HOME="$HOME/.rustup" CARGO_TARGET_DIR=/tmp/js413-target CARGO_BUILD_JOBS=1 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 RUST_TEST_THREADS=1 NODE_OPTIONS=--max-old-space-size=256 scripts/run-gate.sh start --gate test:rust-phase6-lifecycle-api
scripts/run-gate.sh wait --follow --log /tmp/jarv1s-gate/task_413_rust_phase_6_part_8b_lifecycle_-20261123-180601-cB6S0B.log
```

The completed gate and wait both returned **exit 0**. The real HTTPS server installed a signed
sample package, seeded two accounts, removed and reinstalled it with identical rows, deleted and
restored both accounts' SQL rows, key-value data and vault files, and refused an expired snapshot
before and after restart. Real signed-in non-admin and anonymous sessions refused every lifecycle
endpoint and operation read; another administrator could neither read nor cancel the owner's
operation. A payload actor field was rejected. The ordinary application database role still saw
only its owner's row.

The fault fixture held the catalog activation advisory lock, observed that the real purge had
committed while the host journal remained, refused running cancellation, cancelled another queued
operation, killed the actual lifecycle child, and restarted the server. Recovery returned both
accounts' original rows and files, removed the host journal and preserved readable operation results.

## Failing-first and refusal controls

The initial runner failed with exit 101: POST `/api/modules/remove` returned 405 instead of 202.
After implementation the same runner passed. Each of these removed protections then caused a
real assertion failure (exit 101, not a build error), and every source mutation was restored:

- Typed-name comparison: deletion succeeded instead of refusing the incorrect name.
- Snapshot-expiry comparison: restore succeeded instead of refusing the expired snapshot.
  Automatic expiry cleanup was also disabled for this control so the old bytes remained available.
- Running-cancel lock and stage checks: cancellation returned success while data was changing.

The added authorization controls also failed at their intended assertions when the administrator
check and operation-owner comparison were removed separately. Removing payload unknown-field
rejection was attempted, but the low-memory monitor terminated the linker before the test ran;
that mutation is not passing or failing test proof. All guards were restored in `finally`.
The task proof artifact contains the actual gate output and refusal assertions.

## Limits

The integration uses a disposable supervisor credential-command stand-in, not the installed
supervisor's credential acquisition. It uses real PostgreSQL, authentication, HTTPS, Wasm package
validation, migration child and lifecycle code. The process-kill fixture uses Linux `/proc`.
No production deployment, browser screens, other operating systems or every possible crash
instruction boundary is qualified by this suite. Screens belong to later ordered parts.

## Local checks and CI

The one-job lifecycle runner, existing catalog/review regression and focused recovery unit test
passed locally. Lint, formatting, file-size and app-map generation passed before the additional
Rust authorization fixture and CI-registration changes. The CI-matrix test passed after a
failing-first observation that the lifecycle runner was absent. The new runner is now explicitly
included in the shared-host PR Rust matrix.

Type checking was terminated by the machine's low-memory monitor (exit 143), not a TypeScript
diagnostic. Later database setup and linker attempts were also terminated. The coordinator's
2026-11-23 ruling permits the PR to proceed with these checks assigned to CI; no local passing
type-check or final-commit CI result is claimed. The runner now enforces one Cargo job, disabled
debug info and one test thread. Only this integration runner is built during the constrained retry.

## Review notes below the must-fix threshold

The first independent review identified missing authorization proof as major; the real-session
checks above address that gap. It also recorded these six minor limitations, retained for review:

- The process-kill fixture exercises rollback during deletion, not post-commit success, restore or
  ordinary removal at every crash point.
- A filesystem-cleanup failure after catalog commit can return a conservative failure message
  even though removal committed; the message asks the caller to check installed state.
- Demoting an actor after an interrupted change can leave their operation pending and unavailable
  to them; host-journal recovery still occurs when the application next opens.
- Unrelated catalog revisions can make the resumed result conservative rather than prove which
  operation committed; no new receipt or journal design is introduced in this slice.
- The inherited Meetings purge hook revokes device pairing outside the sample module's restore
  fixture. Restoring that pairing is not proven by this suite.
- Snapshot listing serializes with lifecycle work, opens recovery and expires snapshots. Small
  metadata-only expiry tombstones remain so an old restore request can explain its refusal.

These notes were below the configured major/blocker fix threshold. They do not broaden the
sample-module proof into a claim about every module or every interruption point.

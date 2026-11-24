# JS-413 installed-module lifecycle API

The authenticated shell now accepts removal with retained data, typed deletion, snapshot listing,
restore and queued cancellation. The signed-in session supplies the actor. Existing operation
records, instance locks, installer journals and the short-lived migration child own execution and
restart recovery. Browser responses contain snapshot metadata and authored results, not saved rows.
No screens, registry management, switches, refresh or install requests are added.

## Real-server verification

From `~/Jarv1s`, run these exact unpiped commands:

```bash
CARGO_HOME=/tmp/js413-cargo RUSTUP_HOME="$HOME/.rustup" CARGO_TARGET_DIR=/tmp/js413-target CARGO_BUILD_JOBS=2 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 scripts/run-gate.sh start --gate test:rust-phase6-lifecycle-api
scripts/run-gate.sh wait --follow --log /tmp/jarv1s-gate/task_413_rust_phase_6_part_8b_lifecycle_-20261123-174824-sucX3M.log
```

The completed gate and wait both returned **exit 0**. The real HTTPS server installed a signed
sample package, seeded two accounts, removed and reinstalled it with identical rows, deleted and
restored both accounts' SQL rows, key-value data and vault files, and refused an expired snapshot
before and after restart. The ordinary application database role still saw only its owner's row.

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

The task proof artifact contains the actual gate output and refusal assertions.

## Limits

The integration uses a disposable supervisor credential-command stand-in, not the installed
supervisor's credential acquisition. It uses real PostgreSQL, authentication, HTTPS, Wasm package
validation, migration child and lifecycle code. The process-kill fixture uses Linux `/proc`.
No production deployment, browser screens, other operating systems or every possible crash
instruction boundary is qualified by this suite. Screens belong to later ordered parts.

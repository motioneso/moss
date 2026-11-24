# JS-416: Phase 6 install requests

Implements part 9 on parts 1–8d. Signed-in members request a module from a configured signed source, read their own request status, and get the same saved request on repeat submission or restart. Administrators see configuration metadata and approve with their own existing digest-bound review; installation still uses part 1's executor. A failed install can be retried with a fresh review; active and completed request bindings cannot be replaced. No screens are added.

## Notification limitation

Automatic admin notices are **unsupported**, as explicitly allowed by the brief when the existing service cannot target admins. Both the Rust guest `notifications.rs` handler and the TypeScript notification repository select the triggering actor as recipient. Policies in applied migrations `0029_fix_notifications_insert_policy.sql` and `0071_notifications_worker_insert_grant.sql` require the recipient to be the actor. The new runner confirms a cross-recipient insert from the actual app role fails with SQLSTATE 42501. The response reports `notice: "unsupported"` and a plain reason; administrators can list request metadata. No impersonation, new channel, notification RLS changes or claim of notice delivery is included.

## Commands

Run from `~/Jarv1s`, unpiped, with a new disposable database per run:

```bash
CARGO_HOME=/tmp/js416-cargo RUSTUP_HOME="$HOME/.rustup" CARGO_TARGET_DIR=/tmp/js416-target CARGO_BUILD_JOBS=1 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 scripts/run-gate.sh start --gate test:rust-phase6-install-requests
scripts/run-gate.sh wait --follow
```

The starter's exit 0 only means launch; the waiter supplies the gate verdict. The runner enforces one Cargo build job, no debug information and one test thread.

## Failing-first evidence

- Before the backend existed, the real server returned HTTP 405 instead of 200 for member submission (gate rc 101, receipt `task_416_rust_phase_6_part_9_install_req-20261124-021006-paqNwP.log`).
- The expanded scenario exposed fresh-review retry refusing HTTP 409 instead of 202 after stale bytes caused failure (gate rc 101, receipt `task_416_rust_phase_6_part_9_install_req-20261124-024015-HQNgCT.log`).

- Holding the installer at the real database-supervisor boundary made the request status read time out (gate rc 101, receipt `task_416_rust_phase_6_part_9_install_req-20261124-024204-26DOlr.log`). Removing read-handler installation locks fixed it.
- The complete scenario then passed (one test; gate rc 0, receipt `task_416_rust_phase_6_part_9_install_req-20261124-024418-C68wPU.log`). It covers signed-out refusals, account ownership, unavailable modules, metadata-only admin access, duplicate submissions, restart, member approval refusal, explicit approval, matching source, stale reviewed bytes, fresh review retry, live status, completed binding and a real installed module route.

## Guard-removal controls

```bash
CARGO_HOME=/tmp/js416-cargo RUSTUP_HOME="$HOME/.rustup" CARGO_TARGET_DIR=/tmp/js416-target CARGO_BUILD_JOBS=1 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 python3 rust-spike/module-host/tools/phase6-install-request-controls.py
```

Observed exit 0: all seven controls failed at their intended assertion (each gate rc 101), and the harness restored all source bytes.

The script removes payload-field rejection, owner-read RLS, availability refusal, all new approval authorization layers, explicit approval, source matching, and completed-operation binding protection, one at a time. It requires the corresponding real-server assertion to fail, not a compile/setup failure, then restores source bytes. The existing executor stays protected in the admin control: it proves that refusing execution alone must not allow a member to bind a request to an admin's operation.

## Other checks

`pnpm lint`, `pnpm format:check`, `pnpm check:file-size` and `pnpm typecheck` passed with exit 0. `node --test tests/scripts/rust-gate-matrix.test.mjs` passed all 16 tests. Rust was formatted with `cargo +1.95.0 fmt`, scoped to the changed files.

Final clean-head request and registry regression receipts, with their command outputs, are attached to the task proof. The registry regression command uses the same isolated environment:

```bash
CARGO_HOME=/tmp/js416-cargo RUSTUP_HOME="$HOME/.rustup" CARGO_TARGET_DIR=/tmp/js416-target CARGO_BUILD_JOBS=1 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 scripts/run-gate.sh start --gate test:rust-phase6-registry-api
scripts/run-gate.sh wait --follow
```

## Limits

- Automatic admin notice delivery is unsupported, not verified success.
- Screens are explicitly outside part 9; the runner exercises real HTTPS handlers, signed artifacts, app-role database sessions and a real installed module route.
- Production deployment, platform parity, the full foundation gate and browser suites were not run.

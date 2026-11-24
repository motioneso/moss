# Rust phase 6 part 8d — switches and refresh

JS-415. Backend only; approved screens remain in parts 11–14.

## Behavior

- `GET/POST /api/modules/{module}/account-switch` uses the signed-in session and existing account-choice persistence. The projection returns `enabled`, `onForEveryone`, `blocked`, and `digest`.
- `POST /api/modules/{module}/server-switch` is separately admin-authorized. It changes only the install-wide manual flag; lifting it does not rewrite account choices or clear registry blocks. Private local modules have no server switch.
- `GET/POST /api/modules/policy` persists install-wide `automatic` (default true) and `quietTime` (default false) in the existing revisioned catalog. No applied migration changes.
- Startup, a daily due check, authenticated app-shell opens, module-catalog opens, and admin `POST /api/modules/refresh` use one coordinator and the existing signed client. A daily attempt time is saved in private `module-refresh.json`. Overlapping events share their result. The catalog uses saved metadata after refresh, avoiding a second source fetch.
- The existing updater still enforces pins, skipped digests, permission and migration approval, including urgent offers. Safe ordinary updates require quiet-time eligibility and automatic updates enabled.

## Verification

The new `phase6_module_policy` real HTTPS server runner uses signed fixtures and an isolated database. A Linux inotify fixture counts actual opens of the source index, rather than substituting a transport or counting a wrapper call. The daily check is exercised by aging the persisted attempt timestamp; the production scheduler and client stay unchanged.

Before implementation was validated, the fixed pre-change server returned 404 for the new policy endpoint (expected 200), and the test exited 101. Receipt: `task_415_rust_phase_6_part_8d_switches_a-20261124-000608-SzHaeu.log`. With the new API an uninitialized host deliberately returns 503, then supplies policy once modules are ready.

A second red run exercised the implemented HTTP boundary but caught failed safe activation: the serving host's restricted migration login could not complete the lifecycle work. Refresh now reuses the existing short-lived trusted lifecycle child (`--refresh-policy`) rather than widening the serving role. The child refreshes a source once and runs the existing updater; the child returns a failure count and HTTP uses fixed source messages. The subsequent full policy run passed all switch, update, restart, and daily checks (exit 0; receipt `task_415_rust_phase_6_part_8d_switches_a-20261124-002452-nwu0jE.log`). The runner also asserts that source refresh reported no errors, so a failed activation cannot masquerade as a policy refusal.

The app-open requirement has its own failing-first check: a signed-in member's `GET /api/shell` caused zero index reads instead of one (exit 101; receipt `task_415_rust_phase_6_part_8d_switches_a-20261124-004237-lzEZBK.log`). The shell now signals the shared coordinator in the background. This automatic check uses the configured scheduler authority only for registry configuration; shell data still uses its signed-in actor. Registry failure does not block the shell response.

Final restored command (run from `~/Jarv1s`, no pipe):

```bash
CARGO_HOME=/tmp/js415-cargo RUSTUP_HOME=$HOME/.rustup CARGO_TARGET_DIR=/tmp/js415-target CARGO_BUILD_JOBS=1 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 scripts/run-gate.sh start --gate test:rust-phase6-module-policy
scripts/run-gate.sh wait --follow
```

Completion: exit 0; receipt `task_415_rust_phase_6_part_8d_switches_a-20261124-004835-Li9iHY.log`. It uses one build job, debug information off, and one test thread.

Regression suites use the same command with `JS415_TEST=phase6_update_api` or `JS415_TEST=phase6_registry_api` prefixed on the start command, each followed by `scripts/run-gate.sh wait --follow`. Each starts a new isolated database. A first attempt to combine the three suites in one database passed policy but failed the older fixture's first-owner signup with 403; the corrected runner selects one suite per isolated gate rather than reusing initialized data.

Regression receipts: `phase6_update_api` exit 0, `task_415_rust_phase_6_part_8d_switches_a-20261124-005057-SzBia5.log`; `phase6_registry_api` exit 0, `task_415_rust_phase_6_part_8d_switches_a-20261124-005232-iZjnL7.log`.
All eleven guard-removal controls completed successfully: each deliberately weakened build exited 101 at its named assertion, and the harness restored the source afterward. Exact command (exit 0):

```bash
CARGO_HOME=/tmp/js415-cargo RUSTUP_HOME=$HOME/.rustup CARGO_TARGET_DIR=/tmp/js415-target CARGO_BUILD_JOBS=1 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 python3 rust-spike/module-host/tools/phase6-policy-controls.py
```

| Protection removed | Failing-run receipt                                                   |
| ------------------ | --------------------------------------------------------------------- |
| payload-actor      | `task_415_rust_phase_6_part_8d_switches_a-20261124-002716-pDxrGw.log` |
| account-off        | `task_415_rust_phase_6_part_8d_switches_a-20261124-002824-uxHxJH.log` |
| server-admin       | `task_415_rust_phase_6_part_8d_switches_a-20261124-003002-JHyJz0.log` |
| server-off         | `task_415_rust_phase_6_part_8d_switches_a-20261124-003125-1Dakqr.log` |
| policy-admin       | `task_415_rust_phase_6_part_8d_switches_a-20261124-003245-84gf0v.log` |
| pin                | `task_415_rust_phase_6_part_8d_switches_a-20261124-003350-WOXdGM.log` |
| manual-policy      | `task_415_rust_phase_6_part_8d_switches_a-20261124-003511-ZwVk9i.log` |
| quiet-time         | `task_415_rust_phase_6_part_8d_switches_a-20261124-003646-rGvjzU.log` |
| growth-capability  | `task_415_rust_phase_6_part_8d_switches_a-20261124-003807-EWzUaz.log` |
| growth-migration   | `task_415_rust_phase_6_part_8d_switches_a-20261124-003927-vcUUQu.log` |
| duplicate-open     | `task_415_rust_phase_6_part_8d_switches_a-20261124-004041-GCpTB3.log` |

The final normal run checks the restored sources. The negative controls preceded the app-shell hook; that hook separately has the zero-read failing-first result above.

Static checks: `pnpm lint`, `pnpm format:check`, `pnpm check:file-size`, and `pnpm typecheck` passed, along with all 16 `tests/scripts/rust-gate-matrix.test.mjs` tests. After the app-open hook, scoped ESLint/Prettier and Rust 1.95.0 formatting checks also passed.
Independent review is recorded in Herdr against the final reviewed commit; its receipt accompanies the proof artifact.

## Limits

No management screens, install requests, Finance evidence, production deployment, or cross-platform release builds. This runner proves backend behavior on Linux using generated signed fixtures, not production registry keys. Quiet-time eligibility is saved host configuration for the later preferences screen; it does not infer machine idleness. No new UI is claimed or tested.

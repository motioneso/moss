# Rust phase 6 part 8a: installed module update API

JS-410 implements only the installed registry module update service from row 8a of the
phase 6 plan. No screens, registry management, lifecycle endpoints, switches or refresh
scheduler are added.

## Contract

All routes require a signed-in instance administrator. Requests reject unknown fields;
the actor comes from the session. Administrator access remains configuration power only.

| Method and path                     | Request                                          | Result                                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/modules/update-review`   | `module`, configured `source`                    | Existing digest-bound operation record; refuses a module that is not installed.                                                                                          |
| `POST /api/modules/{module}/update` | `operation`, `approve`                           | Existing queued operation and status endpoint; approval is mandatory, including urgent offers. The operation must review this installed module and belong to this actor. |
| `POST /api/modules/{module}/skip`   | configured `source`, offered `digest`            | Saves the exact skipped digest in the host catalog. A changed offer requires a new choice.                                                                               |
| `POST /api/modules/{module}/pin`    | configured `source`, installed `version` or null | Pins the installed version, or lifts the pin.                                                                                                                            |

The catalog additionally projects `pin`, `skippedDigest` and `urgent`. Skip and pin use the
existing catalog revision transaction and survive server restart. Old catalog records decode
with no skipped digest. Automatic update checks omit the skipped digest; a later digest is
eligible. Explicitly approved updates may still install a skipped offer once any pin is lifted.

Execution reuses the part 1 journal, actor/source checks and `install_reviewed`, and preserves
part 2's revocation enforcement. It reuses existing activation snapshots and rollback. No SQL
migration or previously applied migration changes are needed for this catalog JSON extension.
The app map declares the endpoints, refusal behavior and remedies in `app-map-rust-modules.ts`.

## Verification

Run from `~/Jarv1s` (or the task's worktree). Commands are unpiped. The gate provides its own
throwaway PostgreSQL instance; do not run the database tests directly.

```bash
CARGO_HOME=$HOME/.cargo RUSTUP_HOME=$HOME/.rustup CARGO_TARGET_DIR=/tmp/js410-target CARGO_BUILD_JOBS=2 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 scripts/run-gate.sh start --gate test:rust-phase6-update-api
scripts/run-gate.sh wait --follow
```

Observed: launcher exit 0, completion command exit 0, both tests passed and final gate
exit 0. Receipt: `task_410_rust_phase_6_part_8a_update_api-20261123-145342-mo5GM9.log`,
source fingerprint `724678171099`. The restored runtime sources were unchanged afterward.

The runner builds the real HTTPS server and certificate utility, then runs the ignored
`phase6_update_api` integration and the focused `phase6_update_policy` host test. Fixtures are
signed packages, not intercepted successful responses. The integration proves:

- urgent capability growth and migration growth both wait for approval at the HTTP and host boundaries;
- a newer offered digest refuses an old review; changing bytes under the same version is also refused;
- skipped digests and installed-version pins survive a real server restart;
- a failed guest health check leaves the old digest installed and its real guest route responding;
- a valid approved update succeeds, so refusal is not a blanket implementation;
- requests cannot supply an actor, skip an obsolete offer or pin an uninstalled version.

Failing-first baseline: before implementation the real-server test failed with HTTP 405 at
`update requires an installed module` (expected 422), test exit 101. Subsequent fixture defects
were corrected: registry versions are immutable, and migration names require a numeric prefix
followed by an underscore. The deliberate same-version rewrite remains a refusal test.

```bash
CARGO_HOME=$HOME/.cargo RUSTUP_HOME=$HOME/.rustup CARGO_TARGET_DIR=/tmp/js410-target CARGO_BUILD_JOBS=2 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 python3 rust-spike/module-host/tools/phase6-update-controls.py > /tmp/js410-controls.log 2>&1
```

Observed: control command exit 0. All twelve controls failed at their intended assertion
when protection was removed, and all source bytes were restored. Captured output is
`/tmp/js410-controls.log`.

Controls remove real source checks serially, run the same real server test through a fresh
isolated gate, require the intended assertion to fail, and restore source in `finally`. The
same-version digest control also removes the registry's redundant immutable-version check;
the newer-version control removes both reviewed digest and version checks. No bypass flag
ships in the application. The controls cover installed-only review, explicit approval, urgent
capability growth, urgent migration growth, stale review, same-version bytes, payload actor,
skip offer, pin version, pin enforcement, automatic skip and activation health.

```bash
CARGO_HOME=$HOME/.cargo RUSTUP_HOME=$HOME/.rustup CARGO_TARGET_DIR=/tmp/js410-target CARGO_BUILD_JOBS=2 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 scripts/run-gate.sh start --gate test:rust-phase6-catalog-and-review
scripts/run-gate.sh wait --follow
```

Observed: launcher exit 0, completion command exit 0 and final gate exit 0. The original
catalog/review integration passed, including authorization, concurrent execution, restart,
source binding and retaining the old digest after changed bytes. Receipt:
`task_410_rust_phase_6_part_8a_update_api-20261123-145529-Qxrwnx.log`.

Additional checks: `pnpm lint`, `pnpm format:check`, `pnpm check:file-size` and `pnpm typecheck`
completed with exit 0. Changed Rust files were formatted with `cargo +1.95.0 fmt`; unrelated
pre-existing formatting was kept outside this change.

## Limits

No screen/browser flow, production install, cross-platform build or GitHub CI is claimed.
The task prohibits pushing or merging; these commands and results are retained here for the
PR handoff.

## Release note

Category: Added

Title: Installed module update controls

Description: Administrators can approve updates, skip an offer or hold an installed version;
a failed update keeps the previous module working.

# Rust phase 6 part 10: Finance and Meals M12 evidence

Task JS-417, 2026-11-24. Tested current main fetched at the start of this work:
`ec0a054af92062c5057fc22a58755ea3a863f4e5`. The gate recorded a clean tree and
fingerprint `sha256:f7bd8856cf62bded8f098a0dbb4e536fdfcf52c900fc6bf8ff35af27a1f99b55`.

The historical installed-bank failure did not reproduce. No implementation, tests,
interface, migrations or app-map declarations were changed.

## Run and results

Used `.claude/skills/verify-gate/SKILL.md` and `scripts/run-gate.sh`, with an ignored
scratch executable `node_modules/.bin/js417-m12` invoking the focused runner preserved
with the proof artifact. It obtains the throwaway database URLs from
`getMossDatabaseUrls()` and forwards them as `JS48_APP_URL`, `JS48_BOOTSTRAP_URL`
and `JS48_WORKER_URL`; it never prints their values. The executable contains
`exec pnpm exec tsx /tmp/js417-evidence/runner.mts` under a Bash `set -euo pipefail`
header. No command was piped.

```bash
RUSTUP_HOME="$HOME/.rustup" CARGO_HOME="$HOME/.cargo" CARGO_TARGET_DIR=/media/$USER/Downloads/unity-scratch/JS-417/host CARGO_BUILD_JOBS=1 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_PROFILE_RELEASE_DEBUG=0 CARGO_INCREMENTAL=0 RUST_TEST_THREADS=1 JARVIS_GATE_DIR=/tmp/js417-evidence/gates scripts/run-gate.sh start --gate js417-m12
JARVIS_GATE_DIR=/tmp/js417-evidence/gates scripts/run-gate.sh wait --follow
```

Launcher exit 0; completion exit 0. Rust 1.95.0, Node v22.22.2, pnpm 10.6.2,
PostgreSQL 17.12 (throwaway `pgvector/pgvector:pg17` container).
Host and guest/encoder outputs were separate, under the task's scratch target directory.
Only one Cargo command ran at a time; tests used one thread; debug info was disabled.

Each row below is an actual command, using this common prefix:
`cargo +1.95.0 test --locked --offline --manifest-path`.

| Command suffix                                                                                                                                                                | Result                                                                    | Exit |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---- |
| `rust-spike/module-host/Cargo.toml --test plaid_probe bank_link_runs_through_the_host_and_no_surface_holds_a_secret -- --exact --nocapture --test-threads=1`                  | 1 passed                                                                  | 0    |
| `modules/finance/host/Cargo.toml --test installed a_second_person_and_an_admin_cannot_see_or_change_another_persons_ledger -- --exact --ignored --nocapture --test-threads=1` | 1 passed, including its built-in row-security removal/restoration control | 0    |
| `modules/finance/host/Cargo.toml --test installed a_bank_connects_syncs_fails_and_reconnects -- --exact --ignored --nocapture --test-threads=1`                               | 1 passed                                                                  | 0    |
| `modules/finance/host/Cargo.toml --test package changing_one_byte_of_the_legacy_sql_stops_the_build -- --exact --nocapture --test-threads=1`                                  | 1 passed                                                                  | 0    |
| `modules/meals/host/Cargo.toml --test installed -- --ignored --nocapture --test-threads=1`                                                                                    | 13 passed, including existing route replays and built-in controls         | 0    |

Before installed tests, the runner built the existing components with
`modules/finance/tools/build-component.sh` and `modules/meals/tools/build-component.sh`,
setting the matching `FINANCE_COMPONENT_WASM` / `MEALS_COMPONENT_WASM` paths.
Both component build commands exited 0. The Meals installed file now delegates to
support modules; the full installed target exercises those existing package routes.

## Evidence and limits

Full unpiped baseline output and runner source are preserved in the JS-417 proof
artifact `rust-phase-6-part-10-fin-c084`. Baseline log SHA-256: `69eeeab925fc657b8e1a2611c9b04293c617f7f9c252dda5d09e187737074a8d`.
Runner SHA-256: `fbfdf478eb8b0442733543bc60a2a317a16ace1bba2626685188c89adf06144e`.

All named test targets pass at the commit above. It is not a new
real-bank, browser, device or CI run. No new security-removal experiments were added;
the owner and Meals tests' existing controls ran as part of those tests. Meals intentionally catches assertion panics during its row-security removal
controls; the installed-suite verdict was 13 passed, 0 failed, exit 0. The broader
`test:rust-finance`, `test:rust-finance-live`, `test:rust-meals`, foundation and browser
gates were not run; this evidence is limited to the named targets. There was no
confirmed regression to fix, so no repair or red/green repair claim is made.

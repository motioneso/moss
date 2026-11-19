# Meetings Rust phase 5, part 7c — device tables

Task JS-353, Card 608. Scope: section 4b and row 7c of the Meetings/Briefings plan.

## Result

Option B1 holds. A fresh, actual `moss-db up` creates all four companion tables and records
core migrations 0238, 0239, 0287 and 0330. A second `up` preserves all four table OIDs. The
section 4b.7 kill gate **did not fire**. No migration was added, edited, moved or renumbered;
the collision checker is unchanged. Only the explanatory header of host lookup SQL 0004 changed.

The server prepares that lookup before accepting requests, independently of `install-module`.
It uses the existing elevated install environment variable, or obtains a temporary elevated
login from the instance supervisor; an explicitly configured module host uses its migration
URL. A preparation failure emits a fixed warning and leaves HTTPS available. Pairing returns
503 until the lookup is available and Meetings is installed.

Removing Meetings with its data invokes the host-only pairing-store purge before dropping
module-owned tables. It deletes devices and pair attempts for every account, including expired
devices and unclaimed attempts; recording capabilities and attempts cascade. Browser sessions,
the four tables, and their core ledger entries remain. Keeping data preserves devices.
Cleanup failure aborts removal. As the plan specifies, device cleanup commits separately: if
the later module-table purge fails, devices are already forgotten and must be paired again.
The manifest describes that outcome and the linking-unavailable remediation.

Pair, approve and redeem share the installer's in-process and on-disk fences with removal.
Removal waits for existing pairing work, and queued work rechecks installation before writing.
The reinstall test also exposed a frozen legacy trigger function that survived table deletion
and caused `function "meeting_record_creation_title" already exists`. The host clears that
known Meetings auxiliary only before replaying its exact frozen migration, in the migration
transaction. Keeping it through purge lets failure recovery restore the original trigger.
A separate snapshot → purge → restore regression test covers that recovery path.

## Tests and protection removal

Database checks use the repository's `verify-gate` procedure and disposable pgvector servers,
never the development database. Every cargo command sets `CARGO_HOME`. Fresh-install tests use
the existing PostgreSQL bundle extracted from the project's declared pgvector image and run
the real Rust supervisor and migration runner, rather than assembling a schema fixture.

Test locations differ slightly from the plan's suggested grouping to reuse the real fixtures:

- `rust-spike/module-host/tests/companion_tables.rs`: fresh Rust installation and repeat-up.
- `rust-spike/module-host/tests/meetings_server.rs`: registry installation, startup lookup,
  and healthy HTTPS with pairing closed when DDL is unavailable.
- `modules/meetings/host/tests/devices_lifecycle.rs`, included by `devices.rs`: removal,
  reinstall, cleanup failure, and the pairing/removal fence.
- `modules/meetings/host/tests/support/companion_http.py`: real HTTPS pair/approve/redeem after
  reinstall. It creates a synthetic signed browser session; it is not a physical Mac or UI test.

Protection-removal experiments use scratch copies or separately copied mutant executables.
Original source bytes are restored after compilation. No mutation is part of the final tree.
Each negative run executes one real test; no zero-match exit is counted as evidence.

| Property / protection removed                                         | Observed failure                                                                       | Passing counterpart                                                 | Run receipt suffix                |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------- |
| Fresh core schema; omit 0238 in a scratch repo                        | Supervisor cannot complete core migration without its device table; 1 failed, exit 101 | Fresh `moss-db up`, 1 passed, exit 0                                | `201619-0aArQj` / `204920-tgA221` |
| Fresh core schema; omit 0239                                          | Four-entry core ledger assertion fails; 1 failed, exit 101                             | Same fresh-install test                                             | `201641-FOio96`                   |
| Fresh core schema; omit 0287                                          | Recording-capabilities table assertion fails; 1 failed, exit 101                       | Same fresh-install test                                             | `201651-DLEO4v`                   |
| Fresh core schema; omit 0330                                          | Four-entry core ledger assertion fails; 1 failed, exit 101                             | Same fresh-install test                                             | `201701-R40TNC`                   |
| Startup lookup; bypass startup preparation                            | Lookup-view assertion fails after registry installation; 1 failed, exit 101            | Registry-installed package gets lookup at startup; 1 passed, exit 0 | `203800-DkMSeU` / `205021-IJUt4B` |
| All accounts' rows purged; omit the installer purge-hook call         | Two device rows remain instead of zero; 1 failed, exit 101                             | Device lifecycle suite, 15 passed, exit 0                           | `203028-fIav9L`                   |
| Core tables preserved; register the core device table as module-owned | Removal fails on the dependent lookup view; 1 failed, exit 101                         | Device lifecycle suite, 15 passed, exit 0                           | `203519-TW4ys6`                   |
| Reinstall can pair; drop core tables after purge                      | Real HTTPS pair route stays unavailable (503); 1 failed, exit 101                      | HTTPS pair/approve/redeem after reinstall, 1 passed, exit 0         | `210526-K3h9Al` / `211022-gm5b87` |
| Pairing/removal serialization; remove fence and installation check    | Callback runs after removal; 1 failed, exit 101                                        | Device lifecycle suite, 15 passed, exit 0                           | `203203-8l3ogb`                   |
| Reinstall reruns frozen SQL; omit auxiliary cleanup                   | Duplicate trigger-function error; reinstall test failed, exit 101                      | Device lifecycle suite, 15 passed, exit 0                           | `202111-Ptc3TC`                   |
| Purge failure recovery; drop the legacy function during purge         | Snapshot restore cannot recreate its trigger; 1 failed, exit 101                       | Snapshot/purge/restore in 15-pass suite, exit 0                     | `204531-qnH3kY` / `211439-0asvtt` |

Receipts are the JS-353 `run-gate.sh` logs, named
`task_353_rust_port_phase_5_meetings_part-20261118-<suffix>.log`. Bounded output is also published
in the task's proof recipe. Earlier full runs were stopped after implementation changed.
An overlapping baseline devices run consumed a mutation artifact and was discarded. Preliminary
HTTP runs also exposed three fixture errors (missing web directory, the module subfolder supplied
as the server data root, and a plain cookie name on the TLS server); their failures are not protection-removal evidence. The helper now
supplies a minimal web directory, the existing catalog parent, the secure session cookie,
and rate-limited readiness retries.
The full gate started before those fixture corrections and loads the helper at its final device
test; its receipt is retained with that timing disclosed. All production mutations were restored
before that gate compiled the shell. The later removal of an unused account-sign-out trait
method passed a separate shell build (exit 0) and the stable-source 15-test device suite
(`211439-0asvtt`). Targeted final lifecycle checks use the corrected helper. The full run's initial fingerprint is
not a clean final-HEAD receipt; the stable-source device run verifies the final changed behavior.

## Final checks

- Full `test:rust-meetings`: **222 passed**, **0 failed**, exit **0**, `204550-lgQQPG`.
  Its start fingerprint predates the fixture corrections and final trait cleanup, as disclosed above.
- Stable-source `MEETINGS_ONLY=devices test:rust-meetings`: **15 passed**, exit **0**,
  `211439-0asvtt`, source commit `37ded0a99` (only the report was untracked).
- Targeted HTTPS reinstall lifecycle: **1 passed**, exit **0** (`211022-gm5b87`).
- `verify:static`: final unpiped run **passed**, exit **0** (`static-stable.log`, rerun on stable source `37ded0a99`).
- Fresh `test:rust-meetings-companion`: **1 passed**, exit **0**.
- `test:rust-meetings-companion-server`: **1 passed**, exit **0**; also verifies that denied
  lookup DDL leaves HTTPS healthy and pairing returns 503.
- Migration collision check: no collisions; also passed in the stable-source static run. CI is separate.

The new companion gate is separate from the full Meetings gate because it additionally needs
the bundled PostgreSQL executable path. The full Meetings gate includes the device lifecycle
tests and builds the real shell and TLS helper for the HTTPS reinstall proof.

CI results are separate from local checks; CI does not run these Rust gates. The pull request
records their pass counts explicitly.

## Independent review

Round one, Claude, on `920d2d539`: two major findings, pairing during removal and fatal startup
DDL failure. Both have fixes and regression tests. A second Claude review covers this report commit; its
outcome is recorded on the task and pull request.

Minor observations: production hook registration is not independently mutation-tested; the
pre-purge device commit is intentionally irreversible if later module cleanup fails (now
documented in the app map); table locks briefly block other companion access; the synchronous
hook creates a temporary runtime and may cause pooled connections to reconnect; the fresh
supervisor schema and the fixture-backed shell lifecycle are separate tests. These limits are
retained or disclosed rather than claiming an assembled real-device flow was proven.

## Not proven

- Physical Mac pairing, device-list UI, removal and pairing again on a fresh Rust-only install.
- Upgrade against a copy of existing development data. Repeat-up with stable OIDs is proven
  only on this test's newly created Rust instance.
- An assembled `moss-db` → registry → real browser → physical Mac flow; startup and lifecycle
  proofs use the existing disposable fixture schema, and dependencies include test stand-ins.
- Supervisor-provided and environment-provided elevated-login startup branches against a live
  desktop installation. The configured migration URL and denied-DDL branches are tested.
- Runtime registration-line removal, missing-hook rejection, and process-crash recovery during
  the interval between device cleanup and module purge are not independently mutation-tested.

Status: code complete; real-device and existing-data live proof remains unverified. This report
does not authorize merging or marking the card Done.

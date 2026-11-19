# Rust Phase 5, Meetings part 7a report: device store and pairing server

Card JS-346. Plan: `2026-11-11-rust-phase5-meetings-briefings-plan.md`, section 4a, row 7a.

## Built

- The four companion tables moved into the Meetings ledger. Deletion tables added to the manifest.
- Resolver, owner view and definer functions in `rust-spike/module-host/sql/0004_companion_devices.sql`.
- `PairingStore` (create, decide, redeem, cancel, revoke) and `DeviceStore` plus `NativeAuthority` in `modules/meetings/host`.
- Sign-in gate in `rust-spike/safety-core/src/companion_gate.rs`, wired into `rust-spike/network/src/web.rs`. A device credential opens only its own path list. Ring credentials reach recording and voice paths and one voice-request read. Mac credentials reach six paths.
- Companion routes in the shell, with the per-IP limits of the legacy API.
- Backtrack Mac link built by the shell from the gate's device map and the device store. Alias route `/api/companion/backtrack`.
- Admin revoke goes through the pairing store, fails closed, and works with Meetings off.
- Manifest: Meetings provides `checkDevice` 1.0.0. Backtrack lists Meetings as optional.

## Proof

| Claim                                                        | Test                           | Seen failing with protection removed    |
| ------------------------------------------------------------ | ------------------------------ | --------------------------------------- |
| Credential stored only as digest, one credential per pairing | `tests/devices.rs` (database)  | yes                                     |
| Resolver fails without its policy, never slides past the cap | `tests/devices.rs`             | yes                                     |
| One person cannot see or change another's devices            | `tests/devices.rs`             | yes                                     |
| Ring credential gets 403 off its list, act-as header refused | `companion_gate.rs` unit tests | yes (list opened, header check removed) |
| Backtrack refuses a request with no resolved device          | `companion_links.rs` unit test | yes                                     |
| A deactivated account gets no ring session                   | `tests/devices.rs`             | yes                                     |
| Device store names the refusal reason                        | `tests/devices.rs`             | yes                                     |
| Admin revoke removes devices and sessions in one transaction | `tests/devices.rs`             | yes (devices committed before sessions) |
| A deactivated account's credential is never extended         | `tests/devices.rs`             | yes (status check removed)              |
| Pre-sign-in rate limiter drops old entries                   | `companion.rs` unit test       | yes (sweep disabled)                    |

## Not proven

- Review findings left open, to fix later: the pre-sign-in rate limiter keys on the connection address, so many people behind one proxy share a limit. The device store opens a thread and runtime per lookup. Heartbeat uses three transactions. The credential shape and hash are defined twice. The four device tables are listed as module database resources although only the auth role can read them.
- Meetings installed through any path other than the install command does not get the device lookup SQL until the next install run.
- No paused-account state exists in the data, so the paused path is untested.
- Routes are mounted by the shell, not by the Meetings guest module.
- The focus feature has no owner yet.
- The `/link/trail-marker` redirect is unconfirmed.
- Whether `requires` and `optionalRequires` between Meetings and Backtrack form a cycle the installer rejects is unchecked.
- A host function that reads a Meetings table from Backtrack is an open question.
- Replay of Mac and Android request shapes is reconstructed from the legacy routes, not from recordings.
- The heartbeat reply omits the `backtrack` field because no device-state hook exists.
- Vikunja card could not be moved to Doing: no matching card.

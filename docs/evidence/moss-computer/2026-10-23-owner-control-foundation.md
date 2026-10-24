# Moss Computer: internal input-control foundation

Task #3605, child of #3577; stacked on unmerged draft #3598. This is internal policy groundwork,
not a delivered app/browser Computer. The [committed plan](../../superpowers/plans/2026-10-23-moss-computer-owner-control.md)
defines the scope and remaining integrated acceptance. No routes, sockets, desktop launch,
database schema, configuration requirement or advertised app-map surface are added.

## Implemented boundary

`ComputerInputControl` accepts auth-owned browser-session bindings through the existing
`SessionBindingsService.assertLive` port. It starts paused, allows watching without taking control,
and permits only one controlling viewer. Owner transitions and input require fresh session/expiry
checks. Agent input requires an opaque lease bound to the exact session that explicitly returned
control, with fresh authorization on every dispatch. Generation fencing rejects stale work after
takeover, explicit return, controller loss, session invalidation or shutdown, including asynchronous
authorization races. A reconnect starts as a watcher. Viewer disconnect alone preserves an active
agent grant; session expiry/revocation invalidates it. Capabilities cannot cross controller instances.

The follow-on `closeViewer` operation implements the approved intentional-close handoff in this
local controller. Fresh authorization and a generation check precede return to Moss, and only the
controlling viewer can return control by closing. Cleanup disconnects the handle on success or
failure. Watcher close preserves existing authority/leases; an authorization failure or stale
close cannot create a grant. Unexpected disconnect still pauses the controlling owner. This API
has no transport caller yet; it does not establish real UI or receiving-side input exclusion.

The trusted sender is synchronous after the final fence. Future integration must make its gateway
the sole input writer, fence/drain queued input and release pressed keys/buttons on handoff.
Already-sent bytes cannot be retracted by this policy. Raw noVNC input passthrough bypasses it and
cannot establish exclusion. No remote transport security claim follows from these unit tests.

## Verification

Observed locally on 2026-10-23, after the public auth type export and explicit frozen-capability
type corrections:

| Check                                                            | Result                                   |
| ---------------------------------------------------------------- | ---------------------------------------- |
| `pnpm exec vitest run tests/unit/computer-input-control.test.ts` | Exit 0; 17 tests passed                  |
| `pnpm exec tsc --noEmit`                                         | Exit 0; root project                     |
| Scoped ESLint on boundary, tests and auth export                 | Exit 0                                   |
| `pnpm check:file-size`                                           | Exit 0; no checked file above 1000 lines |
| Mockup state/theme/viewport assertions                           | 60 passed; design data only              |

Observed negative control: temporarily removing the generation comparison caused the old-agent-lease
assertion after explicit return to resolve instead of reject (exit 1; 1 failed, 16 passed). Restoring
the comparison restored all 17 tests. Deferred authorization cases exercise takeover/disconnect,
revocation/expiry and stale-denial races rather than only synchronous transitions.

Private verification logs are retained in `../moss-computer-implementation-private/`, including
`fence-red.log`, `unit-final.log`, `tsc-final.log`, `lint-final.log`, `file-size.log` and
`mockup-check.json`. Frozen scoped dependency installs changed no package manifest or lockfile.
The initial TypeScript attempt exposed a missing public auth type export and widened branded
properties; both were corrected before the green root check. No DB/foundation or integrated live
gate ran for this internal slice. Independent exact-candidate rulings are preserved in the
[review ledger](2026-10-23-independent-review.md).

### Intentional-close follow-on

The next [committed plan](../../superpowers/plans/2026-10-23-moss-computer-owner-control.md)
was independently accepted at `d49f58c27` before implementation. The focused suite now has 28
passing tests. Added cases cover controller close with a fresh lease, stale owner/agent input,
grant-session revocation after viewer removal, watcher close in all authority modes, revoked/
expired and delayed authorization, replacement-viewer and same-viewer takeover races, concurrent
closes and shutdown. Removing only the close generation guard caused 2 failures/26 passes: stale
close resumed a newer takeover, and both concurrent closes reported success. Restoring the guard
returned all 28 tests to green. Raw logs: `close-fence-red.log` and `close-unit-final.log` in the
same private sibling. This is local policy evidence, not protocol or live desktop acceptance.

Root TypeScript, scoped ESLint, file-size, formatting and whitespace checks all exited 0 for
this follow-on. Explicit process-exit receipts and exact candidate hashes are retained in
`close-verification.json`; silent logs alone were not treated as success. Independent exact-final
review accepted `f7a26e6f3` with no findings. No DB/foundation or integrated live gate ran.

## Open gates

The [single r12 prerequisite attempt](2026-10-23-persistence-r12.md) was rejected at UI/RFB connection;
Firefox sandbox/clean flush/replacement were not reached. Resources were independently closed.
No runtime retry follows this dispatch; r11's bounded startup/input acceptance remains historical.

Ben approved the [chat-integrated design](../../superpowers/specs/2026-10-23-moss-computer-chat-mockups.html)
with concise copy and intentional close returning control to Moss; visible screenshot labels
were subsequently removed. The separate Computer destination is superseded, and the design entry
has been removed from `AWAITING-BEN.md`. Mockup approval does not qualify the real desktop path.

Actual owner HTTPS/WSS and active revocation, receiving-side input exclusion, persistent installed
storage, trusted lifecycle/idle sleep/wake, confined Internet egress and real app/browser acceptance
remain open. Downloads and manual platform/installer release acceptance remain later work. The full
Computer outcome and issues #3605/#3577/#3578 stay open; no merge or deployment is authorized.

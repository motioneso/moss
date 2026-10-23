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

## Open gates

The [single r12 prerequisite attempt](2026-10-23-persistence-r12.md) was rejected at UI/RFB connection;
Firefox sandbox/clean flush/replacement were not reached. Resources were independently closed.
No runtime retry follows this dispatch; r11's bounded startup/input acceptance remains historical.

[Proposed screens](../../superpowers/specs/2026-10-23-moss-computer-screens.html) await Ben's design
approval. On request, the self-contained `Moss-Computer-preview.html` was Taildropped to his Samsung
phone; the transfer succeeded. Delivery is not approval. The open design decision remains in
`docs/coordination/AWAITING-BEN.md` and was sent through `needs-ben`.

Actual owner HTTPS/WSS and active revocation, receiving-side input exclusion, persistent installed
storage, trusted lifecycle/idle sleep/wake, confined Internet egress and real app/browser acceptance
remain open. Downloads and manual platform/installer release acceptance remain later work. The full
Computer outcome and issues #3605/#3577/#3578 stay open; no merge or deployment is authorized.

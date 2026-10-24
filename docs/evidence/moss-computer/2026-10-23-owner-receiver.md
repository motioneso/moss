# Computer owner integration: bounded receiving dependency

Part of #3617 / #3616 / #3577. **Internal receiver verified; owner integration is not delivered.**
Source candidate `bf5b21bd313734598434a6331b406e3b168b0f85`, with test amendment
`59c50b636a8935b984b4f47829ab56ca8d5f3848`, follows the
[reviewed plan](../../superpowers/plans/2026-10-23-moss-computer-owner-integration.md).
The [receipt](2026-10-23-owner-receiver.json) records checks and private log hashes.

## Implemented and exercised

`ComputerRfbInput` composes the existing controller with one upstream RFB input writer.
Watcher parsers remain nonwriting. Owner parsers and queued normalized input capture immutable
receiver epochs. Transfers and parser replacement retire previous controller streams, release
tracked keys/buttons, and require a matching BlockBefore Fence followed by fresh authorization.
An older barrier/auth completion cannot reopen admission during a newer transition. Intentional
controlling close returns through authenticated policy and receiving barrier; unexpected loss
pauses input. Shutdown releases input before its final barrier when the upstream remains usable.
Hard transport failure cannot guarantee delivery of releases; it permanently closes the receiver.

Bounds: four attached parser streams, 64 KiB lifetime ingress per stream, 32 queued inputs,
64 pressed keys, 64 KiB actual upstream writable backlog, dimensions at most 1280 × 800,
and authorization/Fence waits at most two seconds. No retry or automatic authority resurrection.
Clipboard and extensions are not forwarded to the guest input writer.

## Vendor path and limits of this evidence

Exact `rfb2@1.1.0` is pinned in the API/runtime and root/test manifests and lockfile. Published
archive SHA-256 `cd86dad6c23727a6f4202f4199fb35c0076a8be6743b2832ae72daa3fa05a7d6`;
npm integrity `sha512-Cwhy/yIWli6akZ28racdIBoYKhLW8YQ2+C/m7eNZ61oNtZhPQN4EZLmwDyvX14oDmksQENXUfmQWE6kqj0NB8A==`;
published gitHead `5210ebe4827a53e0e02b1bac548f76a571a0b833`. Requires Node ≥22.12.
The package has no runtime dependencies. These identities establish the inspected bytes, not
an independent security audit or a broad maturity claim.

Inspected published `dist/server.js` parses viewer input into key/pointer events; the adapter
never forwards raw viewer bytes. `dist/client.js` input methods call `Transport.write` but discard
its boolean backpressure result. Therefore the writer checks the actual connected/writable stream
and backlog before and after each input/release/Fence write. The client handles Fence replies;
matching flags and unique payload are required by the adapter.

Tests use actual library RFB client/server parsers and in-memory Duplex streams, asserting decoded
guest wire events. The library's server lacks Fence, so the fixture supplies only that extension's
announcement/replies. This proves adapter behavior against that stand-in. **It does not prove
TigerVNC receiving order, a live owner security boundary, framebuffer fan-out or production wiring.**
Whole-protocol decoder/framebuffer resource limits must be established in the separate trusted
gateway contract, rather than putting that unqualified workload into ordinary Moss.

## Verification

All final commands exited zero:

- `pnpm exec vitest run tests/unit/computer-input-control.test.ts tests/unit/computer-rfb-input.test.ts`:
  **59 passed**, including the original 28 controller tests.
- `pnpm exec tsc --noEmit` and `pnpm exec tsc -p tsconfig.tests.json --noEmit`.
- `pnpm exec eslint` on the seven changed source/test TypeScript files with `--max-warnings=0`.
- `pnpm exec prettier --check` on those files, both manifests and the lockfile.
- `pnpm check:file-size` and `git diff --check`.

Each removed-protection control ran separately, exited **1 at the intended assertion**, and restored
the source in `finally`. The restored final suite passed. Receipt hashes retain exact raw output.

| Protection removed                    | Observed failure                                                            |
| ------------------------------------- | --------------------------------------------------------------------------- |
| Receiver epoch/barrier identity check | Queued owner input reached the guest after the same viewer regained control |
| Pressed-key release loop              | Final wire sequence retained key-down instead of key-up before Fence        |
| Actual upstream backlog check         | Dispatch resolved instead of rejecting at 65536 and 65537 stalled bytes     |
| Immutable watcher guard               | Watcher key 66 reached the guest after takeover                             |
| Parser lifetime ingress bound         | Over-budget watcher stayed open                                             |
| Normalized-input queue bound          | Receiver stayed open at the 33rd queued input                               |
| Pressed-key count bound               | 65th distinct pressed key was accepted                                      |

Five additional removed-protection controls address the first exact-code review:

| Protection removed                           | Observed failure                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Matching Fence flags                         | Wrong-flags reply completed takeover instead of rejecting                                                           |
| Matching Fence payload                       | Unrelated-payload reply completed takeover instead of rejecting                                                     |
| Fresh post-Fence authorization               | Revoked session completed takeover instead of rejecting                                                             |
| Post-authorization receiver completion check | Old completion reopened readiness while a newer parser-replacement Fence was held, with unchanged policy generation |
| Pointer button release                       | Wire sequence retained pressed pointer buttons before Fence                                                         |

## Independent review ledger

Reviewer `/root/owner_plan_review` is read-only and did not author fixes.

- Plan R1, `e509b0fa5e0c23271ae8f23b82161eec96c92729`: **BLOCKED**. Older post-barrier
  authorization could reopen admission during a newer handoff, and upstream writable buffering
  was unbounded. Receipt SHA-256
  `fe77ae32976dce02d368f302d7e1576e0f52e07ac3b1c4dc5e73ce31dc6781f3`.
- Plan R2, `a679246322c08f94bf55e90251a8bec9085d785a`:
  **PASS_BOUNDED_RECEIVER_IMPLEMENTATION** after explicit epoch/barrier rechecks and pre/post
  backlog bounds. Receipt SHA-256
  `60644ac8722fae9d99ede5eda8586e2c0333bfa9da9e83cb62a17fbfcb679739`.
- Code R1, `b09b19f582c01ad919db8082d8396c536bb17f00`: **BLOCKED_EVIDENCE_CONTROLS**.
  Seven initial mutations did not cover Fence payload/flags, fresh post-barrier authorization or
  receiver-specific completion fencing. The first overlapping-handoff test also advanced policy
  generation, so it could pass independently of the receiving guard. Reviewer established no
  unauthorized-write defect. Receipt SHA-256
  `7d39905c26853b939c878ec612876cbc560da04017a6f1f348294b08e7394220`.
  The test amendment isolates a receiver-only parser replacement and fresh post-Fence denial;
  five added removed-protection controls fail at their intended assertions, followed by restored
  green. Initial receipts remain retained privately.
- Code R2, `a9cfba203e8f3a64b434daa5577d62fca04c1d3c`:
  **PASS_BOUNDED_RECEIVER_DEPENDENCY**, no remaining blockers within the internal #3617 scope.
  Reviewer independently passed 59/59 tests, matched all 12 negative-control and six final-check
  hashes, and verified source/manifests/lock unchanged from the source candidate. Both R1 findings
  are resolved. Receipt SHA-256
  `b6d9a47bf5037e1e79515edf8cea1f3783fe0fd6f45f789e5f8b889301a9bcd1`.
  Acceptance excludes live TigerVNC ordering, owner delivery, merge, deployment and task closure.

## Remaining delivery gates and closure

No production caller, route, owner transport, visible framebuffer, UI or lifecycle operation was
added. No Computer capability is advertised in the app map by this dependency. #3618 must supply
the installed fixed lifecycle/storage and separate gateway contract. #3619 must provide ordinary
owner sessions, exact Origin, active expiry/logout/revocation, trusted assets, HTTPS/WSS, approved
chat UI and truthful app-map/configuration changes. Real TigerVNC Fence ordering, stale-input
and hostile-session controls, runtime readiness and independent closure remain hard gates for
#3616. These issues remain open; no merge/deployment/parent closure is authorized.

Dependency evaluation: retain this bounded receiver for the next integration step. Plan and
independently review #3618's fixed host/gateway/auth/storage/network contract before wiring a live
caller. The existing raw websockify passthrough bypasses this receiver and cannot satisfy that step.

Accepted r21 offline persistence is reused without another standalone qualification. Original
r12 connection and r18 clipboard causes remain unknown. No DB command, runtime, browser, listener,
port reservation or ephemeral credential was created for this dependency. Private receipts live
outside `~/Jarv1s`; historical homes and qualification artifacts were not modified.

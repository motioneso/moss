# Computer owner integration: bounded receiving dependency

Part of #3617 / #3616 / #3577. **Internal receiver verified; owner integration is not delivered.**
Code candidate `bf5b21bd313734598434a6331b406e3b168b0f85` follows the
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
  **57 passed**, including the original 28 controller tests.
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
- Exact code/dependency/evidence review is pending. Plan acceptance is not implementation acceptance.

## Remaining delivery gates and closure

No production caller, route, owner transport, visible framebuffer, UI or lifecycle operation was
added. No Computer capability is advertised in the app map by this dependency. #3618 must supply
the installed fixed lifecycle/storage and separate gateway contract. #3619 must provide ordinary
owner sessions, exact Origin, active expiry/logout/revocation, trusted assets, HTTPS/WSS, approved
chat UI and truthful app-map/configuration changes. Real TigerVNC Fence ordering, stale-input
and hostile-session controls, runtime readiness and independent closure remain hard gates for
#3616. These issues remain open; no merge/deployment/parent closure is authorized.

Accepted r21 offline persistence is reused without another standalone qualification. Original
r12 connection and r18 clipboard causes remain unknown. No DB command, runtime, browser, listener,
port reservation or ephemeral credential was created for this dependency. Private receipts live
outside `~/Jarv1s`; historical homes and qualification artifacts were not modified.

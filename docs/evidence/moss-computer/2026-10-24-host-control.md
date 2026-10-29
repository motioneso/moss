# Computer fixed host control: internal prerequisite

Part of #3618 / #3616 / #3577. This is internal tooling, not installed lifecycle or owner delivery.
Source candidate `5bc76f3489d76a2d72cfbaaf49d9641e68db8eea` implements the
[bounded plan](../../superpowers/plans/2026-10-24-moss-computer-host-control.md).

## Boundary and implemented path

The opt-in `scripts/computer-host.ts` runner exposes only a private Unix HTTP socket. The API
client freshly checks its configured owner's session and sends a fixed operation with an expected
generation; it sends no cookie, session token, image, path, mount, command or Docker ID. Peer
filesystem access is trusted API access, not browser authentication. There is no product route,
installer, app-map capability, startup integration or default dev/prod behavior change.

Host configuration fixes owner/instance UUIDs, canonical dedicated roots, Docker socket and exact
images. Guest image is the adopted source constant. A private marker records root identities;
operation state is fsynced before mutation and preserves resource creation generations, full IDs
and pending intents separately from request generation. Failed operations do not discard cleanup
identities. Unknown create replies are not retried; unresolved intents remain unavailable even
when one pending-name inspect returns404. That conservatism requires later operator recovery design for an
intent that never resolves; missing evidence is never accepted closure.

The Docker adapter uses fixed create/start/inspect/stop/kill/remove requests, captures immutable
IDs and validates names, labels, image defaults, mounts and fixed runtime fields before mutation.
Disable stops the gateway first, retains home data and never asks Docker to remove volumes.
Failure and disable synchronously invalidate the supplied admission port. A throwing invalidator
blocks later launch in that daemon; this is not an active auth/watchdog implementation. Running
status means Docker process state only. No clean browser flush, process resurrection,
receiving readiness, sustained resource fit or usable owner access follows.

**The runner's launch admission is always unavailable.** No configuration flag bypasses it.
Gateway executable/image qualification and the independent admission/watchdog implementation are
successor work. A fake admitted port in tests is only a stand-in. No real Docker mutation, image
load, guest/browser/runtime, listener on TCP, devport or ephemeral credential was created here.
All runtime protections in the dispatch still apply before actual launch.

## Plan review ledger

Independent read-only reviewer `/root/host_security_review` authored no fixes.

- R1, `8bd962df859c653ae26ba573377c437102038aa3`: BLOCKED. Request generation could strand
  older resource identities; unknown create results and root replacement needed explicit rules.
  Receipt SHA-256 `813913e8f2ec0334c5b55f884e16a911b575bb0c60a7aec115f57c59a60075c9`.
- R2, `69799b778c5299a6636a491431638e83105069cb`: PASS_BOUNDED_HOST_PLAN. Separate durable
  resource identities/intents, exact one-shot reconciliation and canonical root identity checks
  resolve R1. Running is process state only; no-launch internal scope accepted.
  Receipt SHA-256 `45aedc695a02fad78ede7fd856c262a74170526b663088be7c29f53ee8deb171`.

## Code-review and security rulings

All reviewers were independent and authored no implementation fixes. Full exact round hashes
and source fingerprints are in the [sanitized JSON receipt](2026-10-24-host-control.json).

- Standards R1 passed the initial implementation; R2 and R3 passed each fix delta. No remaining
  Standards blockers.
- Spec R1 requested two P2 fixes: a non-running final startup status skipped cleanup, and admission
  lacked invalidation. Both accepted. R2 accepted explicit invalidation before disable/on failure,
  final startup rejection, best-effort verified cleanup and retained failed identities. R3 accepted
  the subsequent known-ID recovery amendment. No remaining bounded Spec blockers.
- Security implementation R1 blocked known-ID404 recovery: a lost successful DELETE reply or
  independently removed member could strand the surviving pair. Accepted and fixed: only404 on
  the initial immutable-ID container inspect proves absence; image/spec404 and pending-name404
  never erase identity. Full matching inventory still precedes mutation. R2 accepted exact source
  `5bc76f3489d76a2d72cfbaaf49d9641e68db8eea` and independently ran four focused regressions
  (4 passed,35 skipped, exit0; test-log hash in its review receipt). No remaining bounded security
  implementation blockers.
- Historical blocked rulings remain preserved; none claims actual runtime or owner acceptance.
  Independent exact evidence review accepted `4971a885885276b5857ec104ec7fd216ef5a26bb` as
  PASS_BOUNDED_HOST_EVIDENCE; source remains the accepted checkpoint above. Receipt SHA-256
  `5afe8d6a827d07166b1981e90395e7c2939019f5c148deb714715af471f9a336`.
- Final documentation Standards and Spec reviews accepted the same evidence/handoff checkpoint.
  Their exact hashes are in JSON. A supplemental formatter run also covers all newly tracked docs.
  This ledger amendment does not alter implementation, runtime scope or remaining owner gates.

## Verification

All commands below exited0 on the final restored source. Root/tests TypeScript initially exposed
missing existing visual-chat spike dependencies; scoped frozen offline installation corrected
that environment without changing manifests or lockfiles. No DB/foundation command was run.

| Check                                           | Result                   |
| ----------------------------------------------- | ------------------------ |
| Root `pnpm exec tsc --noEmit`                   | exit0                    |
| `pnpm exec tsc -p tsconfig.tests.json --noEmit` | exit0                    |
| Scoped host + existing receiver Vitest          | 102 passed,4 files,exit0 |
| Scoped ESLint, max warnings0                    | exit0                    |
| Scoped Prettier                                 | exit0                    |
| `pnpm check:file-size`                          | exit0                    |
| `git diff --check`                              | exit0                    |

The Unix IPC tests use a recording native HTTP Docker stand-in, synthetic owner/session bindings
and temporary directories. They cover replacement with retained home, durable restart/disable,
pending intents, ambiguous identity, partial failure, early exit, failed cleanup and admission
invalidation. **They do not establish real Docker compatibility, guest runtime, actual storage
qualification, live TigerVNC ordering or active owner-session enforcement.**

Eleven separate removed-protection controls each exited1 at its intended assertion: owner, CAS
generation, root identity, container labels, runtime envelope, HTTP response bound, fresh auth,
final startup-running guard, admission invalidation, known-ID recovery and pending-intent
retention. Source was restored after each mutation; the full102-test suite passed afterward.
Private logs were checked for the named failing assertion; exact log hashes are in JSON. The
recording stand-in deliberately destroys successful DELETE replies to exercise unknown outcomes.

## Required successor acceptance

Keep #3618/#3616/#3577 open. Build and independently qualify the separate receiving gateway,
framebuffer/decoder bounds, exact auth fresh-check/invalidation IPC, independent runtime admission
and watchdog, actual fixed lifecycle operations and closure. Reuse accepted r21 persistence rather
than launch another standalone qualification. R12 connection/r18 clipboard causes remain unknown.

Then #3619 wires ordinary owner cookies/exact Origin, active expiry/logout/revocation, trusted
bundled viewer assets and actual HTTPS/WSS to the approved concise chat layout. Parent acceptance
requires real login→chat/browser→visible frame/input→takeover→return/controlling-close, hostile
active sessions and stale-input/key-release controls at the receiving seam, independent exact
evidence and resource closure. Idle sleep/wake, confined Internet egress and release/platform
claims remain separately bounded. No production deployment is authorized.

After this internal candidate passes code-review Standards+Spec, resolves findings and verifies,
merge its PR and launch/verify a fresh isolated successor. Carry that same instruction through
all successors until real owner integration is finished; a merged prerequisite does not finish it.

The next session starts from the [committed gateway continuation](../../superpowers/handoffs/2026-10-24-moss-computer-gateway-integration.md).

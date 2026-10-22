# Outlook user setup implementation record

Tracking: #3570; draft PR #3571. Current checkout:
`~/Jarv1s/.claude/worktrees/outlook-production-next`, local branch `moss/outlook-production-next`;
push to the existing PR head `moss/outlook-user-setup-design`. The approved flow and build spec
remain authoritative.

## Implemented internal foundation

- New connectors migration `0332_outlook_browser_lifecycle.sql`; applied migration 0331 is unchanged.
- One owner-scoped setup with runtime reference, generation, lifecycle and identity hash.
- Idempotent creation serialized per owner; replacement waits for confirmed cleanup.
- Viewer/collector leases carry generation, kind and session metadata; expiry uses injected time.
- Identity mismatch pauses the record; reconnection retains the original identity hash.
- Revocation increments generation and clears the lease in the same transaction that queues cleanup.
- Setup deletion queues cleanup through a database trigger. The queue has no user foreign key or
  account address, so deletion cannot cascade away pending profile-removal work.
- Worker-only claim/ack functions retry failed cleanup with bounded backoff and reclaim abandoned
  claims. Only successful runtime removal acknowledgment transitions a surviving setup to removed.
- `sweepOutlookBrowserLifecycle` expires abandoned setups and dispatches one cleanup batch through
  an injected runtime removal port. **It is not registered with a scheduler yet.**
- Migration catalogue, module ownership and deletion counts updated. Actual account-export test
  checks that internal runtime references and identity hashes are omitted.

These are database/recovery components. They do not yet authorize browser frames/input or provide
a working self-service connection. No new routes, Settings controls, runtime env requirements or
app-map capabilities are exposed by this slice. The existing operator-bound integration is unchanged.
The recovery tests inject runtime removal; they do not prove deletion of a real browser profile.

## Managed runtime primitives

`infra/outlook-browser/` now implements a durable host inventory, per-runtime Unix CONNECT egress,
fixed rootless Podman container/profile operations and their internal composition. Removal records
a permanent tombstone before revoking tunnels and deleting resources. Request cancellation drains
the external engine operation before releasing the inventory lock. No viewer, collector or
installation/deployment wiring ships in this slice. A pinned candidate browser image now exists;
its maintenance and release acceptance remain unfinished.

Verification: `pnpm test:outlook-runtime` runs 38 tests and twelve guard-removal controls in CI.
Actual rootless Python fixtures also exercised public Microsoft TLS, 14 network checks, a real
network-none negative control, separate profile volumes, idempotent allocation, container/profile
deletion, inventory restart and unaffected second runtime. These are transport/engine proofs,
not Chromium, real user authentication or Microsoft sign-in proofs. See the runtime README for
commands and limitations. The tests use no account or production services.

## Private lifecycle service

The host entrypoint now composes the runtime behind a bounded Unix JSON-line protocol exposing
only allocate/remove. Peer UID and private directory/socket permissions are checked. Requests
contain only runtime ID, generation and operation; responses return a boolean and never echo
requests or exception diagnostics. Moss user/session authorization remains unimplemented.

A permanent-file singleton lock covers broker lifetime and external engine-command supervisors.
The supervisor prevents Podman inheriting its lock descriptor: a real-engine test showed
that passing it directly lets a detached monitor hold it indefinitely. The corrected path passed
lock reacquisition with another real fixture container still running. On timeout, a supervisor
requests broker shutdown through a parent pidfd and drains the command instead of acknowledging
uncertain completion. A user-service template terminates the old cgroup before restart. Startup
tries pending removals before restoring sockets and accepts requests after that recovery pass.
Failed cleanup/restoration keeps the affected runtime pending with egress closed and does not
block other owners' restoration. Failed cleanup remains unacknowledged for worker retry.

Actual user-systemd tests ran the real service/protocol with a disclosed slow external-engine
stand-in: main-process SIGKILL, old-command termination, restart/recovery, removal and tombstone.
Changing KillMode to process demonstrated an orphan completing a late creation. Unit tests also
kill an actual broker subprocess and verify its surviving command supervisor blocks replacement
until completion. These tests do not prove hard-crash recovery of actual Podman or Chromium.

Crashes inside Podman/storage operations beyond the tested boundaries below,
discovering/refreshing public host/app ingress deny addresses, and the remaining browser
network/architecture acceptance remain hard merge blockers. The unit is not
installed/enabled, no app/worker mounts are added yet, and the legacy runtime is unchanged.

## Candidate Chromium image

The image pins its base manifest and direct Chromium/websocket-client packages. Only a fixed
runner, loopback relay and browser policy are copied, with a fresh profile directory. The runner
waits for the relay before starting Chromium at about:blank and supervises both child processes.
The proxy configuration disables Chromium's implicit loopback bypass; DNS rules exclude only the
numeric proxy address. A narrowly derived seccomp policy preserves unrelated host-default rules.
Neither an arbitrary-CDP helper nor a test-only bypass flag is shipped in the image.

Native x86_64 account-free proof exercised the real Runtime/Podman/Egress path: two Chromium
namespace/seccomp diagnostics, public Microsoft HTTPS, separate fresh browser storage, selected
private IPv4/IPv6 and local-CDP navigation denials, graceful profile persistence, actual volume
removal and the unaffected second browser. Two derivative test images remove sandbox and loopback
protections individually; the actual browser assertions fail in both cases. Unit coverage also
checks seccomp-rule preservation and rejects a permissive source policy with a guard-removal control.

This is candidate-image evidence, not maintained release delivery, ARM64, real sign-in/MFA,
complete managed-policy behavior coverage, full redirects/rebinding/public IPv6, host/app public
ingress denial, service hard-crash recovery, Moss auth/viewer or live product proof. Those remain
hard blockers. The legacy connection and production deployment remain untouched.

Native browser receipt: immutable candidate
`sha256:65311904714ff46cc028ec495e666de1bb954043d996ddc81628049343f0e52b`,
Chromium package `149.0.7827.53-r0`; `verify_browser.py` exited 0 with six proof groups,
including both actual guard-removal assertion failures. No certificate bypass was used.

## Actual service/engine crash boundaries

`verify_podman_service.py` now runs the real lifecycle service in disposable user units with actual
rootless Podman and the candidate Chromium image. A disclosed test-only PATH barrier delegates to
the real engine, pauses after successful `run` or `rm`, and withholds completion while the test
kills the main broker. The allocating record recovers with its profile marker; the removing record
finishes deleting its remaining volume before the service listens again. Both cases verify the
second runtime's marker. Removed references remain rejected. Candidate source bytes and Chromium's
own namespace/seccomp diagnostics are checked through test-side exec.

The KillMode=process control observes the same positive cgroup assertion fail, then releases the
orphan to execute a real `run` and create candidate Chromium after broker death. This is actual
engine/container evidence at deterministic command boundaries, not exhaustive proof of interrupted
engine/storage transactions. The wrapper is not installed in the service or image.

Native x86_64 receipt: image
`sha256:c958299592f86f55196d8bdd07ce72f8f9669b656410de8fbf8990abc021e507`, built from the same
pinned candidate inputs. Both positive crash groups and the actual orphan-creation control passed.
The store was selected by explicit engine root/runroot options on a separate disk. No accounts,
production services or live connector were used. Test containers/volumes/units are removed by the
verifier; the task's disposable image store is removed after verification.

## Effective candidate policy checkpoint

`verify_policies.py` exercises the actual Runtime/Podman/Egress candidate on native x86_64.
All nine configured policies report the expected values, Platform source, Machine scope,
Mandatory level and OK status in Chromium's policy page. The settings API reports five enforced
false preferences: address/card autofill, background mode, password saving and browser sign-in.
Attempts to change them to true are rejected and leave them false. These checks and the bounded
synthetic Blob-download denial pass again after graceful browser restart.

Two derivative images change only policy JSON. Clearing it makes all nine policy assertions and
all five preference assertions fail. All five previously rejected preference writes then succeed,
leave the values true and fail the same write-rejection assertion. It also actually saves the
synthetic download. Removing only DownloadRestrictions saves the same bytes and fails the exact
positive no-download assertion;
the other eight policies and five preference locks still pass. Headless saving is explicitly
allowed through test-side CDP in both paths, with the same user gesture and five-second observation.
Runner/relay bytes and policy values are checked, along with Chromium's namespace/seccomp diagnostics.

Native candidate receipt: `sha256:fa8063fc021b61c3e52bc7ea7d441f68848a793e74226942ee6bd849bb3566b2`;
`verify_policies.py` exited 0, four proof groups. This checks reported policy state, actual
preference locks and the tested download route; it does not establish every download route,
printing behavior, notification prompts, sync/sign-in UI or password-form behavior. Those limits,
ARM64 and the existing network/product/deployment blockers remain. No accounts or production
services are used. The native command and disposable-store options are in the runtime README.
Proof containers, profile volumes, control/candidate images and the disposable engine store were
removed after verification. Runtime unit verification passed 38 tests plus twelve guard-removal
controls. No database-touching test ran in this policy-only continuation.
Full `pnpm verify:static` exited 0 at `4673358ff`; the subsequent Python-verifier/Markdown
follow-up passed the strengthened native proof, touched-document formatting and diff checks.

## Remaining build work

1. Complete production host broker browser operations and maintained browser image. Persisted
   tombstones reject delayed allocations after cleanup. Actual service-crash/orphaned-command
   tests now cover the boundaries above; interrupted engine/storage transactions and supported-host
   coverage remain unverified. Never reuse a removed runtime reference. Complete public host/app
   ingress denial and actual Chromium sandbox/network checks before claiming browser isolation.
2. Private Unix transport, installer and every affected deployment configuration; optional runtime
   absence must preserve the legacy integration. Wire lifecycle sweeping when that service exists.
3. Real browser-session authentication, same-origin/CSRF checks and runtime leases on all viewer
   operations. Database session-ID matching alone is not authentication or immediate revocation.
4. Owner-visible setup contracts/routes, live rendered identity detection and source confirmation.
   The confirmation path must acquire exclusive runtime access and reverify identity immediately.
5. Calendar binding, generation checks after scans, atomic legacy handover, disconnect removing
   imported events, and durable runtime cleanup. The repository's revoke method alone does not
   disconnect a connector account or remove its events.
6. Settings and separate viewer UI using the approved mockups; truthful app-map declarations.
7. Remaining security negative controls, isolated foundation/CI gates, actual runtime cleanup,
   two-user live UI proof, human Microsoft sign-in/MFA, phone/Firefox, both image architectures,
   and empty-image install/update/uninstall proof.

## Verification record

Run `scripts/run-gate.sh start --gate test:integration:3570` using the verify-gate skill.
It covers the lifecycle tests, legacy mirror, connectors catalogue, foundation catalogue,
account deletion and actual account export. `test:integration:3570:lifecycle` is the narrow lane
for deliberate guard-removal negative controls. Verification receipts are recorded on the draft PR.

The draft remains incomplete and must not merge. No production migration or deployment has run.

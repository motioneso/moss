# Outlook user setup implementation record

Tracking: #3570; draft PR #3571. Worktree: `~/Jarv1s` task checkout, branch
`moss/outlook-user-setup-design`. The approved flow and build spec remain authoritative.

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

## Remaining build work

1. Production host broker, maintained browser image, rootless isolation and controlled HTTPS egress.
   The broker must persist revocation tombstones: a delayed allocate must not recreate a runtime
   after cleanup acknowledged its removal. Never reuse a removed runtime reference.
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

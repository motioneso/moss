# Continue Computer receiving gateway and owner delivery

Ben authorized the continuation on 2026-10-23: "Please run code-review and merge when findings
resolved. Then hand off to a new session for next steps (and tell it to code-review and merge when
finished too and so on until this is finished)".

This authority persists through successor sessions for #3616 owner integration. After each bounded
slice: code-review Standards + Spec against a pinned main merge-base → resolve findings → verify
the exact candidate and required checks → merge → launch and verify a fresh isolated successor
for remaining work. Carry these instructions into every handoff until actual owner integration
predicates pass. A merged prerequisite is not completion. Production deployment and bypassing
review, runtime-admission or live-path gates are not authorized.

## Start

1. Stay in the fresh assigned worktree/branch. Read `AGENTS.md`, `CLAUDE.md`,
   `docs/DEVELOPMENT_STANDARDS.md`, the
   [original owner dispatch](2026-10-23-moss-computer-owner-integration.md),
   [lifecycle dispatch](2026-10-24-moss-computer-lifecycle-integration.md),
   [owner plan](../plans/2026-10-23-moss-computer-owner-integration.md),
   [persistent desktop spec](../specs/2026-10-23-moss-computer-persistent-desktop.md), especially
   sections24–27, the [host plan](../plans/2026-10-24-moss-computer-host-control.md), and both
   [receiver evidence](../../evidence/moss-computer/2026-10-23-owner-receiver.md) and
   [host evidence](../../evidence/moss-computer/2026-10-24-host-control.md) with their JSON receipts.
   Search Hindsight first; prefer the codebase graph for discovery. Read repository plan-build
   before planning, shared-checkout before commits, design-system before UI, verify-gate before
   any DB/foundation command. Inspect installed dependencies and cache before scoped frozen
   install; keep short live state in your own private sibling directory, outside the worktree.
2. Confirm PR#3624 actually merged, inspect final HEAD/review/check/evidence records and current
   main source. Its accepted source checkpoint is `5bc76f3489d76a2d72cfbaaf49d9641e68db8eea`;
   later commits add evidence/handoff or resolve new findings. Receiver PR#3621 merged at
   `9ff285c01162535a15fb2cb06d52d52328bc1114`. Live-check #3577/#3616/#3617/#3618/#3619.
   Reuse accepted r21 persistence: no new standalone qualification. R12 connection and r18
   clipboard causes remain unknown. Historical private artifacts are read-only.
3. Continue #3618 with the **separate receiving gateway**, exact auth fresh-check/invalidation
   channel and independently supervised runtime admission. Begin with a seams check citing actual
   source, then commit a bounded implementation plan and exact runtime/auth/storage/network
   contract. Obtain independent read-only security/spec review before implementation or launch.
   Choose an honestly bounded dependency if needed; carry the same autonomous chain forward.
   Missing gateway/auth/admission services are implementation work, not routine questions for Ben.
4. Build the gateway around the accepted `ComputerRfbInput` receiving seam with sole upstream
   access, trusted bundled viewer protocol, framebuffer/decoder/connection bounds and a real auth
   IPC implementation. The raw websockify passthrough bypasses the receiver and cannot establish
   owner-input exclusion. Preserve parser epochs, queue bounds, fresh post-Fence auth, pressed
   input releases and matching upstream Fence acknowledgement. The fixture supplies a Fence
   extension missing from the library stand-in: no fixture reply substitutes for live TigerVNC
   proof. Inspect actual adopted server behavior and resolve protocol issues, never infer ordering.
5. Define and implement the exact gateway→auth fresh-check and push invalidation path. Owner cookie
   and exact trusted Origin resolve at the API before upgrade. Gateway gets a server-issued
   viewer/session binding, never credentials through a URL or guest mount. Bound correlated replies
   to2s, reject delayed replies/epochs, honor absolute expiry, poll active liveness at most2s apart
   with2s deadline, push logout/revocation and invalidate on denial/timeout/disconnect. Include
   ordinary Better Auth logout and explicit session-service/admin revocation paths. Per-input
   checks alone are insufficient. The host client assertion is trusted API IPC, not browser auth.
6. Keep host control fixed and API away from Docker/devices/generic exec. Complete gateway build
   and exact image qualification before configuring its hash. The existing runner deliberately
   supplies `unavailableAdmission`; do not replace it with an always-successful admission or a
   configuration bypass. Implement independently accepted fresh resource admission, watchdog,
   synchronous receiving invalidation and independent closure before actual enable/recreate.
   Preserve request CAS vs durable resource creation generations, full immutable IDs, pending
   intents, unknown-create no-retry behavior, canonical root identities, exclusive lock and failed
   cleanup identities. An unresolved intent requires explicit recovery design, not treating404
   as evidence of absence. Only known immutable-ID container inspect404 can reconcile absence;
   image/spec404 cannot. Disable fences gateway first, retains dedicated home and never deletes
   volumes. Running status is process state, not receiving readiness or owner usability.
7. Before live work, independently accept the exact committed contract and obtain fresh
   RAM/root≥8GiB/data≥30GiB admission and healthy Moss. Use the adopted exact image, protected
   dedicated data, claimed devports, bounded resources, independent watchdog/stop intent and
   exact-label closure from the dispatch. Guest remains offline/network-none; no unrestricted
   bridge fallback. Do not restart production or substitute its data to meet floors. No real
   Docker mutation, image load or guest launch occurred in the host prerequisite. Its102 tests use
   real Unix IPC with a recording Docker HTTP stand-in only. A fake admission/auth/Fence result
   is not runtime acceptance; complete actual fixed lifecycle operations and closure for #3618.
8. When reviewable, run code-review Standards+Spec, resolve findings, run root/tests TypeScript,
   scoped lint/format/file-size, relevant behavior and observed failing removed-protection controls,
   then independently review exact candidate/evidence. Required CI and applicable live predicates
   must pass before merge. Keep #3618/#3616/#3577 open until their actual acceptance passes.
   Commit/push all useful docs; stop owned resources and leave a clean tree. No DB/foundation
   command without verify-gate and an isolated target.
9. Continue #3619 or launch/verify a fresh isolated successor through herdr-handoff for remaining
   work, carrying this same chain. Verify actual execution, not just a pane or handoff file; record
   its durable agent name and `agent_session.value`. Give Ben a brief accurate status.

## Next owner acceptance

#3619 wires actual ordinary owner HTTPS/WSS, trusted viewer assets and the approved chat design:
full-screen recent still, expanded view beside conversation, compact drawer/phone entry, concise
labels and record-derived status. Mockups are already approved; do not ask to reapprove them.
Update affected dev/prod configuration and Moss app-map declarations in the same product PR.
Preserve watcher isolation, intentional takeover/return/controlling close, unexpected-loss pause,
stale-input fencing and fresh agent leases.

Full #3616 delivery requires executable real login→chat/browser→visible frame/input→takeover→
return/intentional-close proof. Observe hostile/expired/revoked active-session and stale-input/
key-release controls at the actual receiving seam; independently accept exact evidence and
resource closure. No status claim or green internal suite replaces this path. Idle sleep/wake,
useful confined Internet egress and release/platform claims remain separately bounded work in
the approved spec. Persistence is files/bookmarks, not process/package/arbitrary site sessions.

Predecessor private receipts are in sibling `../moss-computer-lifecycle-private/`; use hashes in
committed evidence, never publish private logs or host details. Main project is conventionally
`~/Jarv1s`; documentation must not expose personal absolute paths. No production deployment is
authorized. Continue until owner integration is actually finished.

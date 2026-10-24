# Continue Computer receiving gateway, runtime admission and owner delivery

Ben authorized the continuation on 2026-10-23: "Please run code-review and merge when findings
resolved. Then hand off to a new session for next steps (and tell it to code-review and merge when
finished too and so on until this is finished)". This authority persists through the successor
chain for actual #3616 owner integration. A merged prerequisite does not finish the task.

After each bounded slice: run independent code-review Standards + Spec against a pinned main
merge-base, resolve findings, verify the exact candidate and applicable checks, independently
review evidence, merge, then launch and verify a fresh isolated successor with this same instruction
until owner acceptance passes. Production deployment and bypassing review, runtime admission or
live-path gates are not authorized. Resolve routine engineering choices autonomously.

## Start

1. Stay in this assigned fresh worktree and branch. Search Hindsight first; read `AGENTS.md`,
   `CLAUDE.md`, `docs/DEVELOPMENT_STANDARDS.md` and the complete
   [gateway dispatch](2026-10-24-moss-computer-gateway-integration.md), following its linked
   owner/lifecycle dispatches, owner/host plans, persistent desktop spec sections24–27 and evidence
   receipts. Read [auth IPC plan](../plans/2026-10-24-moss-computer-auth-ipc.md) and
   [auth evidence](../../evidence/moss-computer/2026-10-24-auth-ipc.md) with its JSON receipt.
   Use graph tools for code discovery, repository plan-build before planning, shared-checkout
   before commits, design-system before UI, verify-gate before any DB/foundation command.
   Inspect dependency installation/cache before choosing a scoped frozen install. Keep live state
   and private logs in a new sibling directory outside the worktree. Historical private artifacts
   are read-only. Write documentation paths as `~/Jarv1s`.
2. Confirm PR #3627 actually merged and inspect its exact final review/check/evidence records and
   current main source. Its accepted source checkpoint is `371386564566b44190cc269b1c1845a683899ea1`;
   later commits record evidence and this dispatch. Prior host PR #3624 merged as
   `77c1fe9c23144c9ceb987b714ed9c916c0068135`; receiver PR #3621 merged as
   `9ff285c01162535a15fb2cb06d52d52328bc1114`. Live-check #3577/#3616/#3617/#3618/#3619.
   Reuse accepted r21 persistence; no new standalone qualification. R12 connection and r18
   clipboard causes remain unknown.
3. Begin with a current seams check for the **separate receiving gateway** and independently
   supervised runtime admission. Commit a bounded implementation plan and exact runtime, auth,
   storage and network contract. Obtain independent read-only security/spec acceptance before
   implementation or launch. Missing gateway/admission services are implementation work. Keep
   slices bounded; carry this autonomous merge/successor chain forward when work remains.
4. Consume the implemented auth transport rather than reimplementing session lookup or revocation.
   `packages/auth/src/session-invalidations.ts` owns synchronous pre/completion events. Actual
   auth runtime shares that source with Better Auth session deletion hooks, explicit session
   service operations and admin revocation, and closes it before its pool.
   `apps/api/src/computer/auth-server.ts` exposes opt-in `serveComputerAuth`; `auth-client.ts`
   exposes `connectComputerAuth`; `auth-channel.ts` owns the fixed bounded protocol. No listener
   is installed by normal API boot and no owner route is added in this prerequisite. Later API
   composition must resolve a real owner cookie and exact trusted Origin before upgrade, issue
   its fixed server binding and give the trusted gateway its viewer ID over private IPC. Do not
   put credentials or viewer IDs into browser URLs or guest mounts. The channel is trusted API
   IPC, not browser authentication. Its parent must be canonical0700 with trusted ancestors;
   private bind + chmod0600 + exclusive hardlink publication preserves replacement endpoints.
5. Gateway must own sole upstream access through accepted `ComputerRfbInput`, with trusted bundled
   viewer protocol, bounded framebuffer/decoder/connection handling, immutable parser epochs,
   queues, fresh post-Fence authorization, pressed-input releases and matching upstream Fence
   acknowledgements. Raw websockify bypasses the receiver and cannot prove input exclusion.
   Auth client push retirement must synchronously fence the receiving policy and input writer;
   per-input checks alone are insufficient. Preserve two-second correlated checks, idle liveness,
   fixed absolute expiry, no retry/late resurrection and deny/disconnect retirement. The fixture's
   Fence extension is absent from the library stand-in: inspect actual adopted server behavior
   and resolve protocol issues. Fixture replies never substitute for live TigerVNC proof.
6. Keep fixed host control and API isolation from Docker/devices/generic exec. Build and qualify
   the exact gateway image before configuring its hash. The host runner deliberately uses
   `unavailableAdmission`; replace it only with independently accepted fresh resource admission,
   watchdog, synchronous receiving invalidation and independent closure. Never use an
   always-successful admission or configuration bypass. Preserve request CAS versus durable
   creation generations, full immutable IDs, pending intents, unknown-create no-retry behavior,
   canonical root identity, exclusive lock and failed-cleanup identities. Unresolved intents
   need explicit recovery design. Only known immutable-ID container inspect404 reconciles
   absence; image/spec404 cannot. Disable fences gateway first and retains dedicated home;
   deletion is excluded. Process running status is not receiving readiness or owner usability.
7. Before live work, independently accept the exact committed contract and obtain fresh
   RAM/root≥8GiB/data≥30GiB admission plus healthy Moss. Use the adopted exact image, protected
   dedicated data, claimed devports, bounded resources, independent watchdog/stop intent and
   exact-label closure from inherited dispatches. Guest stays offline/network-none; no unrestricted
   bridge fallback. Do not restart production or substitute its data to meet floors. The auth
   prerequisite used real Unix IPC, in-memory vendor adapter and recording SQL only; no actual
   DB/Docker mutation, image load or guest launch. The host prerequisite uses recording Docker
   HTTP only. Those are not runtime acceptance. Complete actual fixed lifecycle operations and
   independently accepted closure for #3618 before claiming installed usability.
8. Continue #3619 ordinary owner HTTPS/WSS, trusted viewer assets and approved chat design:
   full-screen recent still, expanded view beside conversation, compact drawer/phone entry,
   concise labels and record-derived status. Mockups are approved. Update affected dev/prod
   configuration and Moss app-map declarations in the same product PR. Preserve watcher
   isolation, intentional takeover/return/controlling close, unexpected-loss pause, stale-input
   fencing and fresh agent leases. This requires real login→chat/browser→visible frame/input→
   takeover→return/intentional-close proof, hostile/expired/revoked active sessions, stale input
   and pressed releases at the actual receiving seam. Independently accept exact evidence and
   resource closure; green internal tests do not complete #3616/#3577. Idle sleep/wake, useful
   confined Internet egress and release/platform claims remain separately bounded work.
9. Run code-review Standards + Spec against the pinned base, resolve findings, root/tests
   TypeScript, scoped lint/format/file-size, relevant behavior and observed failing removed-
   protection controls. Obtain independent exact-candidate/evidence review and required green CI
   before merge. Keep #3618/#3619/#3616/#3577 open until their actual predicates pass. Commit/push
   useful documents, stop owned resources and leave a clean tree. Launch/verify the next isolated
   successor through herdr-handoff with this same continuing authority and all runtime/live gates.
   Verify actual handoff-read execution and record durable routing name plus `agent_session.value`,
   not just a pane ID. Do not repeat an agent start after timeout without inspecting registration,
   execution and session metadata first; timeouts can occur after successful execution.

## Evidence boundary and prior review rulings

Auth source `371386564` passed independent Standards, Spec and security R2. R1 findings were
accepted and resolved: Node close automatically removes its bound pathname before a later inode
check, so use a private bind and explicit alias cleanup; preflight backlog plus frame before write;
remove the redundant per-socket pending counter because the global actual-work budget owns it.
Before-only revocation misses registrations racing DELETE; retain vendor before/after and SQL
before/finally events. Do not release outstanding auth-work accounting when a socket closes.

See the committed auth evidence for final command exits, negative controls and reviewer hashes.
Private receipts for this predecessor are in sibling `../moss-computer-gateway-private/`; never
publish their raw logs, session metadata, credentials or host details. This dispatch authorizes
continuation, not production deployment or declaring owner integration complete.

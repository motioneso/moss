# Continue Computer through lifecycle and real owner delivery

Ben authorized the continuation on 2026-10-23: "Please run code-review and merge when findings
resolved. Then hand off to a new session for next steps (and tell it to code-review and merge when
finished too and so on until this is finished)".

This authority carries through successor sessions for this owner-integration work. After each
bounded slice, run code-review, resolve findings, verify the exact candidate and required checks,
then merge its PR. Use herdr-handoff to launch and verify a fresh isolated successor for remaining
work. Preserve this instruction in every successor handoff. Continue until #3616's actual owner
integration predicates pass; a merged prerequisite alone does not finish the assignment.
This supersedes earlier dispatch restrictions on merging these scoped PRs. Production deployment
and bypassing review, runtime-admission or live-path gates are not authorized.

## Start

1. Stay in the new isolated worktree/branch assigned at launch. Read `AGENTS.md`, `CLAUDE.md`,
   `docs/DEVELOPMENT_STANDARDS.md`, the
   [owner-integration dispatch](2026-10-23-moss-computer-owner-integration.md),
   [current plan](../plans/2026-10-23-moss-computer-owner-integration.md),
   [persistent desktop spec](../specs/2026-10-23-moss-computer-persistent-desktop.md), especially
   sections 24–27, and [receiver evidence](../../evidence/moss-computer/2026-10-23-owner-receiver.md)
   with its JSON receipt. Search Hindsight and use the codebase graph for discovery. Read repository
   plan-build before planning, shared-checkout before commits, design-system before UI, and
   verify-gate before any DB/foundation command. Inspect installed dependencies before choosing
   a scoped frozen install; retain short private live state outside the worktree.
2. Check live main and PR #3621: the predecessor must have merged the reviewed receiving dependency
   before dispatch. Its independently accepted implementation was `bf5b21bd3`, test amendment
   `59c50b636`, final evidence checkpoint `192bb5933`; subsequent changes may record this handoff
   and resolve new code-review findings. Inspect the actual merged source and final PR reports.
   Reuse accepted r21 persistence without another standalone qualification. Original r12 connection
   and r18 clipboard causes remain unknown. Live-check #3577, #3616, #3617, #3618 and #3619.
3. Begin #3618, the fixed lifecycle/storage and isolated gateway prerequisite. Inspect current
   host-operation, deployment, gateway and auth seams, citing actual source lines. Commit a bounded
   implementation plan and exact runtime/auth/storage/network contract before code or launch;
   obtain independent read-only security/spec review. Resolve engineering choices autonomously.
   A missing service is work to implement, not a reason to ask Ben to choose routine details.
4. Implement the reviewed fixed-operation host interface for one configured Computer and owner,
   the adopted pinned image, durable home/socket and separate bounded trusted receiving gateway.
   Keep the API away from Docker sockets, devices, generic exec and request-derived image/path/
   mount operations. Disable retains dedicated data; deletion is a separate explicit operation.
   Define the real gateway-to-auth fresh-check and invalidation channel and sole upstream access.
   Missing/stopped/unqualified prerequisites report unavailable. Existing raw websockify
   passthrough bypasses the receiver and cannot establish the required owner-input boundary.
5. Apply all runtime protections in the original dispatch and implementation handoff. Before live
   work, independently accept the exact committed contract and obtain fresh resource admission.
   Keep the guest offline/network-none unless a confined egress contract is separately reviewed.
   Use the exact adopted image and protected durable data, claimed devports, independent watchdog,
   bounded resources and independent closure. An API unit test or fixture Fence reply cannot
   replace actual runtime proof. Prefer scoped non-DB checks first; DB work needs verify-gate and
   an isolated target. Never substitute production data or restart production to satisfy floors.
6. When #3618 is reviewable, run code-review's Standards and Spec axes against a pinned main
   merge-base, resolve findings and rerun affected checks. Include root/tests TypeScript, scoped
   lint/format and relevant behavioral/negative controls; record independent exact-candidate and
   evidence review. Merge only after required checks pass and applicable live predicates are
   satisfied. Keep evidence honest about anything unverified. Commit/push all useful documents,
   close owned resources and leave a clean tree.
7. If real owner integration is still unfinished, launch a fresh isolated successor through
   herdr-handoff for #3619 (or the next honestly bounded dependency), carrying the same autonomous
   code-review → resolve → verify → merge → handoff instruction. Verify the successor is actually
   executing, record its durable agent name/session ID, and give Ben a brief status. Do not stop
   at writing a handoff or merely creating a pane.

## Receiving checkpoint and remaining acceptance

The receiver composes ComputerInputControl with one RFB writer, immutable parser/queue epochs,
pressed-key/button releases, matching upstream Fence replies and fresh post-barrier authorization.
Parser replacement advances the receiving epoch even when policy generation stays unchanged.
The accepted checkpoint passed 59 tests, root/tests TypeScript, scoped lint/format/file-size and
12 observed removed-protection controls. Review rulings and hashes are in the evidence ledger;
predecessor private receipts are in the sibling `../moss-computer-owner-integration-private/`.
Historical qualification homes/artifacts remain read-only; create this session's own private root.

These are internal receiving checks, not live TigerVNC ordering or owner security acceptance.
The fixture supplies the library server's missing Fence extension. Full decoder/framebuffer
bounds belong in the separate gateway envelope; the receiver is not a production caller or
visible viewer. Reconfirm current source before using a remembered checkpoint.

#3619 must wire ordinary Moss owner cookies, exact trusted Origin, fresh session checks and active
expiry/logout/revocation to real HTTPS/WSS and trusted bundled viewer assets. Per-input checks
alone are insufficient. Preserve watcher isolation, intentional takeover/return/controlling close,
unexpected-loss pause, stale-input fencing and fresh agent leases. Update affected dev/prod
configuration and the app map in that same PR.

Use the already approved chat design: full-screen recent still, expanded view beside conversation,
compact drawer/phone entry, concise labels and record-derived status. No new approval of the same
mockups is needed. Full #3616 acceptance requires executable real login → chat/browser → visible
frame/input → takeover → return/intentional-close proof, hostile/expired/revoked active-session
and stale-input/key-release controls observed at the receiving seam, exact independent evidence
review and resource closure. Keep parent/qualification status truthful until those predicates pass.

Idle sleep/wake, useful confined Internet egress and release/platform claims remain separately
bounded work in the approved spec; do not turn file/bookmark persistence into process/package/
arbitrary site-session promises. Continue the authorized owner-integration chain without silently
expanding those claims or stopping after green internal parts.

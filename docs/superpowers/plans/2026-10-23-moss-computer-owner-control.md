# Moss Computer: owner-control foundation and integration design

Part of #3605 / parent #3577. Depends on unmerged draft #3598; stack this candidate on
`qualify/moss-computer-startup-readiness-r9`. Authority: the committed
[implementation dispatch](../handoffs/2026-10-23-moss-computer-implementation.md) and
[persistent desktop spec](../specs/2026-10-23-moss-computer-persistent-desktop.md).
No merge, deployment or issue closure. Operator/implementer: Codex `/root`.
Independent reviewer: `/root/implementation_review`.

## Prerequisite ledger

| Requirement                                                       | Current evidence                                                                                                                       | Dependency                                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Startup, protected viewer, fresh keyboard input                   | Accepted r11 report/JSON and exact review                                                                                              | Reuse bounded acceptance; synthetic identities are not owner auth                  |
| Rapid restart; bounded delayed restart and explicit reload        | Accepted r3/r4 evidence                                                                                                                | No arbitrary-outage or sustained-fit claim                                         |
| Adopted-image active Firefox sandbox, clean flush and replacement | [r12 rejected at current UI connection](../../evidence/moss-computer/2026-10-23-persistence-r12.md); sandbox/flush/replacement NOT_RUN | Required before dependent integrated desktop acceptance; record its actual outcome |
| Current owner/session authorization                               | Existing auth-owned binding API, below                                                                                                 | Reuse; enforce at upgrade, transitions and each input dispatch                     |
| UI design                                                         | Chat-integrated layout approved with concise copy and close-to-return                                                                  | Design gate passed; runtime and integration gates remain                           |
| Trusted lifecycle, installed storage and confined Internet egress | No qualified installed candidate                                                                                                       | Hard blocker before integrated launch; implement/review separately                 |
| Actual app/browser HTTPS/WSS path and revocation                  | Not qualified                                                                                                                          | Required before calling the vertical slice delivered                               |
| Installer/platform/MacBook/manual and downloads                   | Later distinct acceptance                                                                                                              | No claim from this foundation                                                      |

## Current seams (this tree, not historical citations)

- `packages/auth/src/session-bindings.ts:47`: auth-owned fresh session row, owner, expiry and active
  account checks. `:69` cookie-only resolution; `:79` fresh liveness assertion. It returns IDs,
  not credentials. Computer must consume this service, never query its tables.
- `apps/api/src/server.ts:625`: capture authorization already composes this auth service into a
  feature. `:357` registers Fastify WebSockets. Reuse those composition/transport seams.
- `packages/ai/src/terminal-routes.ts:174`: existing WS example is admin/ticket-specific and lacks
  ongoing revocation. Do not adopt its authorization policy for Computer.
- `infra/caddy/Caddyfile:31`: HTTPS direct API proxy. `infra/nginx/jarv1s-web.conf:47` lacks explicit
  Upgrade/Connection forwarding; split-web WSS needs a scoped fix and actual verification.
- `apps/web/vite.config.ts:14`: dev WS proxy; HTTP Origin rewriting means it cannot prove the real
  HTTPS/WSS origin policy.
- `packages/settings/src/host-restart-routes.ts:75` and `infra/host/jarv1s-restart.sh:4`: fixed app
  restart sentinel, not a Computer lifecycle controller. Do not extend to arbitrary Docker exec.
- `spikes/moss-computer/compose.yaml:21`: dedicated home/socket mounts on the offline qualification
  candidate, not installed owner storage or useful Internet egress.
- `apps/web/src/app-route-metadata.ts:57`: core route metadata;
  `packages/shared/src/app-map-core.ts:54`: core screen declarations. Future Computer navigation,
  settings, errors and remediation must be added with the actual surface, never advertise policy
  groundwork as a usable desktop.

## Bounded implementation now: input-control boundary

Implement `apps/api/src/computer/input-control.ts` with behavior tests in
`tests/unit/computer-input-control.test.ts`; publicly re-export the existing `BrowserSessionBinding` type from `packages/auth/src/index.ts`. This is an internal API implementation prerequisite,
not a new module, route, viewer, launcher or shipped surface. It deliberately has no transport or
runtime side effect and adds no currently false app-map entry. It must not be described as the
first delivered vertical slice.

Contract: one process-local controller per owner/Computer. `connect(binding)` accepts an
auth-owned browser binding only after a fresh live check and exact owner comparison. Return an
opaque connection handle; each handle starts watching. `takeOver`, `returnToMoss` and owner input
perform fresh liveness checks and fence asynchronous completion against intervening transitions.
Foreign actors, closed handles and expired bindings fail closed. All permission decisions come
from records/validated capabilities, never the model.

The initial/restarted controller is paused. A live owner returning control through Return to Moss
or intentional viewer close enables Moss.
Watching never changes the current controller. Exactly one viewer may control input; another
viewer cannot silently steal it. Unexpected controller disconnect or detected session revocation
leaves input paused, and reconnect starts as a new watcher. A live owner can explicitly take over or
return from paused state. An intentional close by the controlling viewer must call the same
authenticated return action before disconnecting, minting a fresh generation; disconnect alone
cannot grant control. Failed/unauthorized return stays paused. Closing an unrelated watcher does
not interrupt valid control or steal another viewer’s ownership.

Agent work uses opaque, generation-bound leases tied to the fresh browser session that explicitly returned control. Every agent dispatch revalidates that exact session and expiry through the auth-owned liveness port. Closing its viewer alone does not cancel authorized active work; revoking/expiring the session pauses input and invalidates leases. A future independent task authority needs its own reviewed contract; this slice cannot invent one. A takeover, explicit return, controller loss,
session invalidation or shutdown invalidates earlier leases, even after control returns to Moss.
Owner dispatch also captures its generation before async authorization and rechecks afterward.
Input commit invokes a synchronous trusted sender only after the final fence check; the boundary
does not own an asynchronous queue. Tests must hold auth promises to exercise real races.

Transport limitation: this boundary rejects stale work at dispatch; it cannot retract bytes already
accepted by a protocol/socket. The future gateway must own the only RFB input writer, drain/fence
its queue, release pressed keys/buttons on handoff and separate watcher traffic from input. Raw
noVNC WS passthrough would bypass this policy and is prohibited. No remote input-exclusion claim
until that receiving path and observed negative controls pass independent review/live proof.

## Approved chat design

Ben rejected the earlier separate-destination treatment: Computer belongs inside the chat drawer.
The [interactive mockups](../specs/2026-10-23-moss-computer-chat-mockups.html) show full-screen chat
with a recent still thumbnail, the expanded viewer alongside the ongoing conversation, explicit
takeover/return, a compact drawer strip and phone behavior. The preview shows screenshot age rather
than implying a live stream. Opening the viewer does not seize input; intentionally closing it
while controlling returns control to Moss, as does Return to Moss. Working/sleeping/waking/paused/
disconnected/off states and light/dark/Teal are selectable. Screen and conversation data are
illustrative, not desktop proof.

The prototype reuses actual chat markup/styles and canonical Button/Badge/BrandMark markup;
production uses the corresponding `@moss/ui` components, Thread and the shared PeekPanel lifecycle.
No separate Computer module or navigation entry is proposed. The [earlier screens](../specs/2026-10-23-moss-computer-screens.html)
are retained as superseded design history. Ben approved the chat layout in conversation, with
concise product copy and intentional close returning control to Moss. This supersedes the earlier
close-leaves-paused proposal and explicit-return-only wording in older documents. Screenshot age,
status and control labels suffice; omit tutorials about streaming, watching or handoff. Internal
backend policy acceptance and runtime qualification limits are unchanged.

Historical V2 mockup verification (before the approved close behavior revision): fresh
Firefox/Playwright ran 450 layout/state/theme iterations at
1280/768/414/375/320px. State selection returns takeover scenes to watching, so those iterations
include that fallback rather than 450 distinct scene combinations. Direct takeover/return and
close-pauses behavior were exercised separately at 1280px. Other checks covered horizontal fit,
capture-age labels, focus restoration, local-only example messages and no outbound HTTP(S)
requests. Final cropped desktop/drawer/phone views were visually inspected. The self-contained
`Moss-Computer-in-Chat-v2.html` was sent to the requested device by Taildrop on request (exit 0).
These are prototype checks only; no product UI or desktop runtime was tested.

Approved behavior revision: fresh Firefox/Playwright passed 450 layout/state/theme iterations,
asserting the actual scene including unavailable-control fallbacks. At all five widths, watching
retained Moss control; takeover followed by close, Return to Moss or chat collapse restored it.
Focus, concise copy, local-only messages and no outbound HTTP(S) checks passed. Desktop and phone
stage crops were visually inspected. This verifies the prototype, not owner transport or input.

## First integrated vertical slice (after design/runtime prerequisites)

Computer is owned by the existing chat drawer, with a recent still preview in full-screen chat
and a compact entry in the small drawer. Expand its viewer beside the conversation; use an inline
viewer on phones. The normal Moss browser chat experience reaches the same Computer identity/home
after ordinary owner login. A separate `/computer` page is superseded by Ben's chat-first direction;
any later direct-view affordance needs its own agreed design. Use mature noVNC/RFB implementations
and trusted packaged viewer assets. Guest pages and downloaded content never become Moss-origin
viewer assets. No downloads in this slice. Truthful chat feature/settings/error metadata belongs
in the app map with actual product wiring, without introducing a fictitious module or route.

Owner-only API: status/view/upgrade/control/lifecycle use cookie-session binding, trusted exact
Origin and fresh owner checks. Bound active-session revalidation and expiry timers close sockets;
logout/revocation must reach the active writer, not only hide navigation. Recheck on each transition
and input. Do not place session credentials or replayable viewer tickets in URLs/logs. The auth and
gateway owner must review the complete receiving/library path before security claims.

Trusted lifecycle is a separate fixed-operation host interface: enable, disable, sleep, wake and
recreate for one configured owner/storage root and pinned image. No API Docker socket or generic
exec. Dedicated home survives disable/recreate; deletion is a separate explicit operation, excluded
here. Wake uses fresh resource admission and reports unavailable truthfully. No unrestricted bridge
fallback; an independently reviewed HTTP(S)/DNS egress design must exclude host/LAN/metadata/Moss
services before useful Internet access can launch.

Idle design: a connected viewer or active agent operation inhibits sleep. Unexpected controller
loss pauses agent input without ending tracked agent work. Ten idle minutes may request a clean stop only
after all inhibitors are gone and a reviewed flush/unsaved-work contract says stopping is safe.
Unknown background work or inability to flush reports blocked sleep rather than killing it.
Wake/disable/sleep serialize through a lifecycle generation; an older stop cannot kill a newer
wake. Exact unsaved-work detection and fixed stop implementation remain open implementation
questions owned by the lifecycle slice, and block automatic-sleep acceptance. Merely pausing a
container cannot meet resource reclamation. Opening the page wakes a sleeping enabled Computer;
disabled stays disabled until enabled.

Determinism boundary: statuses, controller labels, errors, progress and confirmations render from
the server state. No model-authored user data or chat injection. This foundation makes no model
calls. In later integration the model has two jobs only: choose an authorized Computer task and
propose its next input through the fenced tool boundary; it cannot decide owner permissions or
author lifecycle feedback. No provider/model hardcoding.

## Verification and kill gates

Before product code, commit this plan and independently review the exact candidate. Run scoped
unit tests, TypeScript and ESLint for touched source/tests plus formatting/whitespace (expected0).
Use installed dependencies before any scoped frozen install. No DB command is needed for the
internal boundary; future DB/foundation gates must use `scripts/run-gate.sh` per verify-gate.

Behavior cases: watching preserves control; only current controller sends; foreign/expired/revoked
sessions fail; delayed auth cannot re-enable input after takeover/disconnect/close; concurrent
takeovers cannot both succeed; old agent leases remain invalid after return/reconnect/restart;
disconnect pauses rather than resumes; unrelated watchers do not interrupt; sender errors propagate.
Observe a failing test with a fence removed, restore it and record green. Policy tests establish
only local boundary behavior, not remote transport security.

Required integrated e2e: real owner signup/login → navigation and direct browser `/computer` →
watch actual visible work → takeover blocks agent writer → explicit return requires a fresh lease;
same home/profile after replacement; foreign/unauthenticated/expired/revoked endpoints and active
WS denied; reconnect/multiple viewers, idle inhibition/flush/reclaimed memory/wake and failed
admission. No response stubs or screenshots. Record executable DOM/network/input assertions on
an isolated live dev instance through actual HTTPS/WSS. No merge/Done without that evidence.

Kill gate: if a single protocol input writer cannot enforce queue fencing without inventing a
remote protocol, or trusted lifecycle/egress cannot fit a bounded reviewed candidate, Codex stops
that integration candidate and records the specific blocker. Evaluate this foundation before
detailing later installer/download/platform work. Independent review never authors fixes; preserve
its rulings in the evidence ledger. The full Computer outcome remains open after policy-only work.

# Computer auth IPC prerequisite

Part of #3618 / #3619 / #3616 / #3577. Pinned base
`77c1fe9c23144c9ceb987b714ed9c916c0068135` (merged PR #3624).
Implementer: `computer-gateway-integration`. Continuing authority: independently review,
resolve findings, verify exact candidate/checks, merge, launch and verify a fresh isolated
successor until real owner integration is finished. No production deployment or bypass of
runtime admission, independent review or live-path gates.

## Scope and seams checked before planning

Implement the auth-owned invalidation source and actual bounded Unix-socket fresh-check/push
transport that the separate receiving gateway will consume. This is an internal no-launch
prerequisite, not an installed gateway, product route, viewer or owner acceptance. Combining
session revocation, the guest framebuffer decoder and independent host admission would add three
trust boundaries in one candidate. Evaluate auth IPC first, then continue gateway/admission and
#3619 owner integration. #3618/#3619/#3616/#3577 stay open.

Verified against current source:

- `packages/auth/src/session-bindings.ts:14-31,40-87`: cookie-only resolution returns owner,
  nonsecret session row UUID and absolute expiry; assertLive checks the fresh session/account
  row. It exposes no invalidation subscription. Auth owns all session-table access.
- `packages/auth/src/index.ts:244-247,254-265,275,447-455`: runtime composes Better Auth,
  explicit administrative revocation and session bindings, but no active notification source.
  Better Auth options have user-create hooks only. Add a focused auth-owned source and session
  delete-before/delete-after hooks; do not grow this already large file into a transport module.
- `packages/auth/src/session-service.ts:123-192`: explicit current-user revocation uses raw SQL
  rather than Better Auth hooks. Notify before and in finally after each cookie deletion attempt, after current-session
  refusal; target owner+session for revokeOne, owner except current session for revokeOthers.
  Admin revokeUserSessions notifies the whole user before and in finally after deletion. Conservative invalidation on
  a failed delete is allowed; a failed auth mutation must not preserve a claimed active capability.
- Inspected installed pinned Better Auth `dist/api/routes/sign-out.mjs`: ordinary sign-out calls
  internalAdapter.deleteSession. `dist/db/internal-adapter.mjs:351-378,391-414` routes session
  deletion through deleteWithHooks/deleteManyWithHooks. `dist/db/with-hooks.mjs:116-180` calls
  session.delete.before with the actual row before deleting, and delete.after on completion. Install no secondaryStorage mode.
  Hook notifications project only userId/id; never forward the vendor row/token. Failed vendor
  lookup can skip hooks, so independent polling/deadlines remain mandatory. These vendor facts
  require executable regressions through real Better Auth with an in-memory adapter, not just
  direct invocation of our callback. Verify exact installed bytes in the evidence.
- `apps/api/src/computer/rfb-input.ts:38-55,61-66,95-97,134-155`: receiver consumes assertLive and
  has synchronous session invalidation/epoch advancement plus async receiving close. New transport
  supplies that auth port and a synchronous loss callback. Actual gateway wiring remains absent.
- `apps/api/src/computer/host-http.ts:31-93`: bounded Unix HTTP exists for one-shot host operations,
  but cannot push active revocation. Reusing it alone would leave a polling-only security gap.
- `scripts/computer-host/operations.ts`: launch admission is deliberately unavailable in the runner.
  This slice does not change it, install services or call real Docker.

Choose native Node net Unix sockets with bounded newline JSON frames instead of HTTP polling
alone (cannot push), WebSocket infrastructure (unneeded HTTP/upgrade surface), or a shared DB
subscription platform (unneeded privilege/migration scope). This is fixed private auth IPC,
not a replacement remote-desktop protocol. No dependency/manifest/lockfile change.

## Auth source and exact private transport contract

`packages/auth/src/session-invalidations.ts` exports a small synchronous source and event union:
`{actorUserId, sessionId}` or `{actorUserId, exceptSessionId?: string}`. It supports bounded
subscriptions, unsubscribe and close. Runtime exposes one instance; close invalidates subscribers
before auth pools close. Hook and explicit SQL paths share that instance. A subscriber failure
must not skip other subscribers or prevent logout. Callbacks are local trusted code; the transport
subscriber must fail closed and never throw. Events carry no token/cookie/headers/content. Notify both before and after successful vendor
deletions, and before/finally after raw SQL revocations, so a registration racing an in-progress
delete is retired before completed revocation returns. Vendor lookup failures can skip hooks;
polling remains mandatory and no database-failure logout durability claim is made.

`apps/api/src/computer/auth-channel.ts` owns bounded JSON-line framing, validation and constants;
`auth-server.ts` owns the API-side issued-binding registry/listener;
`auth-client.ts` owns the gateway-side SessionBindingsService assertLive port and lifetime.
No service starts at import or ordinary API boot. A later #3619 composition explicitly installs
these with the actual auth runtime and separately qualified gateway.

Server factory takes configured owner UUID, sessions.assertLive, invalidation source and one
operator-selected absolute Unix socket path in an existing canonical directory owned by the
current effective UID, mode0700, with trusted nonsymlink ancestors. Bind inside one exclusive mode0700 temporary child of that parent. Chmod the internal socket0600
before publishing the configured path via exclusive fs.link. Existing configured endpoints make
publication fail without alteration; Node only owns/unlinks the internal bind pathname. No TCP
fallback or credentials in paths/logs. This private parent is
accessible only to trusted API/gateway identities via the later fixed container UID/mount contract.
Client takes the trusted socket path; filesystem access is the IPC trust boundary, not browser auth.
No guest mount contains this channel. The API remains without Docker/device/guest socket access.
Server close destroys owned connections and closes Node
on its internal path; dev/ino-match the published alias before explicitly unlinking it. Remove
only the owned empty temporary child (rmdir, never recursive cleanup), including on failed
publication/startup. A replacement published endpoint survives closing the original service.
Server close unsubscribes and is idempotent.

API `issue(binding: BrowserSessionBinding): string` accepts only the configured owner, valid
UUIDs, a bounded requestId and finite future absolute expiry. It copies/fixes metadata and returns
a random nonsecret viewer UUID used only by trusted IPC, never browser URLs. At most four issued
bindings, including not-yet-connected bindings; expiry removes them. There is one connection per
issued viewer, no reconnection/reuse after loss. Registry is process-local and lost on API restart;
no stale binding resurrection. Release explicitly retires an issued binding.

Gateway starts each connection with exactly `{type:"bind", requestId, viewerId}`. Server consumes
that viewer once, checks the actual session through auth, and returns
`{type:"live", requestId, binding:{actorUserId,sessionId,requestId,expiresAt}}` only after fresh success.
Expiry is an integer epoch-millisecond upper bound fixed at issue, never extended by later replies.
Then `{type:"check", requestId}` gets a fresh check/reply on that connection and same binding.
Request IDs are UUIDs; server enforces strictly unique IDs per connection using a bounded lifetime
budget (at most 8192 requests, then retire; new API-issued binding required). No duplicate, unsolicited,
unknown-field, foreign or malformed frames. At most four accepted sockets total, including unbound sockets; reject excess before installing
handlers. Server enforces an absolute2s bind deadline, not just a client timer. At most32 actual
outstanding auth promises globally across all sockets/issued lifetimes; release that accounting
only when the underlying promise settles, never merely on timeout/entry retirement. Hung auth
work therefore exhausts a bounded budget and blocks new checks rather than accumulating across
reconnections. Each server check also retires its entry after2s. At most32 pending checks per
client, at most4096 bytes per
frame, at most32 frames per received chunk; bound actual writable backlog to64KiB. Reject/retire
on protocol, overflow, denial, write failure, expiry or transport loss. No automatic retry.

Any applicable auth invalidation synchronously retires the registry/connection epoch before push
`{type:"ended"}` and connection closure. In-flight auth completions check the same issued entry,
connection lifetime and expiry before every live reply. Closing/denying an entry cannot be undone
by delayed completion. Individual session invalidation leaves unrelated sessions alone.

Client `connectComputerAuth(...)` resolves only after fresh binding acknowledgement and supplies
`binding`, `assertLive({actorUserId,sessionId})`, `close()` and synchronous onInvalidate callback.
It validates fixed identity/expiry on each correlated reply. Each wait, including connect/initial
bind, has an absolute2s deadline; late/wrong replies permanently retire the channel. Active checks
start at most2s apart, each has2s deadline. An absolute-expiry timer retires even during idle input.
Missing auth socket/service is unavailable, never an admitted session. Denial, push, expiry,
timeout, malformed reply and disconnect synchronously mark the client ended, reject pending
checks and invoke onInvalidate exactly once; never resume automatically. The gateway caller must
invalidateSession and destroy viewer access synchronously, then await receiver close as necessary.
The callback must be attached before initial handshake; no live input is allowed before it resolves.
Do not claim OS scheduling gives hard real-time deadlines. Event-loop timers enforce the contract
while running; the separately supervised gateway remains a required runtime boundary.

## Runtime/auth/storage/network contract and exclusions

Tests create real Unix sockets under temporary private directories with synthetic identities and
fresh-check stand-ins only. No DB/foundation, browser, guest, TCP listener, devport, image build/load
or Docker mutation occurs here. A vendor in-memory adapter exercises actual signOut, not real
owner login. This establishes the private protocol and notifications only.

Future actual enable/recreate still needs exact qualified gateway image and decoder bounds,
sole upstream RFB access, actual TigerVNC matching Fence proof, exact committed runtime packet,
independent security/spec acceptance, fresh RAM/root>=8GiB/data>=30GiB and healthy Moss,
independent alive watchdog, synchronous receiving invalidation and independent exact closure.
Preserve adopted image, protected dedicated home/socket, canonical root identities, full immutable
resource IDs, generation CAS, pending intents and failed cleanup identities. No always-successful
admission or configuration bypass. Guest remains network-none with UID1000,2CPU/4GiB/512PIDs;
gateway separate UID1000,0.5CPU/128MiB/32PIDs; read-only roots, dropped capabilities, default
profiles, bounded tmpfs/logs and private mounts. No guest home mounted into gateway; only gateway
gets guest socket. Reuse accepted r21 persistence; historical artifacts remain read-only.
Watchdog retains <=1800s monotonic bound, heartbeat<=90s, nominal5s samples, fail-closed floors/
measurement/log/home+socket>=10GiB, first complete healthy sample, lock/stop intent and exact-label
emergency cleanup. Monitoring is not quota. No production restart/data substitution or deployment.

#3619 must resolve ordinary owner cookie and exact trusted Origin before upgrade, package trusted
viewer assets, wire actual receiving gateway and approved chat/browser UI with truthful app-map
and dev/prod configuration. Product completion needs real login->chat/browser->visible frame/input
->takeover->return/intentional-close, hostile/expired/revoked active sessions and stale-input/key
release controls at actual receiving seam, independent exact evidence and closure. Auth IPC tests
are not those predicates. Idle sleep/wake, confined Internet egress and release/platform claims
remain separate. No UI/model calls/model-authored records here; future status renders from records.

## Verification, evaluation and rulings

Scoped frozen offline install inspected existing cache first and changes no manifests. Commands
are unpiped; expected exit0: scoped Vitest on auth IPC, auth notifications, auth secure cookies,
existing computer receiver/host suites; `pnpm exec tsc --noEmit`;
`pnpm exec tsc -p tsconfig.tests.json --noEmit`; scoped ESLint/Prettier; `pnpm check:file-size`;
`git diff --check`. No DB commands without verify-gate/isolated target.

Tests assert actual serialized Unix traffic, initial/per-event fresh checks, no owner/session
substitution, ordinary real-vendor signOut and raw-SQL revoke paths notifying the same source,
registration racing a held DELETE retired at completion, unrelated-session preservation, active idle polling, absolute expiry, denial/timeout/disconnect,
delayed auth/reply resurrection, correlation, frame/connection/pending/backlog limits and closure, including replacement alias survival and failed exclusive publication.
Observe removed identity, epoch, expiry, correlation, push and liveness protections fail at their
intended assertions, restore source, run full scoped green and preserve exact hashes/receipts.

Independent read-only security/spec review of this exact committed plan precedes implementation.
Reviewers author no fixes. Preserve all rulings, including rejected findings. Then code-review
Standards+Spec against pinned base, resolve findings, verify exact candidate/checks, independent
evidence review, required green CI and merge this internal prerequisite only. Kill owner:
`computer-gateway-integration`; stop/split if hooks cannot be observed through vendor logout or
bounded IPC cannot exclude late resurrection. Evaluate phase1 before further detailed gateway work.
Launch/verify a fresh isolated successor carrying the same chain and all remaining gates.

## Plan review ledger

Independent read-only reviewer `/root/auth_security_review` at `4e3579e91` returned BLOCKED.
R1 receipt SHA-256 `1a884ae9075b0fc4e2f83e91bb797afb0dc769e54fcdd5f5625d1cca51ff7788`.
Accepted B1: before-only notifications miss registrations during DELETE; add completion hooks
and SQL finally notifications with a held-deletion race test. Accepted B2: issued-binding bounds
do not cap unbound sockets or abandoned auth promises; add global accepted socket bound, server
bind/check deadlines and actual global auth-work accounting until underlying settlement.
No disputed findings. Amend/review exact plan before implementation.

R2 at `7c41e5f25`: PASS_BOUNDED_AUTH_PLAN, receipt SHA-256
`24266ff39ec2f6278027a3610df64e56e7c6a4a89f42c132c1d34b28c9356944`.
Implementation review at `2270d4577` found Node automatically unlinks a replaced listener pathname
before the post-close inode check. Independently reproduced: different inode, replacement removed.
Accepted correction: exclusive private bind directory plus exclusive hard-linked published alias;
Node closes only internal pathname, explicit inode-checked alias cleanup preserves replacement.
Amendment requires independent contract acceptance before implementation. Standards R1 also
suggested removing redundant per-socket pending accounting (global authWork already bounds it);
accept that simplification. No runtime or owner acceptance follows.

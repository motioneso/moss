# Computer standalone gateway packaging prerequisite

Part of #3618/#3619/#3616/#3577. Pinned base/current main
`0dc882dc3a8282719cd4cb3118fe21e5146e175e` (merged PR #3636, accepted process source
`17f45ed68b0bd9e735f1a0d8d17dbfdb0aedec63`). Implementer: `computer-gateway-runtime`.
The [runtime dispatch](../handoffs/2026-10-24-moss-computer-gateway-runtime.md) authorizes the
continuing independent review → fix → verify exact candidate/checks/evidence → merge → verified
fresh isolated successor chain until actual owner integration passes. No production deployment.

## Bounded outcome and evaluation

Produce a standalone gateway bundle and a minimal digest-pinned Docker build context. Run the
actual bundle outside the checkout against real private Unix/auth/WebSocket/RFB fixtures. This
is internal packaging tooling: **no Docker build/pull/load/create/start, image qualification,
guest, real DB, TCP listener, browser or deployment occurs in this slice**. A recipe and bundle
are not an accepted image. No gateway image hash is configured and host unavailableAdmission
stays unchanged. No product capability/app-map entry or default deployment requirement is added.

Packaging, a new root-trusted independently supervised admission service and actual TigerVNC
qualification are distinct boundaries. Evaluate packaging first; the successor must implement
and independently accept the admission/watchdog and exact live packet before any image/runtime
work. Keep #3618/#3619/#3616/#3577 open. Reuse accepted r21 persistence without requalification.
Original r12 connection/r18 clipboard causes remain unknown.

## Current seams and design choice

- `scripts/computer-gateway.ts:1-47` is the opt-in executable with fixed metadata configuration,
  TERM/INT cleanup and sanitized errors; currently requires tsx plus repository sources.
- `scripts/computer-gateway/config.ts:9-37` uses NOFOLLOW|NONBLOCK before fstat, regular0600
  configuration, canonical0700 parent and bounded reads. Bundle this unchanged.
- `apps/api/src/computer/gateway-server.ts:31-261` reserves private IPC before one upstream,
  consumes the accepted receiving/auth/sole-writer stack, and separates stable control from RFB
  lifetimes. `gateway-client.ts:42-51` is the trusted private API client. No owner route exists.
- `scripts/computer-host/spec.ts:20-79` defines the separate UID1000 gateway with network-none,
  0.5CPU/128MiB/32PIDs, RO root, private mounts and no guest home. The runner
  `scripts/computer-host.ts:26` supplies unavailableAdmission. Do not change either in this slice.
- `scripts/build-app.ts:89-132` already uses locked esbuild for Node24 standalone builds, but
  API/worker bundles deliberately retain external native dependencies and broad workspace assets.
  `Dockerfile:9-44` installs/builds the whole workspace. Neither is a suitable minimal gateway.
- `tests/unit/computer-process-fixture.ts:15-199` provides actual Unix/auth/ws/rfb2 traffic and
  a real child executable; fresh session lookup and missing library Fence support are stand-ins.
  Extend only executable selection to exercise a built bundle with no loader/repository cwd.
- Locked esbuild0.25.12, ws8.21.1 and rfb2 1.1.0 are installed after scoped frozen offline cache
  inspection. ws `lib/buffer-util.js:114-131` and `lib/validation.js:141-157` conditionally load
  optional native accelerators; compile both WS*NO*\* flags to true to retain JS/builtin paths.
  Do not silently externalize optional modules or introduce runtime package installation.

Choose one CommonJS Node24 bundle: builtin requires work directly without ESM compatibility
shims, source trees, tsx or node_modules. Keeping a pruned pnpm runtime preserves vendor layout
but adds package-manager/native optional resolution and a much larger context. The gateway has
only ws/rfb2 runtime packages; esbuild already supports their JS paths. Reject the bundle if
its actual output imports any nonbuiltin external dependency. No generic build framework.

## Files and build contract

- `scripts/computer-gateway/build.ts`: `buildComputerGateway(outputDirectory: string)` returns
  a sanitized build receipt and writes a new exclusive context directory. Resolve source from
  the module location, never the invocation cwd. Bundle only the existing fixed executable using
  locked esbuild, platform=node, target=node24, format=cjs, write=false, metafile=true,
  sourcemaps disabled and optional ws native accelerators compiled out. Validate the actual
  external imports are Node builtins before publishing any output. No network or subprocess.
- `scripts/build-computer-gateway.ts`: opt-in CLI taking exactly one output directory;
  `package.json` adds `build:computer-gateway`. No import into ordinary API/host boot.
- `infra/computer-gateway/Dockerfile` and `.dockerignore`: copied verbatim into the output.
  Fixed linux/amd64 Node24 Debian slim base manifest
  `node:24-bookworm-slim@sha256:2dd9a4f758e173b65fee15388f7706af6fb01ef50cf7a2c0538711d67a6981ae`.
  Registry index digest `sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205`
  independently identifies that platform entry; fetching manifest metadata does not load an image.
  No build ARG/tag override, RUN/install, EXPOSE, VOLUME or health/readiness claim. Root-owned
  read-only gateway.cjs, USER1000:1000, NODE_ENV=production; absolute exec-form Node entrypoint,
  max-old-space-size=64, fixed default `/config/gateway.json`, SIGTERM. V8 heap setting is not
  a whole-process memory guarantee. Runtime limits/mounts remain the host spec's responsibility.
- Context contains exactly gateway.cjs, Dockerfile, .dockerignore and build.json. Dockerignore
  denies everything except the recipe and bundle; receipt is not copied into the image. Exclusive
  directory creation refuses an existing file/directory/symlink; never overwrite earlier artifacts.
  On publication failure remove only files created by this build and its own empty directory.
- Receipt records format/Node target, exact base, bundle hash/size, recipe/dockerignore hashes,
  compiler version and sorted repository-relative input hashes plus package.json/API manifest/
  pnpm lock hashes. No absolute paths, local session IDs, timestamps, owner identity, config,
  cookie, viewer ID or raw source content. Receipt is provenance, never runtime acceptance.
  Same input bytes/toolchain must produce the same output bytes. No image ID is invented.

## Behavior and verification

`tests/unit/computer-gateway-build.test.ts` builds the real artifact into a new private temp
directory and executes it from that directory with NODE_OPTIONS/NODE_PATH absent and no tsx or
node_modules. Reuse the actual fixture with a bundle-path option. Exercise visible pixel data,
watcher exclusion, owner takeover/key-down, pressed release and delayed Fence return preserving
stable control, intentional close, active auth push and exact TERM endpoint/child closure. Stand-in
lookup/Fence fixtures do not prove actual TigerVNC, owner login, image Node24 or 128MiB fit.

Assert receipt hashes match actual source/context bytes; deterministic repeated builds agree;
existing output/symlink remains untouched. Inject a nonbuiltin external through a temporary
esbuild test plugin/interception at the build boundary to prove publication rejects it, without
changing production entry selection. Observe removing the external-import guard fail at the
intended rejection assertion; restoring must pass. Observe removing the compiled optional-module
flags fail the closed-dependency assertion (not a compiler error). Retain every failed attempt.

Run unpiped, expected exit0: new packaging plus existing process/channel/guest-websocket suites;
root `pnpm exec tsc --noEmit`; tests `pnpm exec tsc -p tsconfig.tests.json --noEmit`; scoped ESLint
with max-warnings0, Prettier, `pnpm check:file-size`, `git diff --check`. Run CLI separately and
parse-check its output. No DB/foundation commands required; any later DB work needs verify-gate
and an isolated target. Private logs/short live state stay outside ~/Jarv1s; historical private
artifacts remain read-only. No UI/model calls; later statuses derive from records and the model's
only jobs are choosing an authorized task and proposing its next input.

Independent read-only security/spec acceptance of this exact committed plan precedes code.
After implementation: independent Standards+Spec code-review against the pinned base, security
review, resolve findings, exact final evidence acceptance and required green CI before merge.
Kill owner `computer-gateway-runtime`: split/reject if bundling needs runtime package resolution,
broad API/auth initialization, a generic build system or a weaker receiving/auth path. Then launch
and verify the fresh isolated admission/qualification successor via herdr-handoff; record durable
routing name, actual agent_session.value and handoff-read execution.

## Mandatory successor runtime and owner contract

No actual image/runtime operation until a separately committed exact packet has independent
security/spec acceptance, fresh healthy Moss plus RAM/root>=8GiB/data>=30GiB, and an independent
alive watchdog with first complete healthy sample. Preserve exact label/PID/start/group, <=1800s
monotonic deadline, heartbeat<=90s, nominal5s samples, fail-closed floors/measurement/log/home+
socket>=10GiB, lifecycle lock/stop intent and exact-label emergency closure. Inspect every sample
and stop reason; independently accept resource closure and healthy Moss. Monitoring is not quota.

Use only the adopted guest image and protected dedicated data: guest UID1000/network-none,
2CPU/4GiB/512PIDs; separate gateway UID1000/network-none,0.5CPU/128MiB/32PIDs. RO roots, dropped
caps/no-new-privileges/default profiles, bounded tmpfs/logs, no gateway guest-home mount or API
Docker/device/guest-socket mount. No unrestricted bridge, production restart/data substitution
or deployment. Claim devports5180–5299 for any server; no port is needed here.

Implement fresh independent admission, synchronous receiving invalidation and independent closure
before replacing unavailableAdmission; never always-successful admission/config bypass. Preserve
full immutable IDs, CAS versus creation generation, pending intents, root identities, exclusive
lock and retained failed cleanup identities. Unresolved intent recovery needs an explicit accepted
design. Only known-ID container inspect404 reconciles absence. Disable gateway first, retain home,
never delete volumes. Running is not readiness. Inspect real adopted TigerVNC Fence behavior.

Then actual fixed lifecycle/closure #3618 and ordinary owner HTTPS/WSS/auth plus trusted noVNC and
approved chat #3619: real cookie/exact Origin before upgrade, fixed binding/private viewer IDs,
no credentials/viewer IDs in URLs/guest mounts, active expiry/logout/revocation, watcher isolation,
takeover/return/intentional close, unexpected-loss pause, stale/pressed input and fresh agent
leases. A trusted real API-to-gateway agent path is still absent. Keep stable private control
separate from replaceable raw RFB. App-map and affected dev/prod config accompany product wiring.
Actual login→chat/browser→frame/input→takeover→return/intentional-close and hostile/expired/revoked
active-session/stale-input controls require independent exact live evidence and closure.
Idle sleep/wake, confined Internet egress and platform/release remain separately bounded work.

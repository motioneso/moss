# Workshop confinement probe

This directory is the A0 synthetic probe artifact. It runs inside a freshly created, uniquely named
UAT builder container after the operator confirms the exact isolated operation.

The probe never creates denied fixture paths. The control harness must create them in a disposable
fixture mount and pass absolute paths through the environment. Do not pass production paths or mount
credentials.

Required variables:

```text
WORKSHOP_PROBE_ROOT=/attempt
WORKSHOP_PROBE_DENIED_PATHS=/fixtures/sibling.txt,/fixtures/core.txt,/fixtures/data.txt,/fixtures/secret.txt
```

Run with the image's existing Node runtime and the bounded profile used for the recorded A0
observation:

```sh
docker run --rm --name workshop-a0-capability-0904 \
  --user 1000:1000 --read-only --network none --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 32 --cpus 0.25 \
  --memory 128m --memory-swap 128m \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --tmpfs /attempt:rw,noexec,nosuid,nodev,size=16m,uid=1000,gid=1000,mode=0700 \
  -e WORKSHOP_PROBE_ROOT=/attempt --entrypoint node -i \
  sha256:81f136b568b6297c9f31f1484d11f58c7031041cd853b30ccc2793f833516fa3 \
  --input-type=module < probe.mjs
```

The probe prints JSON lines with `pass`, `fail`, or `unproved`. It reports effective identity,
capabilities, user-namespace and bubblewrap availability, and workspace write/read. Denied fixture
paths must exist before the probe starts; absent paths are `unproved`, never a pass. Network,
provider transport, process-tree cancellation, and resource limits are explicitly reported as
`unproved` until the selected runner supplies their own probes.

Exit 0 means the inventory completed without a demonstrated escape; it does not mean that a
confinement mechanism passed. Inspect the `bubblewrap-boundary` and `unproved` records before making
the A0 decision. In the recorded run, workspace write/read passed and the bubblewrap boundary
returned `No permissions to create new namespace`; root verified the probe container was absent from
`docker ps -a` after cleanup.

The control harness must record image identity, mounts, capabilities, limits, and network attachments
before the run and remove only its unique disposable resources afterward. Never mount the repository,
production volumes, provider auth, database secrets, Docker socket, or a host-wide path.

## Disposable container-boundary experiment

`run-container-proof.py` tests Docker as the attempt boundary, without nested Bubblewrap.
It extracts only Node and its observed amd64 runtime libraries from a stopped cached image,
builds a scratch image, then executes that exact image ID. No application source, credentials,
provider tools, inherited application environment, or shared volumes enter the candidate image.
The library list comes from `ldd /usr/local/bin/node` on the recorded source image; a different
Node build may need a new list and must fail setup rather than count as confinement evidence.

Run from the isolated Workshop worktree:

```sh
python3 tests/uat/workshop-confinement-probe/run-container-proof.py \
  --source-image sha256:d4994b0a2f68343c558960a6d0c00884c6e7ee404273419c5772b59ee09de0ed
```

The controller requires Docker access and a Linux amd64 host with cgroup v2. It uses only
unique container names and a unique temporary image tag, with a read-only synthetic fixture
mount and per-container workspace tmpfs. Each running container is non-root, has no network,
no capabilities, no-new-privileges, 0.25 CPU, 192 MiB memory with no swap, 64 PIDs, and an 8 MiB
workspace. Log retention is one uncompressed 1 MiB file. At most a peer and one tested attempt
run together. Every deliberate runaway has a 90-second in-container backstop if the controller
dies; normal cancellation and control-side deadlines terminate much sooner.

Assertions cover identity and cgroup values, workspace access, an existing unreadable sentinel,
read-only root, absent app/data/auth/socket paths, no external route, separate peer workspace,
original detached descendant PID/start-time disappearance, actual OOM kill, PID-limit rejection,
CPU throttling and a control-side wall deadline, and control-side captured-output cutoff.
The controller checks the peer remains intact, restores/verifies the synthetic sentinel, removes
all its containers and image tag, and verifies absence. Docker's shared build cache is retained.

**Exit 0 means these synthetic assertions passed.** Provider authentication/brokering, the real
build toolchain, dev/prod integration, approval state and rejecting late completion are unproved.
Control-side time/output enforcement is the experiment's controller, not the production runner.
This artifact must not be called a complete A0 pass or used as the Workshop runtime.

## Data-only provider handoff and worker build

Add `--data-only` to the controller command to test the next boundary:

```sh
python3 tests/uat/workshop-confinement-probe/run-container-proof.py \
  --data-only \
  --source-image sha256:d4994b0a2f68343c558960a6d0c00884c6e7ee404273419c5772b59ee09de0ed
```

The controller runs `data-only-provider-proof.ts` outside the container. The existing public
`HttpApiAdapter` calls a local loopback provider fixture for each supported HTTP provider kind,
using a synthetic random credential held only by that fixture/controller process. It checks the
requested model and provider-specific auth/response protocol and validates the exact returned
artifact. Unexpected paths and additional credential fields fail validation.

Only the returned `{files: [{path, content}]}` object enters the container over stdin. The image
adds the cached source image's esbuild 0.25.12 executable and public module SDK source, without app
source, CLI auth homes, a provider socket, or inherited provider environment. Inside the restricted
container, esbuild bundles the returned TypeScript worker with the real SDK; the real worker emits
`worker.ready` and answers `module.invoke` with the expected result. A traversal path and a compiler
import of the existing denied sentinel both fail. The controller verifies cleanup as before.

The data-only variant reruns baseline filesystem/network/profile assertions on its own image.
It does not repeat the earlier resource stress suite. The image digest and evidence therefore
identify this variant separately from the minimal Node experiment. Source handoff is deliberately
limited to one fixed worker entrypoint and 16 KiB; this is a probe contract, not a production writer.

This proves real adapter protocol, source-only handoff, and confined compilation/SDK execution
against a **local provider fixture**, not real model generation or authenticated vendor access.
Actor-scoped route resolution, CLI logins, full web bundles, approval/revision state, and production
integration remain unproved. No provider was restricted as a product decision by this experiment.

## Authenticated Claude source handoff

With the existing Moss Claude connection selected for this proof, run the trusted helper in that
connection's container. It reads the runner's token only into the child environment, never prints
it, and never executes generated code. This is a direct CLI/account feasibility test, not the
production actor-scoped router. Paths below are the observed Moss deployment paths; fail if absent.

```sh
docker exec -i Moss node --input-type=module \
  < tests/uat/workshop-confinement-probe/authenticated-claude-proof.mjs \
  > /tmp/workshop-a0-claude-artifact.json 2> /tmp/workshop-a0-claude-generation.log
# Require generation exit 0 before this separate build step.
python3 tests/uat/workshop-confinement-probe/run-container-proof.py \
  --data-only --artifact-file /tmp/workshop-a0-claude-artifact.json \
  --source-image sha256:d4994b0a2f68343c558960a6d0c00884c6e7ee404273419c5772b59ee09de0ed
```

The helper requests `sonnet` only for this explicitly selected proof and records the resolved model
and installed CLI version. Product provider support/routing is unchanged. It uses a fresh temporary
home, empty settings sources, disabled hooks/auto-memory, no session persistence, empty native tools
and strict empty MCP configuration. The schema transport tool `StructuredOutput` is permitted;
other reported tool availability/use fails. It enforces 120 seconds and 64 KiB combined output,
requests a $0.50 CLI budget, kills its process group and removes its temporary home in `finally`.
Reparented provider descendants and hostile-hook suppression are not proved by this helper.

`--artifact-file` bypasses the synthetic provider fixture and accepts only a regular, non-symlink
file containing one exact source entry within 16 KiB. Only that JSON crosses into the builder.
Do not use Python `-O`: all proof assertions must execute. Require both commands to exit zero,
successful invocation and attack checks, and cleanup evidence; a single handoff pass line is not
sufficient. Authenticated generation is separate evidence from confined build/invocation. Full web
builds, other CLI isolation, actor routing and production lifecycle remain unproved.

## Authenticated source-generation RPC proof (#2277)

This runs current worktree code through `CliStructuredAdapter`, the real authenticated Unix-socket
client/server, `CliChatEngineHost`, and the installed Claude source policy. The fixture uses the
previously selected Claude connection and concrete model. Run from this worktree:

```sh
pnpm exec esbuild tests/uat/workshop-confinement-probe/authenticated-source-rpc-proof.ts \
  --bundle --platform=node --format=esm --target=node24 \
  --external:node-pty --external:pg-native --external:sharp \
  --external:onnxruntime-node --external:@huggingface/transformers \
  --banner:js='import { createRequire as __proofRequire } from "node:module"; const require = __proofRequire(import.meta.url);' \
  --outfile=/tmp/workshop-authenticated-source-rpc.mjs
# Require successful bundling before running the provider call.
docker exec -i Moss env -i PATH=/data/cli-tools/bin:/usr/local/bin:/usr/bin:/bin \
  WORKSHOP_PROOF_MODEL=claude-sonnet-4-6 node --input-type=module \
  < /tmp/workshop-authenticated-source-rpc.mjs \
  > /tmp/workshop-authenticated-source-rpc.log 2>&1
```

Require exit zero and both named pass records. Only sanitized evidence and an artifact digest
leave the trusted process; generated source is checked as data and never executed. Its private
runner home contains a symlink to the existing token file inside Moss; the credential is never
copied to the host. Its socket stays under the real client's allowed directory, without a test
override. The server's startup sweep sees only the private runner home, and no installer/login
service is attached. No shared service restarts or installed configuration changes occur.

The source engine retains its 120-second/64-KiB ceilings; the harness aborts at 135 seconds.
Assertions cover the exact returned file, closed runner session, removed source/adapter homes,
absence of processes retaining the source cwd (including deleted directories), and a live peer.
Cleanup kills owned sessions/peer, closes the socket and removes both private roots.

This proves the real adapter/RPC/runner/engine composition with one existing connection, not the
application's actor-scoped routing, full `createCliRunner` deployment wiring, hostile reparented
children with changed cwd, or Codex/Gemini policy. Installed-version hook and live-abort probes
below provide separate acceptance evidence. No builder or Workshop execution is enabled.

### Installed Claude hook suppression and live cancellation

Bundle `claude-hostile-hooks-proof.ts` with the same esbuild options above, changing the output
to `/tmp/workshop-claude-hostile-hooks.mjs`. Run it through the same minimal `docker exec` environment:

```sh
docker exec -i Moss env -i PATH=/data/cli-tools/bin:/usr/local/bin:/usr/bin:/bin \
  WORKSHOP_PROOF_MODEL=claude-sonnet-4-6 node --input-type=module \
  < /tmp/workshop-claude-hostile-hooks.mjs > /tmp/workshop-claude-hostile-hooks.log 2>&1
```

The fixture writes a synthetic `SessionStart` hook into the policy-created private Claude config.
Its only action is a marker write in the proof root. The control enables user settings and hooks,
requires the marker, then kills its owned process group. The protected run uses the source launch
policy unchanged, requires a validated tool-restricted response and no marker, and removes its
private home. Require exit zero and `hook-enabled-control`, `source-policy-hook-suppression`, and
`claude-hostile-hooks-cleanup` pass records. The control has a 20-second deadline; the protected
run retains the source policy's 120-second/64-KiB limits. This tests user-config hook exclusion;
it does not isolate the effects of disabled settings sources versus `disableAllHooks`, or cover
managed/project/plugin hooks, MCP execution, or other providers.

For cancellation, use the authenticated RPC bundle above with one additional environment variable:

```sh
docker exec -i Moss env -i PATH=/data/cli-tools/bin:/usr/local/bin:/usr/bin:/bin \
  WORKSHOP_PROOF_MODEL=claude-sonnet-4-6 WORKSHOP_PROOF_ABORT=1 node --input-type=module \
  < /tmp/workshop-authenticated-source-rpc.mjs > /tmp/workshop-source-rpc-abort.log 2>&1
```

The harness observes the first real incomplete RPC read after prompt submission, captures live
processes retaining the source cwd, and aborts. Every underlying RPC still uses the real client,
server and installed engine. Assertions require `AbortError`, no artifact, timeout exit telemetry,
removed observed PIDs, a closed session, absent temporary homes and an intact peer. Require exit
zero plus `authenticated-source-rpc-abort` and `authenticated-source-rpc-cleanup` pass records.
This proves cancellation of a live submitted process, not that a remote model request had begun,
the engine's wall deadline, or containment of hostile descendants that change cwd.

For the actual engine wall deadline, replace `WORKSHOP_PROOF_ABORT=1` with
`WORKSHOP_PROOF_DEADLINE=1`. The harness deliberately withholds prompt submission so the installed
CLI waits on stdin without making a model request. The adapter's outer timeout is 130 seconds;
the harness backstop is 135 seconds. Require the real engine's `Source generation timed out`
error after 120–130 seconds, no external abort or artifact, removed observed PIDs/homes, intact
peer, and both `installed-source-rpc-deadline` and cleanup pass records. This exercises the engine
timer at real wall time; the deliberately withheld input is not proof of timeout during a remote
model response.

Add `WORKSHOP_PROOF_FULL_RUNNER=1` to use the actual `createCliRunner` composition root, including
its real install/login services and persistent-pool wiring. Its installer inventory starts empty
in a private tools directory, so startup sweep/reconciliation cannot touch the shared installation.
After startup the harness links only the existing Claude executable into that directory. No install
or login operation is invoked. Require `fullRunnerComposition: true` in the generation/cancellation
pass record. This closes the hand-assembled-server gap, but deliberately does not test installed
release reconciliation, dev/prod deployment startup or actor-scoped credentials.

### Codex native-tool negative control — passed; candidate rejected

`codex-source-request-proof.mjs` runs installed **codex-cli 0.144.5** against a loopback Responses
fixture with empty synthetic HOME/CODEX_HOME and neutral cwd. It supplies no real credential and
makes no vendor model call. Run it without bundling:

```sh
docker exec -i Moss env -i PATH=/data/cli-tools/bin:/usr/local/bin:/usr/bin:/bin \
  node --input-type=module < tests/uat/workshop-confinement-probe/codex-source-request-proof.mjs \
  > /tmp/workshop-codex-source-request.log 2>&1
```

The candidate disables shell/apply-patch, apps, hooks, plugins, multi-agent, code mode, web search
and `tools.view_image`, with read-only sandbox and ephemeral state. It still advertises
`update_plan`, `request_user_input` and `view_image`. The fixture responds with a `view_image` call
against a synthetic one-pixel PNG outside the neutral cwd. The actual tool routes to the filesystem
helper; this container blocks its namespace creation. The next local request must contain that
specific tool-error result and no attached image. A final structured response completes the CLI.
Require exit zero, `codex-source-policy-negative-control` with `candidateRejected: true` and
`imageAttached: false`, and the cleanup pass record. A changed environment that permits the image
read must fail this exact assertion rather than silently changing the claimed evidence.

R3 passed with two local requests, log `/tmp/workshop-codex-source-request-r3.log`. This proves
native-tool exposure and an attempted read despite the candidate flags, **not** a successful
file read or a safe source policy. The model name is synthetic and Codex uses fallback metadata;
real configured-model behavior remains unproved. No sandbox was relaxed, no real credential was
supplied, and the current production source RPC still rejects this provider.

R1/R2 stopped after one request. The approved diagnostic identified missing `usage.total_tokens`
in the synthetic SSE completion response; that field was added before R3. Static inspection also
repaired a PNG chunk CRC and added a checksum assertion. Both failed runs and the diagnostic
removed their private root/server/CLI. The temporary raw diagnostic output was removed from the
final harness. No approval remains pending.

The current official [configuration reference](https://developers.openai.com/codex/config-reference)
documents `tools.view_image` as a boolean; the installed version's observed request takes precedence
for this fixture. The [hooks guide](https://developers.openai.com/codex/hooks) distinguishes
user/project/plugin hooks from managed hooks. Codex hook execution, authenticated generation,
actual runner composition and an effective source policy remain unproved.

## Generated web and offline browser proof

Set `WORKSHOP_PROOF_WEB=1` only on the trusted generation helper to request the three exact files
`src/worker/index.ts`, `src/web/index.ts`, `src/web/styles.css` (same 16 KiB aggregate ceiling):

```sh
docker exec -i -e WORKSHOP_PROOF_WEB=1 Moss node --input-type=module \
  < tests/uat/workshop-confinement-probe/authenticated-claude-proof.mjs \
  > /tmp/workshop-a0-claude-web-artifact.json 2> /tmp/workshop-a0-claude-web-generation.log
# Require generation exit 0 before the separate confined build/render step.
python3 tests/uat/workshop-confinement-probe/run-container-proof.py \
  --data-only --web --browser --artifact-file /tmp/workshop-a0-claude-web-artifact.json \
  --source-image sha256:d4994b0a2f68343c558960a6d0c00884c6e7ee404273419c5772b59ee09de0ed
```

Omit `--browser` for compile/default-export checks only. The web recipe matches
`scripts/build-external-module.ts`: browser ESM, React host shims, classic JSX and CSS text loader.
The image adds public SDK/UI/lucide sources only; the browser variant adds cached Chromium and
observed runtime libraries, fonts, Playwright, React/ReactDOM and scheduler. No package install or
network access is needed. Neither variant executes generated code on the host or in Moss.

The browser variant has 512 MiB/no swap, 128 PIDs, 0.5 CPU, 64 MiB attempt tmpfs and the same
non-root/read-only/no-network/cap-drop/no-new-privileges controls. Chromium's internal sandbox is
disabled; Docker is this experiment's boundary. It mounts the generated component using real
React in a tiny offline host fixture, checks a render and click, and exports a bounded PNG of
only the component region to a unique `/tmp/workshop-a0-*-web-proof.png` file. Expect no unexpected
requests/page errors, all denial checks, and final container/image removal. Require exit zero.

This proves offline browser execution and public web bundling. The actual Moss host loader,
CSS confinement, app routes, button-to-worker API flow, approval/revision/cancellation and
production orchestration remain separate work. The proof page is not the Workshop redesign.

## Host-control lifecycle feasibility

```sh
python3 tests/uat/workshop-confinement-probe/run-container-proof.py \
  --control-plane \
  --source-image sha256:d4994b0a2f68343c558960a6d0c00884c6e7ee404273419c5772b59ee09de0ed
```

This separate mode reuses the minimal Node image/profile without repeating the browser/provider
or resource-stress runs. It requires host UID 1000, Docker access and a reachable user-systemd
manager. It creates only uniquely named transient user units, a temporary synthetic socket/control
fixture and disposable containers; it installs no service and restarts no shared app.

`control-plane-proof.py` owns fixed host-side run/owner/lease fixtures and image/command/profile
choices. A trusted-client container can submit only authenticated start/stop envelopes through
its private socket mount. Attempt containers receive neither that mount nor the Docker/systemd
control sockets. Assertions cover malformed/unauthorized/cross-owner/stale requests, duplicate
and consumed starts, exact detached-process cancellation, and a second run surviving the first.

The launcher is killed with SIGKILL. Independently, systemd's `RuntimeMaxSec` plus exact-name
`ExecStopPost` removes the timed-out container. The test observes `ActiveState=failed` and
`Result=timeout` before checking absence; it does not issue a stop to supply that cleanup. A new
launcher retains the exclusive host-private claim markers, rejects replay, and stops the peer.
Finally it stops/resets only its own transient units, verifies their absence and lets the outer
harness remove/verify its owned containers and image tag.

This is synthetic lifecycle evidence, not a runtime implementation. The serial fixture does not
accept source/artifact transfer, load real users/leases, prove host-power-loss durability or run
Moss's actual dev/prod composition. Claim files are local proof state, not a new application store.

## Codex ambient-configuration negative controls

```sh
docker exec -i Moss node --input-type=module \
  < tests/uat/workshop-confinement-probe/codex-config-proof.mjs
```

This helper reads only the installed public executable path and runs `--version` and
`mcp list --json` in temporary synthetic homes/directories. It passes no credential files or
inherited auth environment and makes no model call or MCP-server invocation. Each command has a
15-second deadline, 64 KiB combined-output cap and process-group cleanup; raw stderr is discarded.
Temporary files are removed in `finally`.

The installed 0.144.5 result is deliberately asserted: native-tool disabling flags and even
`mcp_servers={}` retain the synthetic user/trusted-project registrations. A separate `CODEX_HOME`
retains a trusted project's configuration; a separate home plus an empty neutral directory lists
no servers. This is configuration-discovery evidence only. Native tools, hooks, managed/system
settings, authentication and production runner composition require separate proof. If an installed
version changes the negative-control behavior, investigate and update the evidence rather than
loosening the assertion. A cleanup pass is independent of the proof body; require process exit 0
and the named configuration-discovery pass to claim this check succeeded.

## Codex app-server environment policy — candidate remains rejected

`codex-app-server-source-proof.mjs` compares the pinned **codex-cli 0.144.5** app-server protocol
with default environments, `environments: []`, and both empty environments and
`selectedCapabilityRoots: []`. Each starts a fresh ephemeral thread against a local Responses
fixture, asserts the concrete synthetic model and structured result, bounds process output/time,
and cleans its own process group, HTTP server and temporary state. No actual credential or model
call is used. This is tool-inventory evidence; it does not invoke the remaining native tools.

Run from the Workshop worktree with `CODEX_PUBLIC_BINARY` pointing to a disposable copy of the
installed public executable, not a CLI HOME or app-data directory:

```sh
docker run --rm --name workshop-codex-app-server-proof --user 1000:1000 \
  --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 512m --pids-limit 128 --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --mount type=bind,src="$CODEX_PUBLIC_BINARY",dst=/probe/codex,readonly \
  --mount type=bind,src="$PWD/tests/uat/workshop-confinement-probe/codex-app-server-source-proof.mjs",dst=/proof.mjs,readonly \
  --entrypoint node \
  node@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e \
  /proof.mjs
```

The tested executable SHA256 is
`058d616bde049c0648b72d53a22a54bf428eeb3f10e76cb4d6d4d4f81b764600`; its version matches the
committed openai-compatible shrinkwrap. Only that public binary and this script enter the
network-none container. The installed `app-server generate-json-schema --experimental` schema
describes empty environments as disabling environment access; the actual request shows the limit:

- Default environments advertise `update_plan`, `request_user_input`, and `view_image` despite
  `tools.view_image=false` and the prior native-tool disabling flags.
- Empty environments remove `view_image` but add `skills.list` and `skills.read` for
  orchestrator-owned resources. Empty selected capability roots do not remove those tools.
- All three variants complete the synthetic structured request. None establishes the required
  schema-only source policy, hostile ambient-state isolation, native tool denial or authentication.
  A changed inventory fails the assertions and requires investigation, not automatic acceptance.

Official [configuration reference](https://developers.openai.com/codex/config-reference) still
documents `tools.view_image` as an enablement control. The installed behavior above takes
precedence for this pinned candidate. The public [app-server guide](https://developers.openai.com/codex/app-server)
and installed generated schema provided the protocol; a current changelog reference to temporary
structured threads did not establish an available tool-free method in the pinned schema.
Keep Codex Workshop source unavailable. Do not replace the existing engine with a new app-server
integration based on this inventory-only fixture.

## Gemini 0.57.0 source-policy request proof

`gemini-source-request-proof.mjs` runs the pinned public CLI against a synthetic loopback API.
It uses no vendor account or real credential. All four cases assert the concrete model request,
force a native `read_file` call, and check synthetic startup hook/MCP markers:

| Configuration                                     | Native tools/read | Startup hook | MCP command |
| ------------------------------------------------- | ----------------- | ------------ | ----------- |
| Hostile HOME, unrestricted                        | Exposed/allowed   | Runs         | Runs        |
| Hostile HOME, project `tools.core: []`            | Exposed/allowed   | Runs         | Runs        |
| Hostile HOME, system tools/hooks/admin override   | Absent/denied     | Blocked      | Runs        |
| Fresh HOME/cwd, explicit system settings/defaults | Absent/denied     | Blocked      | Blocked     |

A PASS for a negative control means its **unsafe behavior was reproduced**. Installed settings
merge code resets `admin` from remote-admin defaults; local `admin.mcp.enabled: false` does not
supply the intended restriction. Project-only tool configuration was ineffective in this exact
invocation (`--skip-trust`); this does not establish behavior under every trust configuration.
Fresh HOME is therefore necessary in this candidate, alongside the explicit system tool/hook
policy. No ordinary chat behavior was changed. Its project-only zero-tool safety claim must not
be reused as Workshop evidence.

Prepare a private dependency fixture from this worktree, with separate empty npm config files:

```sh
proof_root=$(mktemp -d /tmp/workshop-gemini-policy-XXXXXXXX)
cp packages/cli-runner/recipes/google/npm-shrinkwrap.json "$proof_root/npm-shrinkwrap.json"
node --input-type=module - "$proof_root" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const root = process.argv[2];
const lock = JSON.parse(readFileSync(`${root}/npm-shrinkwrap.json`, 'utf8'));
writeFileSync(`${root}/package.json`, JSON.stringify({name: lock.name, private: true, ...lock.packages['']}));
writeFileSync(`${root}/user.npmrc`, '');
writeFileSync(`${root}/global.npmrc`, '');
JS
(cd "$proof_root" && env -i PATH="$PATH" HOME="$proof_root" \
  npm_config_cache="$proof_root/cache" npm_config_userconfig="$proof_root/user.npmrc" \
  npm_config_globalconfig="$proof_root/global.npmrc" \
  npm ci --ignore-scripts --no-audit --no-fund)
docker run --rm --name "workshop-gemini-policy-$$" \
  --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user 1000:1000 --pids-limit 128 --memory 1g --memory-swap 1g --cpus 1 \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777 \
  --mount "type=bind,src=$proof_root/node_modules,dst=/probe/node_modules,readonly" \
  --mount "type=bind,src=$PWD/tests/uat/workshop-confinement-probe/gemini-source-request-proof.mjs,dst=/probe/proof.mjs,readonly" \
  --mount "type=bind,src=$PWD/tests/uat/workshop-confinement-probe/gemini-source-engine-fixture.mjs,dst=/probe/gemini-source-engine-fixture.mjs,readonly" \
  --mount "type=bind,src=$PWD/tests/uat/workshop-confinement-probe/gemini-oauth-fixture.mjs,dst=/probe/gemini-oauth-fixture.mjs,readonly" \
  --workdir /tmp --entrypoint node \
  mcr.microsoft.com/playwright:v1.60.0-noble@sha256:9bd26ad900bb5e0f4dee75839e957a89ae89c2b7ab1e76050e559790e946b948 \
  /probe/proof.mjs /probe/node_modules/@google/gemini-cli/bundle/gemini.js
```

Remove only the exact dependency directory you created after the container exits. The proof
cleans its synthetic files/server/process group; Docker removes the disposable container.
Public package installation requires network, while the proof container has no external network.
The default four-case matrix asserts CLI 0.57.0 and model `gemini-3.5-flash`.
Append `--model-matrix` or `--oauth-matrix` after the bundle path to run the additional matrices.
The OAuth matrix also requires the pinned image's `openssl` executable.

### Model selection and native OAuth continuation

The six-case model matrix proves the original 2.5 Flash discrepancy is an explicit remapping,
not an unidentified helper request. In the active installed bundle, `hasGemini35FlashGAAccess`
enables 3.5 for API-key authentication and `resolveModel` remaps the older Flash selector.
The CLI's `init.model` still says `gemini-2.5-flash` while its actual requests use 3.5.
**Checking only the startup model is insufficient.**

A per-call system setting preserved the tested 2.5 Flash, 2.5 Pro and 3 Pro Preview selectors:
`experimental.dynamicModelConfiguration: true` with
`modelConfigs.modelIdResolutions[model]: {default: model, contexts: []}`. Synthetic 403 and 404
responses failed without switching models. These cases also retain native-tool denial and
ambient hook/MCP controls. This is installed-version evidence for the tested cases, not a claim
that every future model, CLI version or provider response preserves identity.

The six-case OAuth matrix uses the unmodified CLI's `oauth-personal` path and synthetic
`.gemini/oauth_creds.json` / account-cache files in its selected HOME. `gemini-oauth-fixture.mjs`
creates an ephemeral certificate and a loopback-only CONNECT proxy. Only token-info/user-info
hosts can reach its own TLS server; other CONNECT destinations fail the proof. The test process
alone trusts that certificate through `NODE_EXTRA_CA_CERTS`. `CODE_ASSIST_ENDPOINT` points to the
local synthetic Code Assist service. No host trust configuration, real OAuth consent, vendor
account, production credential or external network is used.

Native OAuth cases prove both selected model requests, an actual refresh-token exchange and
updated private credential file, and failure before source generation when the selected HOME has
no credential despite a valid credential in another synthetic HOME. Each case checks its own
native token-info requests. Provider tokens must not appear in CLI output or reach the MCP fixture.

The stronger OAuth transport revealed two additional limits:

- The minimal fresh HOME attempted `play.googleapis.com` telemetry. The candidate now explicitly
  sets `privacy.usageStatisticsEnabled: false`, `telemetry.enabled: false`,
  `general.enableAutoUpdate: false`, `general.enableAutoUpdateNotification: false`, and
  `advanced.autoConfigureMemory: false` in system settings. The later OAuth runs have no
  unexpected CONNECT destination. This does not claim interception of every possible network API;
  the enclosing container still supplies the actual external-network denial.
- Remote administrative settings can inject a required **HTTP** MCP server. The CLI contacts it
  for initialization/discovery, but the empty core-tool policy still removes its advertisement
  and denies a forced invocation. Remote stdio injection is not supported by the installed schema.
  A fixed empty `GEMINI_EXP` file prevents remote discovery, but also suppresses remote
  administrative controls. That is an experimental comparison, **not a selected production
  policy**. Do not adopt it as an unnoticed bypass of account restrictions. Remote discovery and
  invocation are separate findings; neither should be reported as local command execution.

### Remote MCP discovery continuation — bounded deny-all candidate passed

The OAuth matrix now has nine cases. The additional three retain remote-admin fetching and
compare an empty allowlist with this per-call system setting:

```json
{
  "mcp": {
    "allowed": ["workshop-source-disabled"],
    "excluded": ["workshop-source-disabled"]
  }
}
```

An empty `mcp.allowed: []` **does not block discovery** in 0.57.0. The CLI settings helper treats
the empty list as deny-all, but the core connection manager applies its allowlist only when
`allowedNames.length > 0`. The initial assertion failed on remote initialization:
`/tmp/workshop-gemini-discovery-proof-01.log`. It remains an explicit negative control.

The nonempty allowlist/exclusion combination blocks every server: all other names fail the
allowlist; its single allowed name fails the exclusion list. The installed proof tests both an
unrelated admin-required server and one named exactly `workshop-source-disabled`. Both keep the
actual `fetchAdminControls` request, make no MCP initialization/discovery contact, advertise no
tools, reject a forced MCP invocation and complete source generation with the selected model.
No fixed experiment file is supplied. This avoids the earlier approach of suppressing remote
administrative-control discovery; it does not claim that every possible account restriction has
been exercised. It is still an offline candidate, not deployed acceptance.

Final nine-case OAuth matrix: `/tmp/workshop-gemini-discovery-proof-02.log`, exit 0 with cleanup.
Existing native token validation, refresh, missing-selected-HOME denial and prior remote-MCP
controls pass in the same run. No Gemini production launch or login behavior changed.

### Implemented source-launch policy factory

`packages/chat/src/live/gemini-source-policy.ts` now creates the proved private launch settings
from one bounded atomic `{ account, oauth }` credential record. The trusted runner must derive
that record's path from fresh actor/config-bound login; the factory itself does not establish
provenance. It refuses missing/non-concrete models, invalid credentials, directories and symlinks.
It writes only private native OAuth/account/settings files in its own temporary HOME, sends the
task/schema over stdin and supplies no ambient auth, proxy or experiment environment. Its result
validator requires one matching init and successful completion, a JSON object, no tool/error
events, no credential echo and bounded output. The caller still owns subprocess lifecycle limits
and must call `dispose()`; this factory does not spawn a process.

The `--source-launch` matrix uses the actual bundled factory with the installed CLI and the
existing local OAuth/provider fixture. To reproduce, prepare the public dependency directory
above, then bundle this worktree's implementation into it:

```sh
pnpm exec esbuild packages/chat/src/live/gemini-source-policy.ts --bundle --platform=node \
  --format=esm --outfile="$proof_root/gemini-source-policy.mjs"
```

Use the Docker command above with one additional read-only mount:
`--mount "type=bind,src=$proof_root/gemini-source-policy.mjs,dst=/probe/source-policy.mjs,readonly"`.
After the Gemini bundle path, append `--source-launch /probe/source-policy.mjs`.

Three installed cases pass in `/tmp/workshop-gemini-source-launch-01.log`: ordinary source and
native OAuth refresh return exact selected-model source; a forced, denied MCP call makes the
factory reject the otherwise successful CLI output. All fetch admin controls without remote MCP
contact. The fixture adds only synthetic endpoint/proxy/CA overrides after the factory builds its
production environment; this is policy-factory/CLI evidence, not actual runner dispatch or vendor
login. Unit coverage is in `tests/unit/gemini-source-policy.test.ts`.

The factory returns the original record's SHA256 version and exposes refreshed native credentials
only after accepting a source result and confirming the account has not changed. The runner's
`gemini-credential-store.ts` publishes private scoped records atomically and checks that version
before refresh publication. Its synchronous current-flow/version/rename section assumes one
runner process is the sole writer; it is not a multi-process compare-and-swap or durable attempt
authority. Cancelled flows and refreshes from older logins cannot replace the current record.

Five focused filesystem/policy tests pass in `/tmp/workshop-gemini-refresh-unit.log`. The three
installed cases also pass with refresh-read assertions in
`/tmp/workshop-gemini-source-refresh-proof.log`: refreshed native state is returned, the canonical
record stays unchanged until explicit publication, and rejected results cannot release refresh
state. Root TypeScript and scoped ESLint pass.

Fresh actor/config-bound Gemini login is now connected in `LoginService`: isolated HOME/tmux,
explicit environment and shared tool/MCP restrictions, native OAuth/account files, then a bounded
authenticated user-info check against the same account. This validates auth without choosing a
feature model. The final publication writes ordinary native compatibility files before the scoped
record; failed renames roll back earlier files and preserve backup data on restore failure. This
is process-local rollback, not a crash-atomic transaction across files. Existing unbound login
behavior remains unchanged.

`fresh-login-proof.ts` also covers this actual tmux/process path with a synthetic Gemini executable
and local authenticated account endpoint. `/tmp/workshop-fresh-gemini-process-proof.log`, rc0,
proves native-file capture, fresh validation, scoped/ordinary publication, foreign scope absence,
and cleanup. It is not a real vendor/browser login. The shared login/source regression passes
76 tests in `/tmp/workshop-fresh-gemini-regression.log`.

Source result validation is now asynchronous: await `readResult()` after the child has stopped.
It checks both original and rotated native tokens before returning source, and retains that
accepted credential snapshot for refresh publication. Five focused tests pass in
`/tmp/workshop-gemini-rotated-secret-unit-final.log`; the three installed cases pass in
`/tmp/workshop-gemini-fresh-policy-proof.log`.

The shared `CliSourceEngine` now owns direct spawn, combined stdout/stderr limits, deadline,
process-group cleanup (including descendants on successful parent exit), single submission,
no partial output, cached result validation and private disposal. Both policies use it; the
runner's internal `createScopedSourceEngine` derives the credential path and wires Gemini's
version-fenced refresh callback. Cancellation also fences pending refresh publication and waits
for its cleanup. Claude's existing source route uses this engine; ordinary chat retains its
existing engines. Gemini RPC still rejects before creating a source engine.

Fourteen source/RPC/lifecycle tests pass in `/tmp/workshop-shared-source-engine-final-tests.log`.
Eight routing tests, including Gemini rejection and timed-out late-launch cleanup, pass in
`/tmp/workshop-source-engine-routing-final.log`. TypeScript, scoped lint and formatting pass.
Pinned installed **engine** composition also passes four cases after the final-output credential
fix: selected 2.5 Flash, selected 2.5 Pro with native refresh, forced-tool rejection without
publication, and cancellation after refreshed authentication reaches the source endpoint without
publication. Each uses the actual runner factory and shared engine; a temporary spawn interception
substitutes the pinned executable and loopback endpoints. The engine controls stdin, output,
validation, publication and cleanup. This does not exercise the gated Gemini RPC path.
Evidence: `/tmp/workshop-gemini-installed-engine-secret.log`, rc0.

To reproduce engine mode, bundle an entry exporting `createScopedSourceEngine` from
`packages/cli-runner/src/source-engine.ts` and `scopedGeminiCredentialPath` from
`packages/cli-runner/src/gemini-credential-store.ts` using esbuild's Node/ESM options and banner
`import { createRequire } from "node:module"; const require = createRequire(import.meta.url);`.
Mount that bundle read-only at `/probe/source-engine.mjs` in the container above and append
`--source-engine /probe/source-engine.mjs` to its command. The banner accommodates CommonJS
dependencies in the public chat barrel; it changes no production dependencies.

Final decoded JSON is checked against original and rotated access, refresh and ID tokens before
credential acceptance. Eleven policy/store/engine tests pass in
`/tmp/workshop-gemini-secret-regression.log`, including split assistant deltas and Unicode escapes.
Independent Standards review confirmed the fix; Spec review found no concrete defects while
recording incomplete acceptance. The nine OAuth controls pass after the harness changes in
`/tmp/workshop-gemini-oauth-regression-0905.log`, rc0, including the deliberately unsafe remote-MCP
controls and both deny-all cases. Both disposable containers and private proof state were removed.

Gemini Workshop source remains unavailable. Run subprocess tests with authorized subprocess permissions:
a minimal child echo proved the restricted sandbox can silently drop child stdin.

Evidence: final original/model matrices `/tmp/workshop-gemini-regression-final.log` (10 cases);
final native OAuth matrix `/tmp/workshop-gemini-oauth-proof-08.log` (6 cases). Earlier evidence:
`/tmp/workshop-gemini-model-proof-03.log` (6 model cases),
`/tmp/workshop-gemini-oauth-proof-02.log` (telemetry destination rejected), and
`/tmp/workshop-gemini-oauth-proof-07.log` (remote MCP discovery observed with no advertised tool).
The original version-checked policy evidence remains `/tmp/workshop-gemini-source-request-08.log`;
`/tmp/workshop-gemini-source-request-06.log` records ambient local MCP execution under system-only
settings. PASS on an unsafe control means that unsafe behavior was reproduced.

Fresh actor/config-bound Gemini login publication and shared engine composition are now implemented
locally, with the synthetic and installed evidence above. Real vendor/browser login, deployed
actor-scoped Gemini RPC and deployed confinement remain unverified. The Settings app map reflects
fresh Claude/Gemini sign-in; ordinary chat retains its existing launch path. No Workshop execution
or Gemini source-dispatch gate was enabled.

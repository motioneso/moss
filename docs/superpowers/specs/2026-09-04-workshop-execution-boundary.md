# Workshop execution boundary (Phase A0 / P0)

Date: 2026-09-04  
Status: **local container primitives and authenticated Claude worker/web generation, build and offline browser proved; deployment/lifecycle integration unproved; no-go for builder implementation**. This is a deployment feasibility record,
not a selected production sandbox or an authorization to change Compose.

The source inventory below was followed by the initial bounded synthetic capability check against cached image
`sha256:81f136b568b6297c9f31f1484d11f58c7031041cd853b30ccc2793f833516fa3`. That initial check authenticated no provider and read no live credential; it changed no production infrastructure. The
repeatable probe in
[`tests/uat/workshop-confinement-probe/`](../../../tests/uat/workshop-confinement-probe/) is ready
for repeatable isolated runs. A later container-boundary experiment is recorded below.

## Evidence from the current deployment

| Boundary                     | Observed behavior                                                                                                                                                                                                                                                                                                    | Evidence and limit                                                                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Production image             | `ghcr.io/motioneso/moss:${JARVIS_IMAGE_TAG}`; the Compose reference is a tag, not a digest. The Dockerfile bases are also unpinned `node:24-bookworm-slim` and `caddy:2.10.0-alpine` where applicable.                                                                                                               | `infra/docker-compose.prod.yml:47-51,145-153`; `Dockerfile:11,39,52`. The exact runtime bytes cannot be asserted from source alone.                                                                                                                    |
| Production identity          | Dockerfile has no `USER`. The container supervisor starts as root, prepares/chowns directories, then starts API, worker, and CLI runner with configurable `JARVIS_HOST_UID/GID` (defaults 1000/1000).                                                                                                                | `Dockerfile:52-107`; `scripts/start-jarv1s.ts:21-24,130-148,176-191`. Root remains the supervisor and one-shot migration/reconcile owner; child identity is configurable rather than fixed.                                                            |
| Production process ownership | One `jarv1s` service owns `cli-runner`, `worker`, and `api`; shutdown sends a signal to direct children and waits up to 10 seconds. The module build additionally uses a tmux session and `mux.kill(handle)`.                                                                                                        | `infra/docker-compose.prod.yml:145-219`; `scripts/start-jarv1s.ts:176-211`; `apps/worker/src/module-build-live-agent.ts:66-139`. Exact descendant-tree teardown is unproved.                                                                           |
| Production mounts            | The service mounts vault data, model cache, CLI tools, CLI auth, CLI socket, sports socket, and all installed modules. Optional notes configuration can add an external host path.                                                                                                                                   | `infra/docker-compose.prod.yml:201-216`; `infra/docker-compose.notes.yml`. There is no builder-only mount set.                                                                                                                                         |
| Production privilege profile | `jarv1s` has no `read_only`, `cap_drop`, `security_opt`, `user`, `network_mode`, `cpus`, `mem_limit`, or `pids_limit` declaration. Those controls appear on the sports sidecar and smoke services only.                                                                                                              | `infra/docker-compose.prod.yml:221-297` shows the restricted sidecars; `:145-219` shows the unrestricted app service. Kernel/user-namespace availability is not inferable from Compose.                                                                |
| Production network           | `jarv1s` is on the `jarv1s` bridge (`10.251.0.0/24`) and exposes the web port. No egress deny policy or provider-only network is declared.                                                                                                                                                                           | `infra/docker-compose.prod.yml:199-220,419-423`. The provider and build process therefore share the app network unless a later runtime boundary changes it.                                                                                            |
| Development deployment       | `worker` uses `node:24-bookworm-slim`, mounts the whole checkout at `/workspace`, installs packages at startup, has no `user`, resource, capability, read-only, or network restriction, and shares the normal bridge.                                                                                                | `infra/docker-compose.yml:1-24,158-190`. Dev is useful for wiring checks but cannot stand in for production confinement evidence.                                                                                                                      |
| Build workspace              | Default build root is `${modulesDir}/../module-builds`, normally `/data/module-builds`; the post-write build command runs with cwd `WORKSPACE_ROOT` (`/app`) and receives the build path as an argument.                                                                                                             | `packages/module-registry/src/external/resolve-build-dir.ts:5-17`; `apps/worker/src/worker.ts:237-294`; `apps/worker/src/module-build-live-agent.ts:111-124`. A prompt restriction does not constrain that host process.                               |
| Child environment            | `createSanitizedTmuxIo` uses an allowlisted environment for tmux/provider/build subprocesses and drops database/app secrets.                                                                                                                                                                                         | `apps/worker/src/worker.ts:140-148`; `packages/cli-runner/src/runner-io.ts:22-83`; `packages/cli-runner/src/sanitized-env.ts:1-96`. This is credential-env minimization, not an OS boundary.                                                           |
| Provider credential path     | The worker resolves `JARVIS_CLI_HOME_BASE`/`JARVIS_CLI_HOME` and uses that shared home for provider first-run state. Anthropic reads a `0600` token under `.jarvis/cli-tokens/anthropic`; Codex and Gemini use provider files in that home.                                                                          | `apps/worker/src/worker.ts:130-148`; `packages/cli-runner/src/provider-token-store.ts:16-80`; `packages/cli-runner/src/provider-first-run.ts:278-289`. This source trace proves delivery logic only; it does not prove an authenticated provider call. |
| Provider launch              | A build opens a tmux session, changes to the build directory, launches the selected CLI, and later runs `pnpm exec tsx scripts/build-external-module.ts` from `/app`. Claude gets `--permission-mode acceptEdits` and no Bash tool; Codex gets `--sandbox workspace-write`; Gemini gets `--approval-mode auto_edit`. | `apps/worker/src/module-build-live-agent.ts:35-119`; `packages/chat/src/live/cli-launch-commands.ts:51-185`. CLI flags and persona instructions are defense in depth, not confinement.                                                                 |

The source evidence is enough to reject the claim that Workshop builds are currently confined. It is
not enough to claim that a provider can or cannot run in a future boundary, because provider
endpoint allowlists, CLI versions, and the complete teardown contract were not exercised here.

The bounded capability check observed `uid=1000(node) gid=1000(node)`, `CapEff=0`, `/usr/bin/bwrap`,
`unshare -Ur` denied, and no route in `/proc/net/route` under `--network none`. The actual
`bubblewrap-boundary` attempt returned `No permissions to create new namespace`; workspace
write/read passed. The container exited 0 because the probe completed its inventory, not because
confinement passed. Root verified that both named probe containers were absent from `docker ps -a`
after the run. This is evidence for the exact cached image and restricted flags only. It does not
prove that the current production service has those restrictions, that a provider can authenticate,
or that bubblewrap can provide the required filesystem and process boundary under every possible
production profile.

An earlier bounded shell capability check used:

```sh
docker run --rm --name workshop-confinement-probe-0904 \
  --user 1000:1000 --read-only --network none --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 32 --cpus 0.25 --memory 128m \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --entrypoint /bin/sh 81f136b568b6 -c 'set -eu; id; awk "/^CapEff:/{print \$2}" /proc/self/status; \
  command -v bwrap || true; if unshare -Ur true 2>/dev/null; then echo userns-supported; else echo userns-denied; fi; \
  cat /proc/net/route'
```

The recorded probe operation used the full cached digest, fixed tmpfs ownership, and a memory-swap
ceiling:

```sh
docker run --rm --name workshop-a0-capability-0904 \
  --user 1000:1000 --read-only --network none --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 32 --cpus 0.25 \
  --memory 128m --memory-swap 128m \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --tmpfs /attempt:rw,noexec,nosuid,nodev,size=16m,uid=1000,gid=1000,mode=0700 \
  -e WORKSHOP_PROBE_ROOT=/attempt --entrypoint node -i \
  sha256:81f136b568b6297c9f31f1484d11f58c7031041cd853b30ccc2793f833516fa3 \
  --input-type=module < tests/uat/workshop-confinement-probe/probe.mjs
```

## Resumed disposable-container result

The container itself can supply the local OS boundary without nested Bubblewrap. The final
experiment exited **0**, log `/tmp/workshop-a0-container-proof-r4.log`, with candidate image
`sha256:a3d68638562a5ec09230fefddede1bedffb7fba0984e63f0d00ae2d7fbf33663`.
The controller copied only Node and its observed amd64 shared-library dependencies from a
stopped cached source image (`sha256:d4994b0a2f68343c558960a6d0c00884c6e7ee404273419c5772b59ee09de0ed`)
into a scratch image. It did not copy application source, auth homes, package managers or
provider CLIs. This is a synthetic runtime, not the proposed production build image.

The dependency-free reproduction is `tests/uat/workshop-confinement-probe/run-container-proof.py`
with `container-cases.mjs`; see that directory's README for the exact command and prerequisites.
Only synthetic data was mounted. No live credentials, shared service changes, or provider calls.

| Check                  | Observed result                                                                                                                        | Boundary of the evidence                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Identity and privilege | UID/GID 1000, zero capabilities, no-new-privileges                                                                                     | Exact scratch image and Docker profile on this Linux amd64/cgroup-v2 host                   |
| Filesystem             | Workspace write/read succeeds; root write fails; existing synthetic sentinel cannot be read/written; app/data/auth/socket paths absent | One control-verified sentinel and inspected mounts; no claim of a hostile-code escape audit |
| Network                | Only loopback interface; external and app-bridge address probes return ENETUNREACH                                                     | Network-none policy; provider connectivity intentionally absent                             |
| Attempt isolation      | Second workspace has no peer sentinel; peer has no second sentinel and remains intact                                                  | Two concurrent independent tmpfs workspaces                                                 |
| Cancellation           | Three original detached process PID/start-time identities disappear after container kill                                               | Synthetic fixed tree; no application cancellation state or late-completion rejection tested |
| Memory                 | Actual OOM kill at 192 MiB, with swap disabled; peer unaffected                                                                        | Kernel-enforced memory ceiling                                                              |
| PID ceiling            | `pids.events` rejection counter becomes positive at 64 PIDs, then controller terminates spawning loop                                  | Counter is enforcement evidence, not just configured `pids.max`                             |
| CPU/deadline           | Actual throttling at 0.25 CPU; controller kills runaway after its three-second wait deadline                                           | Synthetic controller deadline, not a production supervisor                                  |
| Output                 | Controller kills after crossing 4096 captured bytes (5120 observed); Docker log retention capped separately                            | Control-side cutoff, not a kernel byte quota; in-flight output may exceed the threshold     |
| Cleanup                | All nine owned containers and the unique image tag absent; sentinel unchanged                                                          | Shared Docker build cache retained; no network or volume resources created                  |

The controller and test processes have bounded waits; deliberate runaways also have a 90-second
in-container backstop if the controller dies. At most the peer and one test case run together.
Initial runs R1/R2 failed Docker logging setup (compression conflicts with one retained file);
R3 passed filesystem/network/second-workspace checks but timed out awaiting the process tree at
96 MiB/32 PIDs. R4 used 192 MiB/64 PIDs for the multi-Node tree and its observer. R3's precise
memory-versus-PID failure was not captured and must not be stated as diagnosed. All runs cleaned up.

**At the primitive-only checkpoint, still unproved:** authenticated provider transport with credentials kept outside the attempt,
a real build toolchain operating under this profile, production/dev deployment integration,
and application-level stop/late-result behavior. No A0 or Phase A go decision follows from this
synthetic pass alone.

### Data-only handoff result and recommended next boundary

The next experiment passed, exit **0**, log `/tmp/workshop-a0-data-only-r1.log`, image
`sha256:7b6e6541d6f524e29c536e6e3118b3bcc79c3f713f0ec08dec19a2d7ab1c9eac`.
Run `run-container-proof.py --data-only --source-image <recorded source image ID>`.
The real public `HttpApiAdapter` exchanged requests/responses with a local fixture for Anthropic,
OpenAI-compatible and Google protocols. Each request carried its expected model and a synthetic
credential only in its provider's auth header. Exact response validation rejected extra fields
and a wrong source path. Only returned source crossed stdin into the container.

The restricted tool image added esbuild 0.25.12 and public module SDK source from the same cached
source image. It compiled the returned TypeScript worker inside `/attempt`, then ran the real SDK
worker handshake and `module.invoke`, receiving `{word: "quasar"}`. Traversal was rejected before
writing; a compiler import of the existing unreadable sentinel failed with permission denial.
The new image passed baseline identity/filesystem/network checks. All three owned containers and
the unique image tag were removed, with the synthetic sentinel unchanged.

**Recommendation:** keep model execution in the trusted existing AI adapter layer and pass
validated source data to a separate build container. The build container needs no provider
credential, provider network route, or callable provider/MCP/RPC socket. A trusted controller can
request revisions using bounded build feedback. This is smaller than placing provider CLIs in the
sandbox and inventing a raw HTTP authentication proxy. It preserves the user-facing plan/build
journey and capability-based model selection, subject to the remaining evidence below.

Use the actor-scoped `generateStructured()` routing/validation seam in
`packages/ai/src/structured/generate-structured.ts` for the eventual controller. This experiment
exercised `HttpApiAdapter` directly, so **actor/model capability routing was not proved**. Source
validation and pipe envelopes must bind to the current actor, project, attempt and approved
revision; no fields from generated content can grant authority. Do not accept late completion
merely because a CLI adapter returned text after cancellation.

The source review corrected an initial overly broad CLI-support claim:

- One-shot `CliStructuredAdapter` uses generic launch/submit/read APIs; it has engine paths for
  Claude, Codex and Gemini. Only persistent scoped structured streams require methods currently
  implemented by Claude alone. No product decision to drop Codex/Gemini was made. The earlier
  provider-coverage question was withdrawn.
- Claude's no-MCP one-shot command explicitly disables native tools and uses strict MCP config
  (`claude-print-chat-engine.ts`, `buildCommand`). Its scoped structured command additionally
  specifies no session persistence; do not attribute that flag to every one-shot launch.
- Codex disables known shell/patch/app surfaces and uses a read-only sandbox, but ambient MCP
  settings in its auth home remain an unproved authority surface.
- Correction from the final source check: Gemini's print engine writes `tools.core: []` in its
  session settings before using `--approval-mode yolo`. Native tool suppression is configured;
  effective settings merge, ambient MCP/hooks/context and installed-CLI behavior remain unproved.
  Do not repeat the earlier claim that it supplies no native-tool suppression.
- `CliStructuredAdapter.generateOneShotStructured` can return a late-read fallback after abort or
  timeout. Workshop must check its own attempt/revision authority before accepting any result.

After the fixture-only checkpoint, remaining live proof included actor-scoped model routing, real vendor authentication and
capture, no ambient tools/MCP exposed on each supported CLI path, full web/worker build, and
application stop/late-result behavior. The passing HTTP fixture is not a real vendor login. Keep
A0/Phase A no-go until those requirements are resolved. If implementation is needed, split R1 into
trusted generation/CLI hardening, confined public tool image, and attempt lifecycle tasks; do not
mount the general CLI-runner control socket or auth volume into the build container.

### Authenticated Claude source → confined worker proof

Ben selected the existing Claude connection. The trusted provider helper used the exact token
path used by Moss's CLI runner, entirely inside the running Moss container; no credential value
was displayed or copied to the host, builder, prompt, or artifact. No login/configuration change
or service restart was needed. This directly exercised the installed CLI and its stored account,
**not** the production actor-scoped router, CLI-runner RPC, or `CliStructuredAdapter` lifecycle.

`authenticated-claude-proof.mjs` passed, exit **0**, using Claude Code **2.1.183** and resolved model
**claude-sonnet-4-6** (requested alias `sonnet`). A fresh temporary HOME/config directory, empty
setting sources, `disableAllHooks`, disabled auto-memory, no session persistence, empty native
tools and strict empty MCP configuration excluded ambient project/user context. `--bare` was not
used because this installed version explicitly excludes OAuth in bare mode. Observed init:
`tools: ["StructuredOutput"]`, `mcp_servers: []`; only the schema transport tool was available.
The probe checks tool-use records and successful structured completion before accepting source.
Hook suppression is configured, not a hostile-hook execution test. No agentmemory call was made.

The provider process had a 120-second wall deadline, 64 KiB combined output cap and $0.50 CLI
budget setting. Its detached process group was killed in `finally`, and its temporary home was
removed. This is trusted-process cleanup, **not** proof that arbitrarily reparented provider
children cannot survive. Raw provider stderr is discarded; only sanitized evidence is logged.

Actual source artifact: **250 bytes**, SHA-256
`25e95e1f88f27b65df30160d9012f7fe7d038f5050a701e1f95dd57a62722ce3`.
Logs: `/tmp/workshop-a0-claude-generation-r1.log` and `/tmp/workshop-a0-claude-build-r1.log`;
artifact: `/tmp/workshop-a0-claude-artifact-r1.json`. Generation and build both exited **0**.

`run-container-proof.py --data-only --artifact-file <artifact>` passed that exact returned JSON
over stdin to image
`sha256:7b6e6541d6f524e29c536e6e3118b3bcc79c3f713f0ec08dec19a2d7ab1c9eac`.
The generated TypeScript compiled with real esbuild and the public SDK, emitted `worker.ready`,
and answered `word.read` through `module.invoke` with `{word: "quasar"}`. Filesystem/network/profile,
traversal rejection and denied-sentinel compiler probes passed. All three unique containers and
the image tag were removed and absence verified; shared cache retained. This did not rerun the
already-passing resource stress suite. No generated code ran in the trusted provider environment.

Luna reviewed the extension. Malformed shape, traversal, wrong content type, excess fields,
oversized artifacts and symlinks were rejected before Docker. Final guards also reject Python
`-O` and non-regular files without blocking. Syntax, scoped ESLint and formatting passed.

**Still required:** actor-scoped capability/model routing, CLI safety for other providers, full
web compilation, application attempt/revision/stop behavior, and deployment integration. This is
one simple generated worker proof, not the complete Workshop or a Phase A go decision.

### Generated web bundle and offline browser — passed

The next authenticated response (same Claude Code 2.1.183 / claude-sonnet-4-6) contained exactly
worker index, web index and CSS: **886 bytes**, SHA-256
`0bcf7e56189b4056be0d7a57d9cff7c2a8cff493819f81b2d3ba0abd4d3e6c06`.
Generation exit **0**, log `/tmp/workshop-a0-claude-web-generation-r1.log`, source
`/tmp/workshop-a0-claude-web-artifact-r1.json`. This source was reused without another model call.

`--data-only --web --artifact-file <source>` passed exit **0**, log
`/tmp/workshop-a0-claude-web-build-r1.log`, image
`sha256:9d062deccdb18749f6562db854f247a38b6445c98e0311c0db2bb28ad4649aa3`.
The actual production web recipe (browser ESM/ES2022, classic JSX, React shims/injection and CSS
text loader) compiled the public module-web-sdk, UI and pinned lucide-react 0.468.0. Metafile
checks rejected retained external imports and bundled real React; the resulting default export
loaded with contractVersion 2, callable Root and expected CSS. Worker invocation still passed.

Adding `--browser` passed exit **0**, log `/tmp/workshop-a0-browser-r4.log`, image
`sha256:a4ae9491d04303b6ca8337495f0aee8e0f32a4b0ae5e2c07d56d9f9786522f08`.
The scratch image adds only cached public Chromium, its observed ldd libraries, Liberation fonts,
Playwright 1.60.0, React/ReactDOM 19.2.7 and scheduler 0.27.0. No app/auth files, volumes, sockets
or environment enter the image. The trusted host-page fixture is bundled inside the container;
generated code is compiled, loaded and rendered there only.

Browser profile: UID/GID 1000, cap-drop ALL, no-new-privileges, read-only root, network none,
**512 MiB/no swap, 128 PIDs, 0.5 CPU, 64 MiB workspace tmpfs**. These are separate recorded
ceilings from the smaller worker profile. Chromium uses `--no-sandbox`; the tested Docker profile
is the isolation boundary, not Chromium's internal sandbox. Baseline filesystem/network and
cgroup checks passed on this image; previous stress checks were not rerun at these larger ceilings.

Real Chromium **148.0.7778.96** loaded a fresh context with blocked service workers and exactly
three intercepted fixture resources. The page rendered Daily word, clicking Show word displayed
quasar, and no unexpected requests/page errors occurred. The module-region screenshot was
visually inspected: `/tmp/workshop-a0-c28fe5761b70-web-proof.png`, **6029 bytes**, SHA-256
`dcbb5265d7a27779eae14f3088210ad43251c4ecd5f0b8640ff0e01bb65a8ef8`.
Only public fixture content is present. This bare proof page is not the Workshop design.

Worker invocation, browser ESM load, traversal and unreadable-sentinel compiler denials passed.
All three unique containers and the image tag were removed and absence verified; synthetic
sentinel unchanged, shared Docker cache retained. Browser context/process close is attempted in
finally; container removal supplies the final process boundary. No shared service was restarted.

R1 failed a Chromium layout assumption and R2 a missing docker-cp container prefix; both removed
one source container before image creation. R3 rendered/clicked successfully but failed screenshot
export through Docker's archive view of the workspace tmpfs. It removed all three containers and
image tag. R4 exports the fixed screenshot through a bounded regular-file read in the running
container and validates PNG signature/hash, then completes the denial and cleanup checks.

Luna implemented/reviewed the two bounded case files; root corrected loader/dependency paths,
ReactDOM aliases, external dynamic import and control harness details. Scoped ESLint, JS/Python
syntax, formatting, whitespace and five malformed-web-envelope rejection checks passed.

**Boundary:** the browser uses a tiny host fixture with real React, not Moss's actual loader,
router, CSS confiner or API. The clicked word is local component state; the worker invocation is
proved separately, not wired to that button. Actor-scoped routing, approval/revision/stop behavior,
other-provider CLI safety, dev/prod orchestration and the integrated Workshop remain unproved.
Do not turn this local browser success into a Phase A go decision or deploy it as the runtime.

## Host control and restart feasibility — passed

`run-container-proof.py --control-plane` passed twice. Final R2 log:
`/tmp/workshop-a0-control-plane-r2.log`, exit **0**, minimal public image
`sha256:a8d4ebebd3be7346f0b36b24748f4792a5871eb629b931bff9f02c467fed6c81`.
This uses the existing repository's host-control pattern from
`infra/host/install-restart-unit.sh` and `infra/host/jarv1s-restart.sh`: the application requests
one restricted operation, while a host-owned service retains Docker authority. The existing
restart service itself was neither called nor changed.

The new `control-plane-proof.py` is a synthetic Python/stdlib socket launcher with host-generated
owner/run/lease fixtures. A temporary trusted-client container mounts only its private control
socket directory, with no Docker socket, user-systemd bus or host configuration. It sends only
fixed start/stop envelopes. Build containers mount neither the control directory nor app/auth data;
their image, command, profile, unit and container names come entirely from host-owned configuration.
No request value is interpolated into shell commands.

Observed checks:

- Six invalid token/lease/run/operation/shape/cross-owner start requests are denied. A cross-owner
  stop is denied; duplicate and consumed start requests cannot launch a second unit.
- Authorized stop removes the container and all three recorded detached PID/start-time identities.
- Killing the socket launcher with SIGKILL does not remove systemd's deadline. `RuntimeMaxSec=20`,
  `TimeoutStopSec=3`, `KillMode=control-group` and exact-name `ExecStopPost=docker rm -f` produce
  `ActiveState=failed` and `Result=timeout`. Container/process absence is then verified without
  sending a stop command. The peer's three process identities remain unchanged.
- Restarting the launcher preserves host-private exclusive claim files: completed/timed-out run
  IDs stay consumed, a stale lease stays denied, and authorized stop of the peer still works.
- All three unique user-systemd units, all five owned container names (including the reused
  disposable client name), and the unique image tag are absent after cleanup. Synthetic sentinel
  unchanged; shared image cache retained. No installed unit, shared restart, provider call or DB use.

**Evidence limits:** user-systemd 255.4 on this Linux host, synthetic fixed process trees and static
fixture authority. The claim files are not application persistence, power-loss durability or lease
reconciliation. The launcher is serial and accepts no source/artifact transfer; it is not a
production daemon. These are minimal trusted-client containers, not actual dev/prod application
composition. The final release image and production system-service account still need their own
wiring and policy checks. This run adds lifecycle evidence; it does not repeat browser/resource
stress tests or prove an arbitrary hostile-code sandbox.

### CLI configuration follow-up

The installed **Codex CLI 0.144.5** passed `codex-config-proof.mjs`, a no-model fixture using
`--version` and `mcp list --json` only. Log: `/tmp/workshop-a0-codex-config-r1.log`.
The existing native shell/patch/apps disabling flags and read-only sandbox leave synthetic user
and trusted-project MCP registrations enabled. Adding `-c mcp_servers={}` also leaves both
registrations enabled. A separate `CODEX_HOME` still loads the trusted-project fixture; combining
that separate home with an empty neutral directory produces an empty registered-server list.
The failing isolation alternatives are negative controls, not passes for their safety.

This matches the documented distinction between
[Codex state/configuration location and project configuration](https://learn.chatgpt.com/docs/config-file/config-advanced).
The helper supplies no credential files, strips inherited environment and removes its temporary
homes. It does not launch MCP servers, authenticate, generate source, test hooks/native execution,
or prove that system/managed configuration cannot introduce authority. R1b must carry the isolated
home/cwd policy through the actual authenticated runner and verify its effective tool surface.

Gemini's current engine already writes `tools.core: []`; its existing unit test file passed all
**12 tests**, log `/tmp/workshop-a0-gemini-engine-tests.log`. The inspected app container has no
`/data/cli-tools/bin/gemini`, so installed Gemini configuration behavior remains unproved. No
installation, login or provider-scope change was made.

### Authenticated source-generation RPC continuation (#2277)

`authenticated-source-rpc-proof.ts` passed exit **0** with installed Claude Code **2.1.183** and
the previously selected concrete model **claude-sonnet-4-6**. Log:
`/tmp/workshop-authenticated-source-rpc-r1.log`. Current worktree code was bundled and streamed
into the trusted Moss container with a minimal environment. The actual `CliStructuredAdapter`
called the real authenticated RPC client/server, runner host and source-policy engine. The
runner used a private home with an in-container symlink to its existing credential and a private
socket under the real client's allowed path. No socket-guard override or fake executable was used.

The expected one-file source envelope was **84 bytes**, SHA-256
`d7fba43a2cede9ce78cf52e217cc1ce301caa2d7a60bc82fe4c9388f516e337f`. Source was validated as data,
never executed or exported. The engine accepted the matching-model, tool-restricted completion;
the adapter closed its session. Assertions confirmed removed provider/adapter homes, no process
retaining the source cwd, and a still-running peer. Final cleanup removed owned sessions, peer,
socket and temporary roots. Shared services, installations, configuration and DB were untouched.

This closes the gap between the earlier direct authenticated CLI proof and synthetic RPC test.
It does not prove actor-scoped routing/credentials, full `createCliRunner` deployment composition,
hostile-hook execution, live abort/timeout, or other providers. A descendant that changes cwd is
outside this process check. The isolated server deliberately omits installation/login services
and their shared-state sweeps. The new Workshop execution path remains unavailable.

### Installed Claude hook and cancellation continuation (#2277)

Two additional bounded probes passed using the same selected Claude connection/model, with current
worktree code and the installed CLI. `claude-hostile-hooks-proof.ts` ran the actual source launch
policy against a synthetic user-config `SessionStart` hook that writes only a private marker.
With user settings/hooks explicitly enabled, the marker appeared and the control process group
was killed. With the production source-policy arguments unchanged, the hook did not execute and
the CLI returned the validated, tool-restricted `{word: "quasar"}` response. Both private homes and
the proof root were removed. Log `/tmp/workshop-hostile-hooks-r2.log`, exit **0**. R1 was blocked
by sandbox Docker-socket access before execution; R2 used an approved sandbox escalation.

`authenticated-source-rpc-proof.ts` with `WORKSHOP_PROOF_ABORT=1` exercised the real adapter and
authenticated client/server/runner/engine. After prompt submission and the first incomplete RPC
read, the harness observed one live process retaining the private source cwd and aborted. It
received `AbortError`, returned no artifact and recorded timeout exit telemetry. The observed PID,
source/adapter homes and session were gone before final cleanup; the peer remained alive. Cleanup
removed the private runner root/socket and peer. Log `/tmp/workshop-source-rpc-abort-r1.log`, exit
**0**. This observes a live submitted process; it does not establish that a remote request began.

The hook proof tests the combined user-settings/hook controls, not each flag independently or
managed/project/plugin hooks. It directly uses the launch policy; it is separate from the RPC
cancellation proof. Full engine wall-timeout, changed-cwd hostile descendants, actor isolation,
actual deployment composition and Codex/Gemini policy remain unproved. No product behavior or
shared configuration changed, and no new Workshop execution was enabled.

### Installed deadline, composition root and Codex tool inventory (#2277)

The actual Claude source engine's **120-second wall deadline** passed through authenticated RPC.
The harness withheld prompt input, leaving the installed CLI waiting on stdin, so this made no
model call. The adapter's outer deadline was 130 seconds and the harness backstop 135 seconds.
The engine returned its own timeout after **120,053 ms**, with no external abort or accepted
artifact. The one observed source PID, session and temporary homes were removed; the peer survived.
Log `/tmp/workshop-source-deadline-r1.log`, exit **0**, both deadline and cleanup checks passed.
This proves idle-process wall-time enforcement, not timeout during a remote model response.

The harness now also supports `WORKSHOP_PROOF_FULL_RUNNER=1`. Actual `createCliRunner` generation
and live cancellation both passed with real install/login services and persistent-pool wiring.
To avoid the installer's startup reconcile mutating shared releases, its private inventory starts
empty; only after startup does the harness link the existing Claude executable into its private
tools directory. No installer/login operation or shared change occurred. Generation returned the
same validated **84-byte** artifact, SHA-256
`d7fba43a2cede9ce78cf52e217cc1ce301caa2d7a60bc82fe4c9388f516e337f`; cancellation returned no artifact
and removed one observed source process. Session checks and cleanup themselves now use the real
RPC client. Both runs removed owned roots/socket/peer and left their peer alive until cleanup.
Logs `/tmp/workshop-full-runner-source-r1.log` and `/tmp/workshop-full-runner-abort-r1.log`, exits
**0**. This closes the hand-assembled-server gap; actual deployment startup/reconciliation and
actor credential routing remain unproved.

A credential-free local Responses fixture exposed an additional Codex policy gap. Installed
**codex-cli 0.144.5** advertised `update_plan`, `request_user_input` and `view_image` despite the
candidate flags, including `tools.view_image=false`. Its source RPC remains unavailable. The
approved diagnostic identified a missing `usage.total_tokens` field in the local SSE fixture.
After correcting it and the separately identified PNG checksum defect, R3 passed exit **0**:
`/tmp/workshop-codex-source-request-r3.log`. The actual `view_image` call reached the filesystem
helper, whose namespace creation was denied by the container. The second local request carried
that specific tool error and no image; a valid structured response then completed the CLI. This
is a negative control rejecting the candidate, not proof of a successful private read or a safe
source policy. The synthetic model uses fallback metadata; real-model behavior, Codex hooks,
authentication and runner composition remain unproved. No sandbox was relaxed, and no approval
remains pending. The probe README records commands, official references and exact limits.

### Source-route dispatch consistency (#2277)

The existing shared `generateStructured` source path now rejects empty/default model selectors
and a selected credential row whose provider ID, owner or provider kind disagrees with the routed
model. Checks happen before credential decryption or either adapter factory. Ordinary structured
calls preserve their default-selector behavior. Two new regression cases initially reproduced
successful dispatch for invalid source routes; all **10** targeted tests pass after the guard.
Matching CLI/API routes for two synthetic actor contexts retain their exact concrete model, source
intent and scoped lookup. This is local provider-record consistency, not proof of DB RLS or
actor-specific runner credential storage. No Workshop execution or worker launch path changed.

## Source-only deployment contract for Phase A review

**Selected candidate for review:** trusted capability-routed generation followed by an ephemeral,
networkless build/render container. This replaces the earlier provider-in-builder broker proposal.
It is an engineering recommendation supported by the local proofs, not a selected production
deployment or a Phase A go decision. No provider restriction is implied.

The trusted controller owns this sequence: load current owner/revision authority → request source
through `generateStructured()` → validate the returned file envelope → execute fixed host checks
in the container → validate bounded artifacts → recheck authority before accepting evidence.
Compiler diagnostics can inform another model turn, but remain untrusted data. The controller
never imports, evaluates, or executes returned source in the provider or application environment.

| Boundary              | Required deployment contract                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trusted generation    | Use actor-scoped `DataContextDb`, capability routing and explicit interactive/reasoning tier. Preserve binding/pin policy and pass the concrete resolved model to the adapter. Provider auth stays in its existing trusted credential path. No provider/model literal from the probe becomes a product default.                                                                                           |
| CLI authority         | Source generation has no native file/shell/network tools, ambient MCP, hooks, project instructions or persisted private session context. The schema transport is permitted; observed tool use must match it. HTTP and each CLI route need separate evidence. An unproved route fails before dispatch with configuration recovery; do not silently switch provider.                                        |
| Execution unit        | One fresh, identifiable container/workspace per execution, pinned public tool image, fixed non-root identity, read-only root, no capabilities, no-new-privileges and the default seccomp policy or a stricter tested policy. No privileged mode, nested daemon, app/auth/module volume or container-admin socket.                                                                                         |
| Input                 | Only host-selected public SDK/UI/toolchain inputs and bounded validated source files enter. The host binds actor/project/revision/attempt/lease and source hash outside the generated object. Reject traversal, duplicate paths, links, special files, unsupported dependencies and excess fields/bytes. Source cannot select image, command, mount, environment or resource limits.                      |
| Network and transport | `network_mode: none`; no provider or Moss bridge route. Bounded stdin/stdout or an equivalently restricted data channel carries files and results. No callable AI, general CLI-runner RPC, MCP or Docker socket enters the attempt. A control endpoint belongs outside the untrusted execution unit.                                                                                                      |
| Execution and output  | Fixed worker/web/test/render recipes use preinstalled dependencies; no generated package lifecycle scripts or online installation. Host-owned checks determine success. Bound output during streaming; validate returned files and decode/re-encode raster previews before accepting them. Raw build/provider output never becomes application logs, queue content or an executable host command.         |
| Resource profile      | Separate worker and browser profiles include CPU, memory/no-swap, PID, workspace, output/log and wall-time ceilings. The recorded 192 MiB/64 PID worker and 512 MiB/128 PID browser settings are probe evidence, not production sizing. R1 must record and stress-test the final image/profile combination.                                                                                               |
| Stop and crash        | Persist stop intent and invalidate authority before teardown. Stop both trusted generation and the exact container; verify exit/removal before reporting stopped. A failed/unknown teardown stays stopping or recovery-needed. Reject late results on abort, superseded revision or lease mismatch, even if the adapter returns valid JSON. Reconcile owned orphan units after controller/worker restart. |
| Artifact promotion    | Copy only validated bounded output into host-owned staging on the installed-module filesystem, then use supported atomic installation. The container never mounts that filesystem. Recheck candidate hash and current authority at promotion; failure preserves the last usable version. R1 supplies transport, while V1/V2 and L1–L3 own verification/installation semantics.                            |

### Recommended deployment control plane; production wiring remains unresolved

Select the existing host-control pattern for the R1 design: a fixed-operation launcher owned by
host deployment, with each execution owned by a separate systemd unit and constrained container.
The isolated control proof above supports this recommendation. Proposed R1d-owned files are
`infra/host/workshop-control.py` and `infra/host/install-workshop-unit.sh`, plus its systemd service
and dev/prod Compose/env/release wiring. The installer must verify Python/systemd/Docker availability,
use the deployment account rather than granting new container-admin authority to the app, and
install a private socket directory separate from the restart button's world-writable sentinel
folder. The application mounts only this control directory; generated code never mounts it.
No production file or installed service is created by this decision record.

The successful probe's Python controller runs on the host with Docker access. Neither current
dev worker configuration nor the production `jarv1s` service supplies that capability. Moving
this harness into the worker therefore does not implement the tested boundary. Mounting a Docker
socket into the app or a new controller container would violate the stated prerequisite.

R1d must make this deployment-owned launch/deadline/stop/reap path concrete in both supported
compositions, including its exact service identity, installation/update path, authenticated
control transport and restart owner. The local source-only container and systemd proof avoids a
new remote execution service; no remote platform is needed by the observed requirements.
Any new host service or management authority is an explicit trust/operations decision for Phase A
review, not an implicit permission in this document. Do not invent a general job platform.

The control contract accepts only authorized run references and bounded source, uses fixed image,
command and profile choices, and isolates cancellation by opaque run identity. It must reject
arbitrary Docker arguments, host paths, cross-owner run IDs and replayed/stale leases. The existing
static sports sidecar shows Compose restriction syntax; it does not demonstrate fresh per-attempt
isolation or safe reuse after generated code has executed.

**Phase A review boundary:** host-control mechanism and local launch/stop/deadline/restart proof are
now named and observed. Actual dev/prod application wiring, authenticated actor-routing and
all-provider CLI safety remain required evidence; the synthetic host fixture cannot supply them. Preserve the earlier primitive/browser evidence; repeat
only checks affected by the selected image, policy or lifecycle. If this mechanism needs broader
privilege than the contract permits, record infeasibility and bring that concrete tradeoff to Ben.
The R1 task split is in the [build plan](../plans/2026-09-04-workshop-projects-and-supervised-builds.md#r1-owned-capability-tasks-for-phase-a-review).

## Candidate mechanisms

| Option                                | What it preserves                                                                                              | What it must prove here                                                                                                                                                                                                                                                                                                                      | Decision                                                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-provider process plus OS sandbox  | Existing `module-build-live-agent`, provider launch lines, and most worker wiring.                             | Bubblewrap/user namespaces or an equivalent must work inside the production container; the sandbox must bind only the attempt, broker, and read-only tool paths; it must deny app network/mounts; and the process group must be killable. The current image's `bubblewrap` package and current Compose privileges do not prove any of these. | Smallest code delta, not selected while evidence is missing.                                                                                |
| Source-only ephemeral build container | Reuses trusted AI routing and public build tools; separates generated execution from credentials and app data. | Pinned image, deployment-owned fixed-operation control path, source/artifact validation and per-attempt teardown. No provider transport enters the container.                                                                                                                                                                                | **Selected candidate for Phase A review**; local worker/web/browser proof passed, control-plane and deployment integration remain unproved. |
| Remote runner                         | Strongest host separation if operated correctly.                                                               | Connectivity, provider credential brokering, artifact transfer, cancellation, availability, and a new service trust boundary.                                                                                                                                                                                                                | Too much new operation for the first local proof; revisit only if local isolation cannot meet the contract.                                 |

The source-only contract above supersedes the initial broker recommendation. The host-owned systemd launcher is the recommended controller mechanism; release image and actual
dev/prod wiring remain unproved. Do not implement R1
against the present `jarv1s` service and call it confined.

## Probe artifact and approved run boundary

`tests/uat/workshop-confinement-probe/probe.mjs` is dependency-free and bounded. It emits one JSON
record per check and exits nonzero for a demonstrated escape or a missing required setup. It checks:

- effective identity/capability and user-namespace/bubblewrap availability;
- write/read inside `WORKSHOP_PROBE_ROOT`;
- read and write denial only for explicitly supplied fixture paths that the control side first proves
  exist. Missing paths are `unproved`, never a pass.

The harness must create a unique temporary Compose project and synthetic fixture files outside the
allowed workspace. It must not mount the repository, production volumes, provider auth, database
secrets, Docker socket, or a host-wide path. The control side records image identity, effective user,
mounts, capabilities, security options, limits, and network attachments before the probe. The runner
must use strict `--memory`, `--cpus`, `--pids-limit`, and `--network none` (or the selected
provider-broker network), then remove only that unique project and assert no leftover resources. Root
approval is required before each runtime operation. Network, provider transport, exact process-tree
cancellation, and resource termination remain implementation-specific follow-up probes; this small
artifact does not claim to prove them.

## Exit decision

**A0 status: local OS primitives and authenticated Claude worker/web generation, build and offline browser pass;
integrated Workshop/deployment/lifecycle remains no-go.** The Bubblewrap attempt failed, while
the subsequent scratch-container profile proved the recorded local isolation/resource checks.
Claude's real returned source now compiles and runs without provider auth inside that boundary.
Keep model execution trusted and source handoff narrow. No production sandbox, downstream runtime,
or deployment is selected by this proof. R1 remains gated on the remaining evidence and Phase A
review; this record does not claim the Workshop is functioning end to end.

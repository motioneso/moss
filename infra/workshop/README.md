# Workshop isolated build/render image

R1c, tracked by [#2289](https://github.com/motioneso/moss/issues/2289). This is a public-toolchain
image and disposable proof, not a deployed controller or permission to enable Workshop execution.
The worker remains unavailable until runtime control and current attempt authority are verified.

## Build inputs

Build from the repository root:

```sh
docker build --platform linux/amd64 -f infra/workshop/Dockerfile -t moss-workshop-r1c:local .
docker image inspect moss-workshop-r1c:local --format '{{.Id}}'
```

The upstream public Playwright image is pinned by manifest digest in the Dockerfile. Its exact
Node, Chromium, shared libraries and fonts are collected into a scratch filesystem. The separate
npm lock pins esbuild, Playwright Core, React/ReactDOM and lucide-react, with lifecycle scripts
disabled. Only public module SDK/UI sources and the existing token stylesheet enter from the
repository. The Dockerfile-specific context allowlist excludes application code, credentials,
local state and host dependencies. No app image, provider CLI, package manager or shell is copied.

Reproduction fixes dependency versions and source inputs; byte-for-byte image reproducibility
across independent builders has not been asserted. Only linux/amd64 has been exercised. Run the
resulting immutable local image ID, not a mutable tag. Registry publication is separate work.

## Runtime contract

The entrypoint accepts one bounded JSON source envelope on stdin:

```json
{ "files": [{ "path": "src/worker/index.ts", "content": "export {};" }] }
```

At most 32 files, 32 KiB of UTF-8 content per file, 64 KiB combined path/content bytes and
128 KiB encoded input. Paths are canonical relative allowlisted source paths, `SPEC.md`,
`README.md` or `jarvis.module.json`. Duplicate paths (including case aliases), links, excess
fields, package scripts/configuration, NUL content and unsupported dependencies are rejected.
This matches R1a's host envelope; both trust boundaries validate independently.

The fixed `build` recipe bundles worker/web using the existing external-module recipe and executes
`tests/*.test.ts` with Node's test runner. The fixed `render` recipe adds a browser-only module
mount, public UI styles and a 900 × 700 raster preview. Generated web code never loads in host
Node or an authenticated Moss page. Browser requests are intercepted from a fixed local fixture;
all other requests fail. Chromium's internal sandbox is disabled, as in the approved local proof:
the container boundary and its controller-enforced profile are required.

Outputs are untrusted JSON proposals: source hash, fixed-path base64 bundles/PNG with hashes,
and observations of completed recipes. Each artifact is a bounded regular file read without
following links, at most 1 MiB; total encoded output is at most 2 MiB. Child test output is capped
at 64 KiB and each test process at 15 seconds, followed by SIGKILL. Raw diagnostics are suppressed.
A child exit code or generated test is not host verification or candidate promotion permission.
The future R1e/V1 importer must revalidate the entire response, decode/re-encode raster data,
verify the current actor/revision/attempt/lease/source hash and preserve the previous usable version.

## Required outer boundary

The image is not a sandbox by itself. The trusted controller must enforce these settings, bound
stdin/stdout/stderr while streaming, and own wall-time termination and cleanup independently of
the generating process. No source-selected image, command, environment, host mount or limit.

| Limit                    | Worker build                             | Browser render |
| ------------------------ | ---------------------------------------- | -------------- |
| Memory / swap            | 192 MiB / 0                              | 512 MiB / 0    |
| PIDs                     | 64                                       | 128            |
| CPU                      | 0.25                                     | 0.5            |
| Attempt tmpfs            | 64 MiB, private, noexec/nosuid/nodev     | Same           |
| User                     | 1000:1000                                | Same           |
| Root / network           | Read-only / none                         | Same           |
| Capabilities             | Drop all; no-new-privileges              | Same           |
| Outer wall time / output | 60 seconds / 2 MiB stdout, 64 KiB stderr | Same           |

No Docker socket, application data, credentials or controller socket is mounted into an attempt.
Disable daemon logs to prevent unbounded disk output. Runtime startup checks UID, no-new-privileges
and cgroup ceilings as defense in depth; these checks do not replace controller enforcement.

## Automated local proof

```sh
node --test infra/workshop/source.test.mjs
python3 infra/workshop/prove-image.py \
  --image sha256:dbf24bc666f3f966bfccac884b136198c85a33e96e035ca1e49c9288a19a5e1d \
  --output-dir /tmp/workshop-r1c-proof-new
```

The output directory must not already exist. The harness creates unique container names, streams
bounded I/O, removes only its owned containers, and verifies absence. A peer must survive failed
attempts, test timeout and resource stress. It does not install anything or restart a shared service.

Verified local image: `sha256:dbf24bc666f3f966bfccac884b136198c85a33e96e035ca1e49c9288a19a5e1d`,
756,962,234 bytes, amd64. Node **24.15.0**, Chromium **148.0.7778.96**, esbuild **0.25.12**,
Playwright Core **1.60.0**. `/tmp/workshop-r1c-proof-03.log` records:

- Real public SDK worker ready/invocation, actual resource settings, read-only root and missing
  app/credential/socket/package-manager paths; external connection fails `ENETUNREACH`.
- Worker/web compilation and stable bundle bytes across build/render, offline UI rendering and
  an 8,464-byte PNG with validated signature, dimensions and chunk CRCs.
- Traversal, duplicate, extra command, source overflow and unavailable dependency rejection.
- Test-output flood and wall timeout fail without exporting artifacts.
- Workspace `ENOSPC`, PID cgroup enforcement, CPU throttling and kernel OOM termination (137).
- Peer survival and verified cleanup of all 14 owned containers.

Parser tests, scoped ESLint, formatting and Python/Node syntax pass. The repository file-size
check still reports two pre-existing Sports files; no new runtime file exceeds 250 lines.
Actual dev/prod control wiring, controller-loss recovery, durable authority and installed Workshop
acceptance are not covered by this local proof. Keep the execution gate closed.

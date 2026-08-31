# Module-build worker environment isolation

Date: 2026-08-30
Status: Approved by Ben — 2026-08-30 (parity scope)
Issue: #1860

## Context

Module builds run a real configured AI provider in a tmux pane owned by the background worker.
`apps/worker/src/worker.ts` currently creates that path with
`createRealTmuxIo({ ...process.env, HOME: moduleBuildCliHome })`. Every subprocess started by that
adapter, including the tmux server whose login shell launches the provider, therefore inherits the
worker's complete container environment.

That path bypasses the CLI-runner boundary fixed during PR #1654. Chat launches use
`createSanitizedTmuxIo`, whose canonical `buildSanitizedCliEnv` policy is deny-by-default and only
admits the small set of environment values required by provider CLIs. In particular,
`JARVIS_UAT_SCRIPTED_PROVIDER_BIN` survives only when it exactly equals the shipped UAT fixture
directory. The worker currently bypasses both the allowlist and that exact-value pin.

The launch flow is:

1. `buildWorker` receives the app/container environment.
2. It creates `moduleBuildIo` and a private `TmuxMultiplexer` for module builds.
3. `createRunModuleBuildStepForJob` selects the owner's configured provider and constructs
   `createModuleBuildLiveAgent` with that I/O and multiplexer.
4. `createModuleBuildLiveAgent` builds the provider command and opens a detached tmux session.
5. The pane starts as a login shell; `/etc/profile.d/jarvis-cli-path.sh` rebuilds `PATH` from
   `JARVIS_UAT_SCRIPTED_PROVIDER_BIN`, `JARVIS_CLI_TOOLS_PREFIX`, and the shell's existing `PATH`.
6. The bare provider command (`claude`, `codex`, or `gemini`) resolves from that path.

Consequently, an arbitrary `JARVIS_UAT_SCRIPTED_PROVIDER_BIN` value set on the container can select
an attacker-controlled executable for module builds even though the same value is rejected on the
chat path. The full inherited environment also exposes app, database, and encryption secrets to
the module-build subprocess tree without a demonstrated need.

## Goals

- Put every subprocess launched through the module-build tmux I/O behind the existing CLI child
  environment allowlist.
- Preserve the module-build-specific `HOME` override so provider credentials and tmux state remain
  under the configured CLI home.
- Apply PR #1654's exact shipped-fixture pin to `JARVIS_UAT_SCRIPTED_PROVIDER_BIN` on the worker
  path, including its paired chat-script value.
- Prove at the actual worker composition seam that an attacker-chosen UAT provider directory and
  representative app/database secrets do not reach the child environment.
- Correct the two comments that currently describe the chat-only protection as container-wide.

## Non-Goals

- Changing module-build prompts, permissions, provider selection, build steps, or tmux lifecycle.
- Creating a second environment-policy implementation in the worker.
- Changing the CLI-runner allowlist or the accepted UAT fixture directory.
- Changing the production image, compose topology, installer, or provider installation layout.
- Treating module-build agents as trusted with host app/database secrets; they remain untrusted
  subprocesses with workspace-scoped write permission.
- Adding a UI or user-facing workflow. This is an internal security boundary and does not require
  live UI proof.

## Resolved Decisions

### Reuse the canonical sanitized adapter at the composition root

The worker will construct module-build I/O with `createSanitizedTmuxIo`, already exported by
`@moss/cli-runner`, rather than `createRealTmuxIo`. `@moss/worker` already depends on
`@moss/cli-runner`, so this adds no package dependency and no duplicate policy.

The source environment supplied to that adapter will contain the resolved module-build CLI home as
`HOME`. The sanitized adapter then applies the existing allowlist once and uses the result as the
base environment for every `run` call. Per-call values continue to layer over that sanitized base
as they do on the chat path.

This is the smallest effective seam: one composition-root substitution covers tmux creation,
provider launch, and the post-write module build command. Filtering later in
`createModuleBuildLiveAgent` would miss earlier subprocesses;
filtering in each caller would duplicate policy and leave sibling calls exposed.

### The existing exact-value UAT pin remains the authority

The worker will not reproduce the fixture constant or add a UAT mode flag. A mode flag travels
through the same container environment as the value it claims to authorize and therefore adds no
trust. `buildSanitizedCliEnv` remains the sole authority: it emits the built-in fixture directory
literal only when the source value is byte-for-byte equal, and otherwise drops both
`JARVIS_UAT_SCRIPTED_PROVIDER_BIN` and `JARVIS_UAT_SEED_CHAT_SCRIPT`.

### Keep runtime app environment intact outside the module-build subprocess tree

`scripts/start-jarv1s.ts` will continue to give the resident worker its normal app environment. The
worker needs database URLs, encryption keys, vault configuration, and queue settings to perform its
host duties. Isolation happens only where the worker crosses into the module-build subprocess
boundary; changing `buildChildEnv("worker")` would break unrelated worker responsibilities and
would be a much broader change.

### Correct comments to name the boundary they actually protect

The comments beside the UAT fixture pin in `packages/cli-runner/src/sanitized-env.ts` and
`scripts/start-jarv1s.ts` will say that the rule protects CLI-runner/chat children. They must not
claim container-wide protection. The worker path becomes protected by reusing the same policy, but
future subprocess roots could still exist and must establish their own boundary explicitly.

## Approved executable-resolution scope

`JARVIS_CLI_TOOLS_PREFIX` and `PATH` are both intentionally present in the canonical CLI child
allowlist. The login-shell profile uses them in provider lookup, and production compose makes the
tools prefix configurable because the installer and UAT/dev setup need it. An actor able to choose
either value may therefore redirect provider lookup even after the arbitrary UAT fixture variable
is dropped.

Ben approved the **parity scope** on 2026-08-30: these values are trusted operator deployment
configuration for #1860. The implementation closes the worker's bypass of the existing chat
boundary. It must not claim to make provider resolution independent of a deployment operator who
controls `PATH` or `JARVIS_CLI_TOOLS_PREFIX`.

Executable integrity independent of trusted operator configuration is out of scope. It would need a
separate grounded design for a trusted provider installation root that still supports installer and
dev/UAT layouts; the current code contains no safe value or trust source to infer.

## Architecture

The intended parity-scope dependency flow is:

```text
resident worker process (full app environment)
  -> resolve module-build CLI HOME
  -> createSanitizedTmuxIo(source with HOME override)
     -> buildSanitizedCliEnv (canonical deny-by-default policy + exact UAT pin)
     -> execFile environment contains only allowed CLI values
  -> TmuxMultiplexer on private module-build socket
  -> login-shell pane
  -> configured provider CLI
```

Policy remains owned by `@moss/cli-runner`; worker composition owns deciding that module builds
cross that policy boundary. `createModuleBuildLiveAgent` remains unaware of environment policy.

## Exit Criteria

- The module-build worker no longer constructs its subprocess I/O from `createRealTmuxIo` or an
  unsanitized spread of `process.env`.
- The actual I/O instance supplied to the module-build multiplexer and live agent is created by the
  canonical CLI-runner sanitized adapter with the resolved module-build home as `HOME`.
- A regression test exercising the worker-owned composition seam proves all of the following in
  the environment delivered to a real child process or an exact adapter-level capture:
  - `HOME` is the resolved module-build CLI home, not ambient host home;
  - an attacker-chosen `JARVIS_UAT_SCRIPTED_PROVIDER_BIN` is absent;
  - its paired `JARVIS_UAT_SEED_CHAT_SCRIPT` is absent when the bin value is rejected;
  - representative database URL, app secret, encryption key, and vault values are absent;
  - the exact shipped UAT fixture value still survives so existing live UAT remains usable.
- The regression assertion fails against the pre-fix worker composition, rather than merely
  retesting `buildSanitizedCliEnv` in isolation.
- The two identified comments describe their real boundary and make no container-wide claim.
- Scoped lint, formatting, test TypeScript, the focused regression test, and the full isolated
  verification gate are green.
- The PR is marked security-sensitive and receives adversarial security review plus Ben's explicit
  sign-off. Release note category is `N/A`.
- Ben's `PATH`/`JARVIS_CLI_TOOLS_PREFIX` scope decision is recorded in the approved plan and PR
  security claim.

## Hard Invariants Honored

- **Secrets never escape:** app, database, connector, AI encryption, session, and vault secrets do
  not enter the module-build provider subprocess environment.
- **Metadata-only job payloads:** queue payloads and module-build orchestration data are unchanged.
- **Provider-agnostic AI:** the owner's configured provider is still selected by the repository;
  no provider or model is hardcoded.
- **Module isolation:** generated modules remain confined to their build directory and continue to
  use declared module interfaces.
- **No admin private-data bypass / private by default:** authorization, RLS, and database access are
  unchanged.
- **Vault I/O through `VaultContext`:** vault composition and access are unchanged.
- **`AccessContext` remains unchanged.**
- **Migrations and the pgvector deployment image are untouched.**
- **Production remains bootable:** the change reuses an existing dependency and environment policy;
  it introduces no required setting.

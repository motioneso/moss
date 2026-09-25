# Keep the AI Command-Line Tools Up To Date

**Status:** Draft, awaiting Ben's approval
**Date:** 2026-09-25
**Owner:** Ben
**GitHub:** issue #2689 (follows #2674 / PR 2688; related #2683, #2687)

---

## 1. Problem

Moss runs the provider command-line tools (Claude CLI, Codex CLI, Gemini CLI, OpenCode) to answer
chat and background AI calls. Every tool is pinned to one exact version that ships inside the Moss
image. When a provider ships a model the pinned tool cannot run, Moss fails silently. On prod,
background AI failed from 2026-08-07 until PR 2688 because the Claude CLI was 2.1.183 and
`claude-opus-5-5` needs 2.1.280 or newer. The error went to the child's stdout, which the one-shot
engine ignores.

Ben's rulings:

- 2026-09-25: the CLI tools must auto-update.
- 2026-09-24, on this spec: updates must reach every Moss instance, not just Ben's. A user must
  not have to upgrade Moss to use a new model.

Blind "always latest" is not safe either. Two CLI releases broke Moss with no model change:

- `--tools "Read,Glob,Grep"` started hiding every `mcp__jarvis__*` tool, so chat answered but
  could never act (#2317, PR 2318).
- Structured replies arrived inside a ```` ```json ```` fence and failed `JSON.parse` (#1888,
  PR 1940).

A new version must prove it still works the way Moss uses it, on each instance, before that
instance's users depend on it.

## 2. How the tools are installed today

Two separate families, with separate versions of the same provider's tool.

| Family | Packages | Where the version is pinned | Where it lives at runtime | Used by |
|---|---|---|---|---|
| Recipe tools | `@anthropic-ai/claude-code`, `@openai/codex`, `@google/gemini-cli` | `RAW_CATALOG` in `packages/cli-runner/src/catalog.ts` plus a committed `recipes/<provider>/npm-shrinkwrap.json` | Tools volume (`/data/cli-tools`), `providers/<p>/releases/<rand>`, `current` symlink, `bin/<binary>` | One-shot and structured background calls, terminal login, model listing |
| Chat adapters | `@agentclientprotocol/claude-agent-acp` (bundles `@anthropic-ai/claude-agent-sdk`, which carries its own Claude Code build), `@agentclientprotocol/codex-acp` (depends on `@openai/codex`), `opencode-ai` | `packages/cli-runner/package.json` and `pnpm-lock.yaml` | Baked into the image under `node_modules` | ACP chat |

On current main the two Claude copies differ. Background runs Claude Code 2.1.183 from the recipe,
while chat runs 2.1.257 bundled inside `claude-agent-sdk` 0.3.257. Codex is 0.144.5 in the recipe
and 0.153.4 under `codex-acp`. That split is why chat kept working while background AI broke.

Relevant existing machinery:

- The catalog is a supply-chain allowlist: exact versions, committed sha512 lockfiles,
  `npm ci --ignore-scripts`, no `latest`, no ranges.
- Each tool's own self-updater is switched off (`selfUpdateDisable`).
- `InstallService.reconcileInstalledProviders()` runs at runner boot. It reinstalls any installed
  recipe tool whose version or hash no longer matches the catalog.
- Promotion is atomic (`current` symlink flip) with rollback on a failed verify. Old releases are
  garbage-collected right after a successful promote.
- The module registry already publishes an Ed25519-signed catalog to a rolling GitHub release
  (`modules-registry.yml`, `packages/module-registry/src/distribution/catalog-signing.ts`). The
  image carries the trusted public key.
- Nothing recognises the "version X or newer is required" error today.

## 3. Decisions

### 3.1 Tool versions travel separately from the Moss image

Moss CI publishes a signed **tool manifest** that lists vetted versions and their lockfiles. Every
instance fetches it daily and updates its tools on the tools volume. A self-hoster on an old Moss
release still gets new tool versions without upgrading Moss.

The version pinned in the image stays as the floor. It is what a fresh instance installs before its
first manifest fetch, and what an instance runs if it can never reach the manifest.

The obvious alternatives were rejected.

| Option | Why not |
|---|---|
| A scheduled PR that bumps the pin in the image | Users would have to upgrade Moss to get a new tool, which Ben ruled out. |
| Each instance installs npm `latest` directly | Drops the catalog's supply-chain rule. No lockfile, no hash pinning, and no central check that Moss's flags still exist. |

The manifest keeps the supply-chain rule. Each entry is an exact version plus a full sha512
lockfile, and the whole manifest is signed.

### 3.2 Chat adapters move onto the tools volume

Chat adapters are image dependencies today, so an instance can neither update them nor hold one
back. They become recipe entries installed onto the tools volume like the CLIs. The runner resolves
the adapter from the tools volume and falls back to the image copy when none is installed.

The unit of update is a **provider toolset**, meaning a provider's CLI and its chat adapter
together. For example, the Claude toolset is `@anthropic-ai/claude-code` plus
`@agentclientprotocol/claude-agent-acp`. The two are promoted or held back together, so chat and
background never drift apart again.

### 3.3 Each instance checks a new toolset before its users get it

The central check proves the toolset installs and still accepts Moss's flags. It cannot prove this
instance's sign-ins and models work with it. So each instance stages the new toolset beside the
live one and runs a short live check with its own connection. It switches over only when the check
passes. On a failure it keeps the old toolset and alerts the admins.

### 3.4 Ben's answers (2026-09-24)

- **Q1.** The question was whether to store a sign-in as a GitHub secret for a pre-merge live check.
  Ben answered that updates must work for every instance, and users must not have to update Moss to
  get new models. That answer drove 3.1 and 3.2. The pre-merge live check with GitHub secrets is
  dropped, because each instance's own check covers it.
- **Q2.** New versions are taken the same day they are released, with no waiting period.

### 3.5 Other decisions

- Alerts go to instance admins as a push notification, a notice on the AI providers screen and an
  audit record. The result is also written where the daily health check (#2683) can read it, with
  no dependency on #2683 shipping first.
- No setting to pause updates. A held-back toolset is automatic, and admins get a "Check again"
  button.
- The live check uses the model the instance already binds for each provider. It never names a
  model (provider-agnostic invariant).
- The manifest is signed with the existing module catalog key and signing code. It carries its own
  `kind: "cli-tools"` field, so a module catalog can never pass as a tool manifest. No new secret
  is needed.

## 4. The tool manifest

### 4.1 Publishing (Moss CI)

New workflow `.github/workflows/cli-tools-manifest.yml`, on `schedule` (every 6 hours) and
`workflow_dispatch`.

1. For each package in each toolset, read the newest stable version from the npm registry.
2. If nothing is newer than the published manifest, exit.
3. For each changed package, generate the lockfile with
   `npm install <pkg>@<version> --package-lock-only --ignore-scripts`. Check that every entry
   carries sha512 and that the per-arch native package names still exist.
4. Run the offline contract check (section 5.1) against the new versions.
5. On a pass, write `cli-tools.json` and the lockfiles. Sign the manifest and upload everything to
   the rolling GitHub release `cli-tools`. The workflow publishes; it opens no PR.
6. On a failure, publish nothing for that toolset. Open or update one GitHub issue titled
   "CLI tool update blocked: <package> <version>" with the failing step. Other toolsets still
   publish.

Manifest shape:

```json
{
  "kind": "cli-tools",
  "formatVersion": 1,
  "issuedAt": "2026-09-25T04:00:00Z",
  "sequence": 42,
  "toolsets": {
    "anthropic": {
      "packages": [
        { "role": "cli", "pkg": "@anthropic-ai/claude-code", "version": "2.1.290",
          "lockfile": "anthropic-cli-2.1.290.json", "lockfileSha256": "..." },
        { "role": "chat-adapter", "pkg": "@agentclientprotocol/claude-agent-acp", "version": "0.76.0",
          "lockfile": "anthropic-adapter-0.76.0.json", "lockfileSha256": "..." }
      ],
      "minMossVersion": "..."
    }
  }
}
```

- `sequence` only ever increases. An instance rejects a manifest whose sequence is lower than the
  last one it accepted, so an old signed manifest cannot be replayed to roll tools back.
- `minMossVersion` lets a toolset say it needs a newer Moss, for example when a flag Moss passes
  changed. An older instance skips that toolset and shows "Needs a newer Moss" (section 8).
- The binary name, per-arch packages and self-update switch stay in the image's catalog. The
  manifest only moves versions and lockfiles. A package change that needs new install logic
  therefore needs a Moss release, and `minMossVersion` expresses that.
- The self-update switch is re-read in step 4. If the env var or config key the catalog sets no
  longer appears in the new build, the toolset is blocked.

### 4.2 Fetching (each instance)

- An API job `ai.cli-tools-refresh` runs on API start and every 6 hours. Its payload is metadata
  only (a trigger reason).
- It downloads `cli-tools.json` and verifies the signature, `kind` and `sequence`. It then
  downloads each changed lockfile and checks its sha256 against the manifest.
- For each toolset newer than the live one, it asks the runner to stage a candidate (section 6).
- A fetch or verify failure changes nothing. The instance keeps its current tools. After three
  days without a successful fetch the provider card says "Can't check for updates".
- The fetch URL is fixed in code, with no setting (no hand-edited settings, per Ben's
  2026-09-01 ruling).

## 5. Checks

### 5.1 Offline contract check (manifest workflow)

Runs without any provider sign-in.

- Install each package through the real `InstallService.installProvider` into a scratch tools
  folder. Assert state `installed`, that `--version` matches, and that the sha512 re-verify passes.
- Build every command Moss launches (one-shot, structured, terminal, model list) with the real
  builders the engines in `packages/chat/src/live/` use (for example
  `structured-claude-engine.ts` and `claude-persistent-runtime.ts`). Run each tool's `--help` and
  assert every flag Moss passes still exists.
- Start each chat adapter through the real adapter resolver and complete the ACP `initialize`
  handshake. Assert the protocol version and capabilities Moss relies on.
- Keep the existing guard that rejects `--tools` alongside the MCP trio.

This check catches removed or renamed flags and install breaks. It cannot catch a flag whose
meaning changed, which is how the `--tools` break happened. Only the live check catches that.

The checks run against the latest `main` build. Section 4.1's `minMossVersion` covers older
releases that the new toolset breaks.

### 5.2 Live check (each instance)

Two calls per provider, both through the real API, runner and tool gateway:

1. **Chat turn with a Moss tool.** Start an ACP chat through the candidate chat adapter, with the
   Moss tool server attached. Ask the model to call one harmless read-only tool that reads no
   private data (the app map tool, `app.getMapSlice`, exposed to the CLI as
   `mcp__jarvis__app_getMapSlice`). Pass when the gateway records that tool call under the check's
   request id. The model's words are not checked.
2. **Background structured call.** Call `generateStructured` through the candidate CLI with a
   one-field schema (for example "return `{ "sum": 4 }` for 2 + 2"). Pass when a schema-valid
   object comes back. Record how many attempts it took, so format drift shows up before it turns
   into failures.

Each call has a 90 second timeout. A timeout counts as a failure.

## 6. The instance gate

### 6.1 Staging, checking and switching

1. The runner installs the candidate toolset into new `releases/<rand>` folders, one per package,
   through the normal install path. The install uses the manifest's lockfile in place of the
   committed one and runs the same verify steps. It does **not** flip `current`, so users keep the
   old toolset.
2. The runner records state in `providers/<p>/state.json` on the tools volume:
   `{ live: [{ pkg, version, sha512 }], candidate: [...], lastCheck: { at, result, reason }, manifestSequence }`.
3. An API job `ai.cli-version-check` runs the live check (section 5.2) against the candidate. Its
   payload is provider kind and candidate versions only. The runner gains a launch option that
   points one check session at the candidate releases. Only this job can set it.
4. On a pass, the runner flips `current` for every package in the toolset, re-verifies hashes, and
   deletes all but the new and the previous release.
5. On a failure, `current` stays on the old toolset. The candidate folders are kept for the next
   try, and the admins are alerted (section 7).
6. A rejected candidate is retried once a day, when a newer manifest arrives, and when an admin
   presses "Check again". It is not retried on every boot.
7. With no previous release (a fresh install), the candidate goes live straight away, because
   there is nothing to fall back to. A failed check still alerts.

GC keeps the previous release until the next successful promote, so a manual rollback is always a
single symlink flip per package.

At boot the runner re-hashes each live release against `state.json` before serving. A mismatch
refuses that provider, as today.

### 6.2 Boot reconcile with the image floor

`reconcileInstalledProviders` changes to "install the floor only if live is older than the floor".

- If the live version is newer than the image pin and hash-matches `state.json`, the runner keeps
  it. It does not downgrade to the image pin.
- If the live version is older than the image pin, the image pin is staged as a candidate and
  goes through the same live check.

### 6.3 Who the check runs as

The check runs as the instance owner, in the owner's per-user slot. That user holds the provider
connection. The Claude token is instance-level. The Codex connection is per-user until #2687
lands, so for Codex the check runs as whichever admin holds the Codex sign-in.

The check conversation is ephemeral. It is never saved to chat history, memory or the vault, and
it does not appear in the owner's conversation list. The only Moss tool it calls reads the app map.

### 6.4 "Too old for this model" becomes a named error

The one-shot, structured and ACP engines match the provider's "version X or newer is required"
message, on stdout or stderr. They raise a named error, `cli_version_too_old`, with no model output
attached. The user sees it in plain words (section 8.3). The error also queues an immediate
`ai.cli-tools-refresh`.

## 7. Alerting

On a failed check, a held-back candidate, a `cli_version_too_old` error, or three days without a
manifest, Moss:

- sends a push notification to each instance admin through the notifications module's public API.
  The notification says which tool, which version, and what failed, in plain words. At most one is
  sent per toolset and version per day.
- writes an audit record in "Audit & operations".
- shows the notice on the provider card (section 8).
- writes a health record that #2683's daily check can read.

For the Moss maintainers, a blocked toolset in the manifest workflow opens or updates one GitHub
issue per package version.

## 8. What the admin sees

Only one screen changes: the provider card on **Settings > AI providers**
(`/settings?section=aiproviders`). No new screen is added.

### 8.1 Mockups

Today's card line reads "Claude CLI". It gains the running version and the last check. The version
shown is the toolset's CLI version.

Up to date:

```
+-------------------------------------------------------------------------+
| [C]  Claude   (o Connected) (o Default)             [Log in] [Terminal] |
|      >_ Claude CLI 2.1.282 - up to date, checked today at 04:10         |
|      Chat checks this sign-in when the ACP adapter initializes.         |
|  ...models list unchanged...                                            |
+-------------------------------------------------------------------------+
```

Trying a new version (candidate staged, check running):

```
+-------------------------------------------------------------------------+
| [C]  Claude   (o Connected) (o Default)             [Log in] [Terminal] |
|      >_ Claude CLI 2.1.282 - trying 2.1.290 now                         |
|  ...                                                                    |
+-------------------------------------------------------------------------+
```

Held back (the check failed):

```
+-------------------------------------------------------------------------+
| [C]  Claude   (o Connected) (o Default)             [Log in] [Terminal] |
|      >_ Claude CLI 2.1.282 - checked today at 04:10                     |
|  +-------------------------------------------------------------------+  |
|  | ! Update held back. Claude CLI 2.1.290 could not use Moss's       |  |
|  |   tools in a test chat, so Moss kept 2.1.282. Moss tries again    |  |
|  |   tomorrow.                                        [Check again]  |  |
|  +-------------------------------------------------------------------+  |
|  ...                                                                    |
+-------------------------------------------------------------------------+
```

Needs a newer Moss, or can't check:

```
+-------------------------------------------------------------------------+
| [C]  Claude   (o Connected) (o Default)             [Log in] [Terminal] |
|      >_ Claude CLI 2.1.282 - checked today at 04:10                     |
|  +-------------------------------------------------------------------+  |
|  | i Claude CLI 2.1.300 needs a newer version of Moss. Upgrade Moss  |  |
|  |   to use it.                                                      |  |
|  +-------------------------------------------------------------------+  |
+-------------------------------------------------------------------------+

   ...or, when the manifest has been unreachable for three days:

|  | ! Can't check for updates. Moss has not reached its update list  |  |
|  |   since 22 Sep. Claude CLI 2.1.282 is still running.             |  |
|  |                                                    [Check again]  |  |
```

Rules:

- The notice uses the existing card callout styling and `jds-*` primitives. It invents no new
  components (the design-system skill applies at build).
- "Check again" queues `ai.cli-tools-refresh` and then `ai.cli-version-check` for that provider. It
  shows "Checking..." until they finish.
- Failure reasons in the notice come from a fixed list, never raw tool output. The list is "could
  not use Moss's tools in a test chat", "did not return usable answers to a background request",
  "did not answer in time", and "could not be installed".
- The OpenCode card gets the same version line and notices.

### 8.2 API

`AiProviderConfigDto` (`packages/shared/src/ai-types.ts`) gains an optional `cliTools` block:
`{ version, candidateVersion?, lastCheckedAt?, state: "current" | "checking" | "held_back" | "needs_newer_moss" | "cannot_check" | "not_installed", reason? }`.
`reason` is one of the fixed codes above. A new admin-only route,
`POST /api/ai/providers/:id/cli-check`, queues the jobs. Both are declared in the `ai` manifest.

### 8.3 App map entries

In the same PR as the screen change:

- `aiproviders` description in `packages/shared/src/app-map-core.ts`: add the version line, the
  four states, and the "Check again" button.
- Errors with remediations:
  - `cli_version_too_old`, shown to users as "The installed AI tool is too old for this model.
    Moss updates it automatically; an admin can check Settings > AI providers." The remediation
    tells an admin to press Check again.
  - `cli_update_held_back`, with the remediation "Moss keeps the older version and retries daily;
    press Check again after the provider fixes its tool."
  - `cli_update_needs_newer_moss`, with the remediation "Upgrade Moss."
  - `cli_update_cannot_check`, with the remediation "Check the instance can reach github.com, then
    press Check again."

## 9. Security

- The manifest is Ed25519-signed with the module catalog key, and verified against the key the
  image already trusts. Lockfiles are bound to the manifest by sha256, and packages are bound to
  lockfiles by sha512 through `npm ci`. An instance installs only exact versions whose bytes match.
- `sequence` blocks replaying an old manifest.
- Job payloads carry provider kind, version strings and trigger reasons only. They never carry
  prompts, tool output or credentials.
- Check transcripts are deleted the same way one-shot transcripts are. No model output is logged,
  only pass or fail, the reason code and the attempt count.
- Every candidate gets the same verify steps and the same self-update switch as a normal install.
- Taking releases the same day (Q2) means a tampered npm release could reach instances before
  anyone notices. The manifest publisher records each package's npm provenance attestation where
  the publisher provides one, and blocks the toolset if a package that used to carry provenance
  arrives without it.
- The signing code lives in `module-registry`. The runner and the publisher must reach it through
  a public export or a shared package, never by importing module internals (module isolation).

## 10. Slice plan

Each slice is one PR with live proof on an isolated instance, per the Live-Path Gate.

| Slice | Scope | Live proof |
|---|---|---|
| 1. See the versions | Runner reports each toolset's versions. `cliTools` on the provider DTO. Card version line. `cli_version_too_old` recognised and shown. App map. | Install Claude CLI 2.1.183 on an isolated instance with a model that needs a newer version. The error shows in plain words and the card shows 2.1.183. |
| 2. Chat adapters on the tools volume | Adapter packages become recipe entries. Runner resolves the adapter from the tools volume with fallback to the image copy. Toolset grouping. | On an isolated instance, chat runs through an adapter installed on the tools volume. Deleting it falls back to the image copy. |
| 3. Manifest publisher | `cli-tools-manifest.yml`, lockfile generation, offline contract check, provenance check, signing, rolling release, issue on failure. | A manual dispatch publishes a signed manifest for a real newer version. A deliberately broken flag blocks that toolset and opens an issue. |
| 4. Instance updater and gate | `ai.cli-tools-refresh`, signature and sequence checks, candidate staging, `state.json`, `ai.cli-version-check`, live check, promote and hold back, image floor, push alert, audit record, card states, Check again, app map. | On an isolated instance, a working candidate promotes. A forced-failure candidate is held back while the old toolset keeps serving, and the admin gets a push. An old-sequence manifest is rejected. |

Slices 2 and 4 depend on 1. Slice 3 is independent. Codex checks for non-owner admins get simpler
after #2687, but no slice depends on it.

## 11. Out of scope

- A per-instance setting to pause updates.
- Rolling back a promoted toolset automatically when live error rates rise later. That belongs to
  #2683.
- Picking models. The check uses whatever model the instance already binds.

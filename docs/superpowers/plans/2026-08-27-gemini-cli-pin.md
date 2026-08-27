# Build plan — #2026 pin the Gemini CLI install recipe

**Issue:** #2026 (`Part of #2026`). **Approved spec:** the `SPEC` comment on issue #2026.
**Branch:** `fleet/lane-2026` off `origin/main`. **Risk tier:** security.

## Scope

Make the `google` provider installable: a pinned, checksummed npm recipe in the catalog, plus the
presence check recognising the binary the package actually ships. Sign-in and chat are explicitly
out of scope (spec section "Explicitly out of scope").

## Seams check — every assumed capability, cited on this branch

| Assumption                                                                       | Citation                                                                                   | Verified |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------- |
| Catalog validates recipes at load and demotes bad ones to `blocked`              | `packages/cli-runner/src/catalog.ts:286-318` (`validateEntry`), `:329-341` (`loadCatalog`) | yes      |
| Lockfile must exist, parse, and carry sha512 on every non-root, non-link entry   | `packages/cli-runner/src/catalog.ts:184-227` (`validateLockfileIntegrity`)                 | yes      |
| `kind:"config"` self-update-disable is written at install, HOME-relative         | `packages/cli-runner/src/install-service.ts:610-618` (`writeSelfUpdateConfig`)             | yes      |
| HOME for installed tools is `/data/cli-auth`                                     | `packages/cli-runner/src/main.ts:68` (`DEFAULT_HOME`)                                      | yes      |
| `archOptionalDeps` demands both per-arch entries when set                        | `packages/cli-runner/src/catalog.ts:239-246`                                               | yes      |
| Presence probe uses only the primary binary name, never the aliases              | `packages/ai/src/cli-availability.ts:78-86` (`cliAvailable`)                               | yes      |
| Aliases exist for `google` but are consulted only for the declared-host contract | `packages/ai/src/cli-availability.ts:29-33`, `:65-69`                                      | yes      |
| `google` is currently `blocked` with the pinning-spike reason                    | `packages/cli-runner/src/catalog.ts:151-158`                                               | yes      |
| No `recipes/google/` folder exists                                               | `packages/cli-runner/recipes/` holds only `anthropic/` and `openai-compatible/`            | yes      |
| Catalog-path test excludes `google` from its no-demotion assertion               | `tests/unit/cli-runner-catalog-path.test.ts:58`                                            | yes      |
| Install test asserts `google` is rejected by the catalog gate                    | `tests/unit/cli-runner-install.test.ts:183`                                                | yes      |

### Facts established against the real published package (not from memory)

Rehearsed outside the repo in `/tmp/gemini-pin` and `/tmp/gemini-stage`:

- `@google/gemini-cli` latest stable exact version is `0.57.0`; `bin` is `{ gemini: "bundle/gemini.js" }`;
  `engines.node` is `>=20` (containers run 24).
- Generated lockfile resolves 13 entries, `lockfileVersion` 3, every non-root entry carries a
  `sha512-` integrity — satisfies `validateLockfileIntegrity`.
- `npm ci --ignore-scripts --no-audit --no-fund` against that lockfile exits 0 and produces
  `node_modules/.bin/gemini`; `gemini --version` prints `0.57.0` and exits 0.
- The package is one bundled JavaScript program split into chunks (95 MB total), **not** a
  per-architecture native binary, and its command works straight out of `npm ci --ignore-scripts`.
  So the recipe must NOT set `archOptionalDeps` — setting it would fail load validation.
- The tool self-updates by spawning `npm install -g @google/gemini-cli@<version>`
  (`bundle/chunk-LQJHQ4BU.js:239-241`). Two settings gate it, both under `general`, both
  defaulting to `true`:
  - `enableAutoUpdateNotification` — checked first in both the update check
    (`bundle/interactiveCli-5O6FZS57.js:31401`) and the handler
    (`bundle/chunk-LQJHQ4BU.js:188`); false returns before anything else happens.
  - `enableAutoUpdate` — false returns before the spawn (`bundle/chunk-LQJHQ4BU.js:208`).
    Both are set false. Deprecated spellings (`disableAutoUpdate`, `disableUpdateNag`) migrate onto
    these two names, so the new names are correct.
- Settings are read from `<HOME>/.gemini/settings.json` unless `GEMINI_CLI_HOME` overrides it.
  `GEMINI_CLI_HOME` appears nowhere in this repo and is not in the sanitized env allowlist, so
  `/data/cli-auth/.gemini/settings.json` is the file the installer must write.

## Design fork the spec left open: the command name

The package only ever produces a command called `gemini`; the rest of the product looks for `agy`.

**Rejected option, steelmanned — catalog only.** Smallest possible diff, keeps `packages/ai`
untouched, and the issue's own wording ("only getting the tool installable") permits it. It is
defensible: the install genuinely succeeds. But `cliAvailable` (`packages/ai/src/cli-availability.ts:82`)
probes only `PROVIDER_BINARY.google` = `agy`, so the installed tool is reported absent forever.
Shipping a feature that is invisible the moment it works is a bug someone else files.

**Chosen — catalog plus presence check.** Extend the PATH probe in `cliAvailable` to try the
primary name and then the aliases already declared for the kind. Existing `agy` behaviour is
untouched (primary name is tried first). Launch and probe code in `packages/chat` is deliberately
left alone — running the tool is sign-in and chat work, out of scope.

## Determinism boundary

Not applicable: no model output, no chat turns, no generated user-facing copy. The only user-facing
surface is the onboarding install list, which renders from the catalog record.

## Tasks

Each task commits green.

### Task 1 — commit the pinned lockfile

- New file `packages/cli-runner/recipes/google/npm-shrinkwrap.json`, generated (not hand-written) by
  `npm install @google/gemini-cli@0.57.0 --package-lock-only --ignore-scripts --no-audit --no-fund`.

### Task 2 — flip the catalog entry to supported

- `packages/cli-runner/src/catalog.ts`: replace the `google` entry.
  Recipe shape (decision, exact values):
  - `kind: "npm"`, `pkg: "@google/gemini-cli"`, `version: "0.57.0"`
  - `lockfile: "packages/cli-runner/recipes/google/npm-shrinkwrap.json"`
  - `binary: "gemini"`
  - no `archOptionalDeps`, no `archBinaryPackage`, no `archBinaryPlacement`
  - `selfUpdateDisable: { kind: "config", path: ".gemini/settings.json", content: <JSON with general.enableAutoUpdate=false and general.enableAutoUpdateNotification=false> }`
- Delete the pinning-spike placeholder comment; add a pin note in the style of the two entries above
  it recording the date, that the version came from the live registry, the self-update mechanism, and
  why there is no per-architecture binary.
- Update the file's opening comment (`:67`) — "claude + codex supported, agy blocked" is no longer true.

Tests (behaviour, and why each fails against a broken implementation):

- `tests/unit/cli-runner-catalog-path.test.ts`: remove the `google` exclusion at `:58` and assert the
  `google` entry loads `supported` with a recipe and records no validation issue. Fails if the
  lockfile is missing, has a gap in sha512 coverage, the version is a range, or `archOptionalDeps`
  is set without per-arch packages — i.e. every way the pin could be fake.

### Task 3 — install path proves the pin and the self-update file

- `tests/unit/cli-runner-install.test.ts`:
  - Rewrite the `:183` case: `google` is now accepted by the catalog gate. Keep a rejection case
    driven by a catalog fixture whose entry is `blocked`, so the gate itself keeps coverage. Fails
    if the gate stops rejecting blocked providers at all.
  - Make the fake command runner provider-aware so it can materialise `node_modules/.bin/gemini`,
    then add: installing `google` runs `npm ci --ignore-scripts`, verifies against `0.57.0`, and
    writes `.gemini/settings.json` under the configured home with both auto-update keys false.
    Fails if the recipe's binary name, version, or self-update config is wrong.

### Task 4 — presence check recognises the shipped command name

- `packages/ai/src/cli-availability.ts`: `cliAvailable` tries `PROVIDER_BINARY[kind]` then
  `PROVIDER_BINARY_ALIASES[kind]` on the PATH probe. Signature unchanged:
  `cliAvailable(providerKind: ProviderKind, deps?: WhichDeps): Promise<boolean>`.
- `tests/unit/ai-cli-availability.test.ts`: `gemini` on the PATH counts as `google`; existing `agy`
  cases keep passing; a kind with no aliases is unaffected.

### Task 5 — release note

- Fill the PR template's Release note section (Category: Added), then run
  `node scripts/append-release-note.mjs --pr <number>` and commit the `docs/WHATS_NEW.md` change.

## Verification — unpiped, expected exit codes

```bash
pnpm vitest run tests/unit/cli-runner-catalog-path.test.ts tests/unit/cli-runner-install.test.ts tests/unit/ai-cli-availability.test.ts > /tmp/2026-unit.log 2>&1; echo "EXIT=$?"   # expect EXIT=0
pnpm format:check > /tmp/2026-fmt.log 2>&1; echo "EXIT=$?"                                        # expect EXIT=0
pnpm lint > /tmp/2026-lint.log 2>&1; echo "EXIT=$?"                                               # expect EXIT=0
pnpm typecheck > /tmp/2026-tsc.log 2>&1; echo "EXIT=$?"                                           # expect EXIT=0
```

Full gate runs through the `verify-gate` skill only — never `pnpm verify:foundation` directly, and
never piped.

## Live-path proof

User-facing: the Google provider becomes offerable in onboarding, driven by the catalog's supported
set. Proof is the install exercised through the real UI on a live dev instance, posted as a PR
comment whose first line is exactly `LIVE-PATH PROOF`.

## Kill gate

If the generated lockfile ever fails the load-time integrity check, or the installed `gemini`
cannot report version `0.57.0` from a `--ignore-scripts` install, the pin is not real and the entry
must stay `blocked`. Both were rehearsed against the live registry before this plan was written and
both passed; a failure at build time ends the line rather than being worked around. Owner: this lane,
escalating through the lane's task record.

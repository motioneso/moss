# Plan: CLI tools instance updater and gate (#2689 slice 4)

Spec: `docs/superpowers/specs/2026-09-25-cli-tools-auto-update.md` sections 4.2, 6, 7, 8, 9, 10.
Key rotation: `docs/superpowers/plans/2026-09-30-signing-key-replacement.md` sections 2 and 3 (issue #2832).
Task issue: #2689. Risk tier: security (signature check, keyring). Ben signs the merge.
Branch `feat/2689-slice4-updater`. Do not merge before #2832 has merged.

## 1. Seams check (verified on this branch)

| Assumption                                                         | Evidence                                                                                                                                                                               |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install stages, verifies, then promotes and flips `current`        | `packages/cli-runner/src/install-service.ts:513-549` (`promoteNpm`), `:380-408` (verify), `:551-565` (rollback, `gcOldReleases`)                                                       |
| No state file, lease or candidate concept exists                   | grep of `packages/cli-runner/src` finds none                                                                                                                                           |
| Boot sweep deletes every release `current` does not point at       | `install-service.ts:707-745` (`startupSweep`); must learn candidates, previous and leases                                                                                              |
| Lockfile comes from the repo                                       | `install-service.ts:340-346` (`installNpm`), `:285` (`ensureAdapter`); needs a bytes override                                                                                          |
| Idempotent no-op compares the pinned recipe version                | `install-service.ts:251` (`tryIdempotentNoop`); needs "live newer than floor" rule (spec 6.2)                                                                                          |
| Runner request methods are a string union plus a dispatch switch   | `packages/chat/src/live/rpc-contract.ts:170-190`, `packages/cli-runner/src/connection.ts:487-500`, `packages/chat/src/live/chat-engine-rpc-client.ts:269,459`                          |
| Version reader exists from slice 1                                 | `packages/ai/src/cli-tool-versions.ts:21-37`, wired at `packages/module-registry/src/index.ts:2033,3501`                                                                               |
| Jobs are declared in the module-registry entry, not the manifest   | `packages/module-registry/src/index.ts:2022,2119`; example `packages/ai/src/jobs.ts:9-33`                                                                                              |
| Job enqueue goes through `sendJob`, with an enumerated send list   | `packages/jobs/src/pg-boss.ts:86,174-183`, `module-jobs.ts:123-127`                                                                                                                    |
| Notification create is recipient-scoped, `eventKey` dedupes        | `packages/notifications/src/repository.ts:225,271`; `@moss/ai` does not import it, so a port is injected                                                                               |
| Audit write exists                                                 | `packages/ai/src/repository.ts:2274-2295` (`insertActionAuditLog`)                                                                                                                     |
| Signature verify takes the keyring as an argument                  | `packages/module-registry/src/distribution/catalog-signing.ts:55-95` (`verifyCatalogBytes(bytes, sig, keys)`), keyring `MODULE_CATALOG_PUBLIC_KEYS` at `:26`, exported by `node.ts:28` |
| Manifest validator lives under `scripts/`, imported by no package  | `scripts/cli-tools-manifest/manifest.ts:48-126`                                                                                                                                        |
| `cli_version_too_old` is recognised; refresh-on-error is not wired | `packages/chat/src/live/cli-version-errors.ts:9-36`; engines `structured-claude-engine.ts:237`, `acp-chat-engine.ts:568`                                                               |
| Admin-only route pattern                                           | `packages/ai/src/routes.ts:1376-1386` (`assertInstanceAdmin`), routes list `packages/ai/src/manifest.ts:275-300`                                                                       |
| Provider card version line and DTO                                 | `apps/web/src/settings/settings-ai-admin-pane.tsx:183,373-375`, `packages/ai/src/routes.ts:1125-1152`, `packages/shared/src/ai-types.ts:51-56`, `ai-api.ts:70,110,416`                 |

Open questions (owner in brackets):

- No admin-broadcast notification API and no health-record writer were found (negative grep). [this plan: add a small injected port for the push, and write the health record as an `app.moss_error_log` row; coordinator to confirm]
- The live check needs an ephemeral chat turn with no saved history. No existing bypass was found. [this plan: build a check-only entry that skips persistence; reviewed in phase 3]
- Job names. Existing jobs are hyphenated (`ai-purge-audit-log`); the spec says `ai.cli-tools-refresh`. [this plan: follow the spec names unless the queue name validator rejects dots]
- Moving the manifest validator out of `scripts/` into a shared package. [this plan: move `manifest.ts` into `packages/module-registry` (public export), keep a re-export in `scripts/` so slice 3 tests stay green]

## 2. Decisions

- **Reader trusts the shipped keyring at run time.** It calls `verifyCatalogBytes` with `MODULE_CATALOG_PUBLIC_KEYS` as built into the image. No key is written into the reader. A manifest signed by a key not in the image fails with `unknown-key` and changes nothing.
- **Sequence.** Last accepted sequence is stored in `state.json` per provider on the tools volume (spec 6.1). A lower or equal sequence is rejected. The sequence is stored only after the candidate is staged.
- **Manifest URL fixed in code.** No setting, no env var.
- **Runner holds the state.** New file `packages/cli-runner/src/tools-state.ts` owns `providers/<p>/state.json` (atomic write, schema-checked on read) and `tools-leases.ts` owns lease files and the cleanup rule (spec 6.5).
- **New runner requests** (union, switch, client, engine host): `stageCliCandidate`, `promoteCliCandidate`, `getCliToolsState`, plus a launch option for one check session that points at the candidate releases. Only the check job sets it.
- **Install path changes.** `installNpm` takes an optional lockfile bytes override and a `stageOnly` flag that renames into `releases/<rand>` and stops before the flip. `promoteCandidate` flips and re-hashes. `startupSweep` and `gcOldReleases` call one shared `releaseIsKept(...)` that applies the four-point cleanup rule.
- **Pin at spawn.** Every launch path resolves `current` once to the concrete release folder (spec 6.5 list) and writes a lease before spawn.
- **Alerts.** One function `raiseCliToolAlert(kind, toolset, version, reason)` writes the push (injected port, `eventKey` = toolset+version+day), the audit record and the health row. Reasons come from the fixed list in spec 8.1, never raw tool output.
- **Card.** `AiCliToolsState` gains `checking | held_back | needs_newer_moss | cannot_check`; `AiCliToolsDto` gains `candidateVersion?`, `lastCheckedAt?`, `reason?`. New admin route `POST /api/ai/providers/:id/cli-check` declared in the ai manifest. Existing `jds-badge` tones and a small `jds-btn` only.
- **Determinism boundary.** Card state, badge text, alerts and audit rows render from the stored state record, never from model output. The model has exactly two jobs, both inside the live check: call the app map tool, and return a one-field object. Prompt text for each is under 30 words. The model's words are never read, only the gateway call record and the schema result.
- **Check transcripts** are never saved to chat history, memory or the vault.
- **Security claim to verify before writing it anywhere:** "the tool server seen by the check session carries only the app map tool." Read the code that builds the tool list before stating it in a comment or the PR.

## 3. Phases

The slice is larger than one session. Recommended cut, all in this worktree and one PR (per the slices-share-a-PR ruling), one session each:

| Phase | Scope                                                                                                                                                                                                   | Exit test                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1     | Move validator to a public export. Fetch and verify (`ai.cli-tools-refresh`): signature, kind, sequence, lockfile sha256, `minMossVersion`. Runner state file, stage-only install, `stageCliCandidate`. | Unit tests plus a runner integration test that stages a candidate and leaves `current` put |
| 2     | `ai.cli-version-check`, live check (both calls), promote and hold back, 6.1 retry rules, first-install shortcut, image floor rule (6.2), `cli_version_too_old` queues a refresh (6.4).                  | Integration test: pass promotes, forced failure holds back                                 |
| 3     | Leases, pin-at-spawn, shared cleanup rule, boot sweep change.                                                                                                                                           | Test: a leased release survives promote and boot; a stale lease is removed                 |
| 4     | Alerts (push, audit, health), DTO states, Retry route, card badges, app map, release note, live proof.                                                                                                  | UAT spec on an isolated instance, row added to `uat-trigger-map.tsv`                       |

**Kill gate (owner: coordinator).** After phase 2, if the live check cannot be made to run without saving a chat row or without a real provider sign-in, stop and ask Ben before phase 3. Phase 3 and 4 are not detailed further until phase 2 is observed passing.

## 4. Tests (behaviour, and why each fails on a broken build)

- Reader rejects a manifest signed by an unpinned key, a wrong `kind`, a lower sequence, a lockfile whose sha256 differs. Each is run against a build with that check removed and must fail there.
- Reader accepts a manifest signed by the second pinned key when both are in the ring. Fails if a key is hardcoded.
- A candidate stage leaves `current` unchanged and survives `startupSweep`. Fails if the sweep is unchanged.
- A failed live check leaves `current` on the old toolset and sends exactly one alert per toolset, version and day. Fails if the alert is not deduped.
- An old-sequence manifest changes no state.
- A leased release is not deleted; a lease with a mismatched start time is treated as stale.
- Card shows each of the five states from the state record only (web test), and the app map test lists the new states and errors.

## 5. Verification commands (never piped)

```bash
pnpm format:check > /tmp/s4-fmt.log 2>&1; echo "EXIT=$?"     # expect 0
pnpm lint > /tmp/s4-lint.log 2>&1; echo "EXIT=$?"            # expect 0
pnpm typecheck > /tmp/s4-tc.log 2>&1; echo "EXIT=$?"         # expect 0
```

Gate runs go through the `verify-gate` skill only, and only after the coordinator says the box is clear. Live proof runs on an isolated instance on a free port, never :1533.

## 6. Out of scope

Publishing, the signing key swap (#2832), per-conversation release pinning, a Codex check for non-owner admins beyond the admin who holds the sign-in.

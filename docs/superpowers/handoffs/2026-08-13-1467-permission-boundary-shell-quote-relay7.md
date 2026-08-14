# Relay 7 — #1467 permission-boundary-shell-quote

**Status: PR #1610 still open, code/tests unchanged (51/51 unit tests green, unchanged since
relay5). Live-path proof STILL NOT EXECUTED. This relay fully de-risked the mechanism — found the
exact injection point, the exact hook decision logic, the exact API surface, and confirmed every
provisioner function the driver script needs is already exported — but ran out of context budget
before writing/running the driver script itself. No git commits by this relay other than this
handoff. No docker containers were started.**

## What's now confirmed (new this relay, not in relay6's handoff)

**The permission-hook decision logic** (`packages/chat/src/live/claude-permission-hook.ts:218-256`,
the `main()` function inside `CLAUDE_PERMISSION_HOOK_SOURCE`) is the ground truth for what "a
permission card appeared" means:

- `safeVaultRead(tool, input)` (line 153) checks the tool is `Read`/`Glob`/`Grep` AND the target
  path is under one of `roots()` (parsed from `JARVIS_NOTES_ROOTS`, comma-split, `validRoot`-
  filtered). If it matches: `decide("allow", "pre-approved read-only vault path")` — **instant,
  no network call, no card.**
- Otherwise the hook POSTs to the permission gateway and the comment at line 256 is explicit:
  `"user decision via action_request card"` — this is the SAME `action_request`/`action_result`
  mechanism as module-action approval cards (`packages/chat/src/live/types.ts:5-40`,
  `ActionRequestPreview` from `@moss/module-sdk`). Gateway timeout is
  `INTERNAL_DEADLINE_MS = JARVIS_PERM_DEADLINE_S ?? 150` seconds (line 105) — in an unattended UAT
  run nobody can click the card, so this path either hangs ~150s then denies, or errors.

**`JARVIS_NOTES_ROOTS` is read via `resolveMossEnv` (`packages/db/src/env.ts:86`)**, so setting
`MOSS_NOTES_ROOTS` in the container env is the correct and sufficient injection (confirms relay6's
plan; `resolveVaultRoots()` in `packages/chat/src/live/vault-allowlist.ts:18` is the call site).

**Proof signal to assert** (relay6 flagged this as unresolved — now resolved):
1. `POST /api/chat/turn` returns `{ reply, userMessageId, assistantMessageId, sourceFreshness }`
   synchronously (`packages/chat/src/live-routes.ts:161-179`). Round-trip time itself is evidence:
   a card-gated read cannot complete in a few seconds in an unattended run (nothing answers the
   card), so a fast reply already rules out the card path.
2. For a second, independent signal: `GET /api/chat/threads/:id/messages` (registered in
   `packages/chat/src/routes.ts` around line 433/463-467, NOT in live-routes.ts) returns
   `{ messages: messages.map(serializeMessage) }`, and `serializeMessage`
   (`packages/chat/src/route-serializers.ts:27-56`) attaches `tools`/`activity` from
   `message.toolMetadata`, built by `readActivity`/`readTools` (same file, lines 63-111).
   `ChatActivityEventDto` entries carry `{ kind, text, toolName?, outcome? }` with
   `outcome: "executed"|"denied"|"error"|"allowed"`. First get the current thread id from
   `GET /api/chat/threads` (`serializeThread`, same routes.ts file, ~line 441), then fetch its
   messages and inspect the assistant message's `activity` array for the Read tool entry: expect
   no `action_request`-kind entry and no `denied` outcome.
3. Combine both: reply contains `proof-1467` AND completes in well under 150s AND (if present)
   activity shows no denied/action_request entry. Any one of these alone is suggestive; together
   they're a solid live-path proof.

## Driver script mechanism — confirmed feasible, not yet written

`tests/uat/provisioner.ts` exports everything the driver needs — no need to reimplement
`provisionForUat` wholesale, and no need to patch `writeUatEnvFile` via monkeypatching (ESM named
exports are read-only bindings, can't be reassigned from outside anyway). Exported and usable
directly:

`generateUatRunId`, `findAvailablePort`, `writeUatEnvFile`, `uatComposeInterpolationEnv`,
`bareSeedHook`, `composeSeedHook`, `buildUatComposeArgs`, `createUatProvisionPlan`,
`assertNoLeakedResources`, `buildSeedHookInput`, `UAT_PORT_RANGE_START`, `UAT_PORT_RANGE_SIZE`,
`writeUatRealChatEnvFile`, `removeJobSearchFixtureContainer`, `restartUatStack`.

**NOT exported** (small, must be reimplemented trivially in the driver, ~20 lines total):
`runCommand` (`tests/uat/provisioner.ts:557`, spawns a command and rejects non-zero exit — read it
directly, it's short) and `waitForReady` (line 586, polls a URL until 200 with a timeout).
`PortBindConflictError` (line 553) is only needed if replicating the port-retry loop; for a
one-shot proof run it's fine to skip the retry loop entirely and just let the run fail loudly on a
port collision (rare — `findAvailablePort` already probes a large range).

**The actual seam** (this is the whole reason not to just call `provisionForUat()` directly):
inside that function, line 729 is `const envFile = writeUatEnvFile({ webPort,
jobSearchFixtureBaseUrl });` immediately followed by `process.env.JARVIS_ENV_FILE = envFile.path`
and then the compose-up plan runs. **The driver must call `writeUatEnvFile()` itself, then
`fs.appendFileSync(envFile.path, "MOSS_NOTES_ROOTS=/tmp/uat-1467-notes\n")`, THEN set
`process.env.JARVIS_ENV_FILE = envFile.path` and proceed with its own copy of the rest of
`provisionForUat`'s body** (port pick, `uatComposeInterpolationEnv`, `createUatProvisionPlan` with
`bareSeedHook` or `composeSeedHook` per the desired `UatSeedLevel`, run each step via a local
`runCommand`, `composeSeedHook`/`buildSeedHookInput` call, `waitForReady` on `/health/ready`,
return `{ baseURL, projectName, teardown }` mirroring lines 780-795 exactly, including
`realChatEnvFile` handling from `writeUatRealChatEnvFile()` since the onboarding sequence needs the
real Anthropic token). Use `level: "solo-admin"` (the real-chat-onboarding spec's own `uatLevel`)
so `signIn()` lands past first-run onboarding correctly (see `uat-spec-gotchas` memory, skip-setup
flow) — `bare` has no seeded admin user.

**Import path**: write the driver in the session scratchpad dir (not `tests/uat/`, per relay6),
run via `npx tsx <scratchpad-path>/driver.ts` from repo root (`cwd` matters — compose args are
relative to repo root per `buildUatComposeArgs`). Import provisioner exports with an **absolute
`file://` URL specifier** (Node ESM supports this) resolved from the worktree path under
`~/Jarv1s/.claude/worktrees/coord-overnight-20260810/.claude/worktrees/1467-permission-boundary-shell-quote/tests/uat/provisioner.ts`
— this avoids fragile relative-path math from an out-of-repo scratchpad location. Not yet tried; if
`file://` + `.ts` extension resolution fails under this repo's tsx/ESM config, fall back to a
relative import and place the driver one level above `tests/uat/` inside the repo (e.g.
`tests/.scratch-1467-driver.ts`, still outside `tests/uat/` itself) — untracked, never `git add`.

## Concrete next steps for relay8

1. Write the driver script (mechanism above). Budget real time: docker image build alone can take
   several minutes — run it via `Bash` `run_in_background` or `Monitor`, never poll inline, per
   box-wide CLAUDE.md.
2. In the driver, after the stack reports `/health/ready`: `docker exec <api-container>
   mkdir -p /tmp/uat-1467-notes && echo proof-1467 > /tmp/uat-1467-notes/proof.txt` (container name
   derivable from `projectName` + compose service name — check `buildUatComposeArgs`/compose file
   for the exact service name, likely `app` or `jarv1s`, not yet confirmed this relay).
3. Drive the sequence copied from `tests/uat/specs/real-chat-onboarding.uat.spec.ts` (signIn →
   provider-install → provider-login/begin → poll `/api/ai/models` → `POST /api/chat/turn` asking
   to read `/tmp/uat-1467-notes/proof.txt`). Use Playwright's `request` context directly (no need
   to spin up a full browser `page` for signIn if a lighter cookie-jar approach works — but the
   spec's `signIn()` needs a `page` for the login form, so keep using `@playwright/test`'s `page`
   fixture via a throwaway `.uat.spec.ts`-shaped test file run through the normal
   `playwright.uat.config.ts`, OR write the driver as its own ad hoc Playwright test file outside
   `tests/uat/specs/` and point `npx playwright test --config=tests/uat/playwright.uat.config.ts
   <path>` at it directly — simplest option, reuses all existing Playwright config/JARVIS_UAT_BASE_URL
   wiring from `run-uat.ts`'s pattern).
4. Assert per the "Proof signal to assert" section above.
5. Teardown (`teardownCompose` + `assertNoLeakedResources` + both env file cleanups), then record
   the proof as a `gh pr comment` on #1610: exact commands, exit codes, the concrete pass/fail
   observation (reply text presence, round-trip ms, activity outcome if fetched) — no screenshots
   (banned post-`2852a12c3`).
6. Full gate via `verify-gate` skill (isolated gate DB).
7. Security tier: adversarial cross-model QA (AGY, not Fable, not gemini-cli) + Ben's explicit
   merge sign-off.
8. On merge, `coordinated-wrap-up`: comment on #1467 + update project board (project 2).

## Fallback (unchanged from relay6, still available if the container proof proves too costly)

Cite the existing unit test ("omits JARVIS_NOTES_ROOTS ... when no root is configured") plus a
narrow direct proof of `vaultRootsEnvEntry()`/the hook-writer emitting `JARVIS_NOTES_ROOTS=<roots>`
with `MOSS_NOTES_ROOTS` set vs. absent. **Not a live-UI proof** — flag the gap explicitly in the PR
comment, AWAITING-BEN entry + `needs-ben` ping, get Ben's explicit sign-off before merging on this
alone.

## Traps (carried over, unchanged)

- `Moss`/prod container on :1533 and the prod `cli-runner` process — never touch.
- Ports 5173/5197 held by other worktrees; :3000/:5199 were free as of relay6, not re-checked.
- Commit by explicit path only (shared checkout); `git show --name-only HEAD` after each commit.
- If `herdr agent start` (self-spawn) is denied, don't retry — message Coordinator to spawn
  instead.
- `tests/uat/specs/real-chat-onboarding.uat.spec.ts` is a template for provider bootstrap only —
  do not run it directly expecting it to prove #1467.
- `real-chat-onboarding`/similar specs must call `/api/onboarding/provider-install` BEFORE
  `provider-login/begin`, or `begin` wrongly reports `awaiting_token`
  (`uat-real-chat-onboarding-cli-tools-missing` memory).

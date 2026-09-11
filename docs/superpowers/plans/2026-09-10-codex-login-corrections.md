# PR #2456 — four-task correction plan

Status: approved by Ben through PM. This document is the committed plan; implementation follows the task order below. The initial Task 1 implementation preceded this required plan commit; this correction records and closes that sequencing miss.
Baseline: rejected commit `95b14ee00b6e02996598e76b0e03e2ec65e1e77c`; earlier accepted PATH task `4c33c97c1c7eb4e52143e27408bb336d5e767e3a`.
Worktree: `~/Jarv1s/.claude/worktrees/build-prod-cli-recovery`.
Paths below are relative to that worktree.

## Authority and execution order

Read the merged plan and standards from `origin/main` at `dcc42b6722d8a46849e8a01728b1c42e0b0973f8`, including task 5b items 10 and 13–18. The current correction is Codex account login; it does not migrate Anthropic or Google login storage. Anthropic's existing token remains in the launcher-owned store and is passed only to Anthropic agents. ACP agents still run in isolated user homes.

This plan is committed in this PR before implementation resumes. Do not overwrite another agent's working changes. Builder reconciles its own pending edits with this plan; PM handles any conflict in scope.

Four implementation tasks, four commits on this PR. Order: 1, 2, 3, 4. For each: Builder pushes one task, checks settle, Reviewer reviews, Builder corrects any findings in that task, PM confirms, then the next task starts. PM must not request a batch review. Final live proof remains a separate pre-merge gate, with Ben as the designated live confirmer. No deployment work is authorized by this plan.

## Task 1 — validate Codex credentials after the owner switch

Files: `packages/cli-runner/src/acp-host.ts`, `acp-codex-auth.ts`, `agent-home-prepare.mjs`; `tests/unit/cli-runner-acp-credentials.test.ts` and `tests/unit/cli-runner-acp-host.test.ts`.

1. Remove the call to `preflightCodexAuthFile` from `AcpHost.spawn`. Remove that export and its implementation if no production caller remains; replace tests of that obsolete preflight with tests of the actual preparation path. Keep `codexAuthPath` and any credential-reader export with a real caller.
2. Keep `ensureOwnedTopLevel` as the launcher-side check: real directory, expected UID/GID, owner-only permissions. Do not descend into the user's directory as launcher, change its ownership to read it, loosen its mode, or add a capability.
3. Retain the existing `defaultRunAgentHomePrepare` -> `buildSetprivDropCommand` -> `agent-home-prepare.mjs` path. The owner process validates the source credential before other preparation changes. The source and destination are the same user's `.codex/auth.json`; do not copy from the shared home.
4. Retain component-by-component symlink rejection, `O_NOFOLLOW`, regular-file validation, and owner-only credential permissions. A failed preparation prevents agent spawn and preserves pre-existing data. Task 4 supplies the final missing/malformed error classification.

Acceptance: with synthetic valid credentials owned by UID/GID 100001 under a 0700 home, launcher UID1000 with only CHOWN/SETUID/SETGID reaches successful owner preparation. A second launch works without changing ownership. A missing owner login does not reuse a synthetic shared login. Wrong owner, symlinked parent/file and inaccessible owner credential prevent agent spawn; linked targets and existing homes remain intact.

Test the real preparation executable and actual host wiring. Mocking the preparation function alone is insufficient. Add the production-identity cases to the shared diagnostic named below; ordinary unit cases remain in the two existing test files.

## Task 2 — bind Codex probes and re-login verification to that same account

Files: `packages/cli-runner/src/main.ts`, `login-service.ts` (runtime type only), `engine-host.ts`, `acp-codex-auth.ts`, `model-list-adapters.ts`; tests `cli-runner-per-user-login.test.ts`, `cli-runner-model-list.test.ts`, `module-build-cli-engine-probe-security.test.ts`.

1. In `resolveUserRuntime`, construct the owner command environment with `buildCliRunnerChildEnv({ homeBase: agentHome })`. This sets HOME, JARVIS_CLI_HOME and JARVIS_CLI_HOME_BASE consistently and retains the sanitized tools PATH. Never use bare `process.env` as the owner runtime's environment.
2. Build the owner runtime's `run` using the existing `buildSetprivDropCommand` and a sanitized base I/O object without Node UID/GID spawn options. Each command switches numerically to the slot, clears supplementary groups and inheritable/ambient capabilities. Do not alter the general `runner-io.ts` implementation. Login/probe commands in this task require no owner-directory `cwd` before the switch.
3. The forced verification callback also needs owner filesystem access: `model-list-adapters.ts:readCodexAuth` currently uses launcher `readFile`, regardless of the supplied I/O. Add an optional `readCodexAuthFile(path): Promise<string>` dependency to `ModelListAdapterDeps`; its default preserves existing shared model-list callers. The Codex adapter uses this reader before its existing parse and vendor request.
4. Supply that dependency from the isolated runtime at BOTH verification call sites: the LoginService probe closure in `main.ts` and `CliChatEngineHost.verifyProviderCredential`. Add an optional `readCodexAuthFile` member to `LoginUserRuntime`; Codex runtime construction must always populate it. An isolated Codex verification with that member missing fails as a configuration error, never silently falling back to a shared read. Non-Codex runtimes omit it.
5. Implement the owner reader in `acp-codex-auth.ts` using the runtime's owner `run` and the current Node executable, with a fixed inline Node script and the expected credential path as a separate argv element. Accept only the path derived from that runtime's user/home. The script checks every path component for symlinks, opens with `O_NOFOLLOW`, checks a regular file, and reads it after the UID switch. Only successful raw file content goes to the captured internal stdout pipe. On failure, emit a fixed non-secret error classification, never exception text containing credential contents. The launcher consumes the result only through the existing model-list parser and vendor HTTP request; it must never log or return the raw command result through RPC. No secret goes in argv or environment. This is an internal credential transport, not a claim that credential bytes never enter runner memory.
6. Keep Codex probe/rejection cache keys scoped to the actor. Vendor acceptance is required to clear a recorded refusal; a file-presence check cannot clear it. Task 3 restores shared cache scope for the unchanged providers.

Acceptance: the actual Codex probe with a synthetic executable observes the correct HOME, UID/GID, empty supplementary groups and zero permitted/effective/inheritable/ambient capabilities. User A's valid login returns ready; user B without one returns needs_login even after A succeeds. A synthetic recorded refusal stays refused until the existing vendor-verification adapter receives a successful mocked response using A's owner-read credential. HTTP 401 remains refused; network/5xx failure does not clear it. Exercise both verification entry points. No actual vendor call or real credential is needed.

Do not expand the general Refresh models feature into per-user storage in this task. Its existing shared behavior must not be described as proving a user's Codex login.

## Task 3 — restore Anthropic and Google login compatibility

Files: `packages/cli-runner/src/login-service.ts`, `main.ts`, `engine-host.ts`; tests `cli-runner-login.test.ts`, `cli-runner-per-user-login.test.ts`.

1. Change the private LoginService runtime resolver to accept provider plus actor. Invoke the injected owner-runtime resolver only for `openai-compatible`. Update every private resolver call to pass `flow.provider` and `flow.userId`.
2. For Anthropic and Google, return the existing shared runtime: configured `homeBase`, `deps.io`, launcher's numeric UID/GID, and the real caller's userId for flow ownership. Their login processes, paste temp file, captured-token store, probes and Google first-run seeding use that shared runtime. The captured Anthropic token remains at `<configured homeBase>/.jarvis/cli-tokens/anthropic`, matching `AcpHost.readLoginToken`.
3. In `CliChatEngineHost.probeProvider` and `recordLoginRejected`, resolve an isolated runtime only for `openai-compatible` with an actor. For Anthropic/Google, retain configured shared home and shared probe/rejection scope. Apply the same provider distinction to the LoginService probe closure in `main.ts`. Keep all caller identity checks on begin, reuse, poll, submit and cancel for every provider.
4. Retain the established launcher-owned tmux socket/session control. Retain argv-free token paste, named-buffer deletion, temp-file cleanup in finally, exact token redaction, and atomic captured-token persistence. Do not introduce owner-home paste helpers or migrate `provider-token-store.ts`.

Acceptance: actual LoginService under the production launcher identity, with mocked tmux and synthetic Anthropic output, reaches paste/capture/persist without EACCES. The captured token exists only at the configured shared token path with 0600 mode and is readable by the existing Anthropic credential reader. Temporary paste files and buffers are removed after success and injected failure. No owner-home token copy is created. Google's seeding receives the shared home. Codex still receives the isolated runtime. These are regression tests with fake providers, not live Anthropic/Google calls.

## Task 4 — classify login failures and make remediation truthful

Files: `packages/cli-runner/src/agent-home-prepare.mjs`, `acp-codex-auth.ts` as needed for its remaining owner reader; `packages/chat/src/live/acp-chat-engine.ts`; `packages/shared/src/app-map-core.ts`; `packages/chat/src/manifest.ts` if its existing auth wording repeats the old claim; tests `cli-runner-acp-credentials.test.ts` and `packages/chat/src/live/acp-chat-engine.test.ts`.

1. In the owner preparation reader, classify ENOENT, invalid JSON syntax, JSON null/non-object, missing tokens, and empty/non-string access_token or account_id as `Not logged in (no usable Codex credential in your runner home)`. Catch JSON parsing locally so its exception cannot echo part of a secret. Preserve operational failures: EACCES/EPERM, symlinks, non-regular files and other I/O errors are hard failures, not a request to reauthenticate. Do not suppress all lstat errors as a missing path.
2. Propagate that fixed login-required message through the existing preparation error and `isAuthRequired` handling. No new wire status or string matching of arbitrary credential contents is needed.
3. Use one shared message helper for launch and prompt auth failures. For Codex, use: `Codex is not signed in for this account. Sign-in is currently available only to administrators in Settings, Assistant & AI, using this same Moss account.` Preserve the existing other-provider remediation. Do not claim missing/malformed credentials are necessarily expired or that another administrator can sign in for this account.
4. Update app-map wording to describe owner-home Codex validation and the current admin-only sign-in surface. Remove the assertion that every user can recover through that surface. Keep provider failures distinct from missing/invalid login. Update the approved correction document and PR release note to match the final scope.

Acceptance: table-driven actual preparation cases cover missing file, `{broken`, `null`, `[]`, `{}`, missing tokens, empty values, valid login, permission denial and both parent/file symlinks. Assert the classifications and absence of synthetic secret fragments in errors. Chat launch and prompt failures use the same truthful Codex remediation. Existing admin gates still reject ordinary-user login requests before any state write or runner call.

## Required checks and report

Builder adds ONE shared executable `scripts/check-codex-login-isolation.ts` for the production-UID regression cases above. It uses only temporary synthetic state, actual production modules and mocked providers/tmux. It must fail if started without the expected disposable-container setup; no skip-as-pass. Reuse the fixture pattern from `/tmp/acp-review-95b-proof.mts`, but reverse its old assertions: that scratch file proves the defects and is not an acceptance test. Do not overwrite the original reviewer evidence.

Run the diagnostic in the locally available Moss image with the source worktree mounted read-only at `/app`; do not pull an image or mount a live data volume. Resolve and record its immutable local image ID first:

```sh
docker image inspect ghcr.io/motioneso/moss:edge --format '{{.Id}}'
```

Then, substituting that reported image ID, run:

```sh
docker run --rm --network none --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add FOWNER --cap-add KILL --security-opt no-new-privileges:true --mount type=bind,src="$PWD",dst=/app,readonly --workdir /app IMAGE_ID node --import tsx scripts/check-codex-login-isolation.ts
```

The harness creates disposable state as container root, then exercises launcher UID1000 with only CHOWN/SETUID/SETGID and owner UID100001 with none. Assert kernel identity/capability sets. Build fixture descendants before ownership handover. No root execution of the operation under test, no live paths, no network, no real tokens. Add each task's cases in that task's commit.

Negative security evidence: give the shared diagnostic two explicit modes, `--negative-cross-user` and `--negative-symlink`. Each uses an in-memory transformed module, never edits working source, and runs the same assertion as its protected case. The first removes the cross-user match condition and must fail the actual foreign-user poll/submit assertion. The second disables the owner-reader component checks and O_NOFOLLOW and must fail the synthetic same-owner symlink rejection assertion. Run the same Docker command above with each flag appended after the script name; record each nonzero exit and failing assertion, then rerun without a flag and require success. The negative modes are deliberate failing checks, not ordinary CI invocation. Credential-isolation claims require the real-UID diagnostic, not just these mutations.

Run each task's named tests with `pnpm vitest run <the exact paths named in that task>` and run its diagnostic once. At the final corrected task run this complete focused set:

```sh
pnpm vitest run tests/unit/cli-runner-acp-credentials.test.ts tests/unit/cli-runner-acp-host.test.ts tests/unit/cli-runner-per-user-login.test.ts tests/unit/cli-runner-login.test.ts tests/unit/cli-runner-model-list.test.ts tests/unit/module-build-cli-engine-probe-security.test.ts tests/unit/onboarding-provider-login-route.test.ts tests/unit/onboarding-provider-login-wiring.test.ts packages/chat/src/live/acp-chat-engine.test.ts packages/chat/src/live/provider-probe.test.ts
pnpm lint
pnpm format:check
pnpm check:file-size
pnpm typecheck
git diff --check 95b14ee
gh pr view 2456 --json headRefOid
gh pr checks 2456
```

These named route tests use fake DB dependencies. Do not run `pnpm verify:foundation` or DB-touching commands without the required verify-gate skill and its isolated target. If unavailable, report full foundation as not run; GitHub results are reported separately by check name and exact commit. Skipped, pending or failed checks are not green.

Boundary-test-gate report must include all five numbered items: 1 subscriber serialization N/A, no changed record delivery; 2 masker corpus N/A if masker unchanged, with the separate identity/symlink mutation evidence reported; 3 notification pass-through N/A, unchanged; 4 record writer counts N/A, unchanged; 5 creation order N/A, unchanged. If Builder changes any of those boundaries, the corresponding skill test becomes mandatory; return the scope question to PM.

Report once per settled task: commit, result, exact commands/exit codes, negative-check failing output, named GitHub checks for that commit, and what was not run. No reviewer approval is implied by this plan.

## Ben decisions and final gate

No new product choice is required for these four corrections; Ben's plan approval is required before execution. Keep current admin-only authorization. Opening a normal-user sign-in surface would change access and remains outside this correction; do not implement it implicitly. Conversation context, merged docs, agentmemory and matching Jarvis vault notes supplied no separate approval for that expansion.

After task 4 passes review and GitHub checks, PM arranges an approved dev deployment and Ben's live proof: administrator signs into Codex using that administrator's own Moss account through the real Settings flow, then receives an assistant response through ordinary chat; repeat after a fresh session. Record installed commit, UI/network assertions and result on the PR. Normal-user recovery remains unavailable and must not be claimed as proven. Until live evidence is recorded, status is code-complete, unverified: no merge clearance.

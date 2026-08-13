# Relay 3: #1325 provider credential picker — live-path UAT proof only

Worktree/branch: `1325-provider-credential-picker` (this worktree, `node_modules` present — do
NOT `pnpm install`). Security-tier lane. Coordinator label: `Coordinator` (herdr).

Tasks 1–3 (implementation, dead-code removal, UAT spec) and the finish-line steps from relay-2
(gate, push, PR) are **done**. This doc covers only what's left: **live-path UAT proof**.

## State as of this doc

- Full isolated gate (`pnpm verify:foundation`, fresh DB `jarvis_gate_1325_provider_credential_picker`
  via `scripts/run-gate.sh start`) ran green end-to-end: 191 test files / 1893 tests passed, 2
  skipped. Log was `/tmp/jarv1s-gate/1325_provider_credential_picker-20260813-001455.log` (gate DB
  auto-dropped on success — gone now, don't look for it).
- Branch pushed: `git push -u origin 1325-provider-credential-picker` — done.
- PR opened: **https://github.com/motioneso/moss/pull/1602**, titled
  `[SECURITY] #1325 Provider picker collects credential before create`. Body already cites both
  Fable-verified points (discovery soft-fail at `packages/ai/src/routes.ts` ~199-214;
  `credentialPayload.apiKey` matches `provider-validation.ts:70`) and the non-blocking Ollama
  fast-follow note. Do not re-open or edit the PR description — it's already correct.
- Repo note: `git push` to the `Jarv1s.git` remote prints a "this repository moved" notice pointing
  at `motioneso/moss` — this is expected/harmless, the push and `gh pr create` both succeeded
  against the right repo (confirmed: PR #1602 is live at motioneso/moss).

## What's left

1. **Live-path UAT proof.** Run the harness (NOT the mock-API root `playwright.config.ts`):
   ```bash
   pnpm test:uat 1270-provider-signin
   ```
   This provisions its own ephemeral real stack (`tests/uat/provisioner.ts`) — you do not need to
   hand-spin a dev instance. Target spec: `tests/uat/specs/1270-provider-signin.uat.spec.ts`, the
   test named `"Settings collects an API key before creating a picker provider (#1325)"` (defined
   at line 247, confirmed present). Run the whole spec file (the filter matches the file, not one
   test inside it) — that's fine, the file's other tests are pre-existing coverage.
   - Background it and wait via `Monitor`, not in-context polling — this can run several minutes
     end-to-end (image build if needed + provision + Playwright run). Log to a file, never pipe:
     `( pnpm test:uat 1270-provider-signin > /tmp/uat-1325.log 2>&1; echo "### FINAL rc=$?" >> /tmp/uat-1325.log ) &`
   - Known UAT traps to expect (see memory `uat-spec-gotchas`, `uat-reload-poll-and-psql-seed-traps`):
     fresh owner lands on onboarding wizard first (spec should already handle this — it's existing,
     passing coverage); `getByLabel`/`getByRole` do substring matching so don't be alarmed by
     unrelated matches in error output; `cliAvailable` is always false in a provisioned stack.
   - If it fails, read `test-results/<spec>-chromium/error-context.md` for the DOM snapshot before
     guessing.

2. **Post proof to the PR** via `gh pr comment 1602 --body "..."`. Include: exact run command,
   exit code, and which assertions passed (test name(s), pass count). **No screenshots** — forbidden
   per `docs/DEVELOPMENT_STANDARDS.md` for this spec class; the playwright UAT config defaults
   screenshots off, don't add `page.screenshot()` calls.

3. **Report to Coordinator** (herdr label `Coordinator`): PR URL (`https://github.com/motioneso/moss/pull/1602`)
   + the UAT evidence summary (same content as the PR comment, condensed).

4. **Do NOT merge, move the board, or close #1325.** Security tier — Ben's sign-off required. This
   is the last step of this lane; once reported, the lane is done from this session's side.

## Do not re-derive

- Design ruling (Option 3: client collects the credential the catalog entry's `authMethod` needs;
  server 400 guard at `routes.ts:759` stays untouched) is Fable-approved — don't re-litigate it.
- Gate is already proven green this session — don't re-run `pnpm verify:foundation` unless new
  commits land after this doc.
- Plan file: `docs/superpowers/plans/2026-08-13-1325-provider-credential-picker.md` — read by
  section only if needed, never in full.

# Relay: #1325 provider credential picker

Worktree/branch: `1325-provider-credential-picker` (this worktree). Security-tier lane.
Coordinator label: `Coordinator` (herdr). Plan: `docs/superpowers/plans/2026-08-13-1325-provider-credential-picker.md` — **Fable-approved, no fork.** Do not re-litigate Option 3 (client collects the credential the catalog entry's authMethod needs; server 400 guard at `packages/ai/src/routes.ts:759` stays untouched).

## Done (commit `0ea78c56e`)
- `tests/unit/settings-ai-admin-pane.test.tsx` rewritten: 4 new tests under `describe("AiProvidersPane provider picker (#1325)")` + original #1182 test preserved in its own describe block.
- Full `vi.mock` coverage for `client.js` and (separately) `client-admin.js` — needed because `AiProvidersPane` always renders `VoiceConfigGroup`/`ChatLockGroup`/`YoloAdminGroup`/`WebSearchKeyGroup` siblings.
- Confirmed clean **TDD RED**: 2/5 fail for the intended reason (`createAiProvider` fires immediately for an `api_key` entry with no `credentialPayload`; no "API key" field appears). 3/5 already pass unmodified (cli-immediate-create, disables-Add, #1182).

## Next: Task 1 implementation (in_progress, TaskList #1)
Edit `apps/web/src/settings/settings-ai-admin-pane.tsx`:
- Add `credentialFor`/`pickBaseUrl`/`pickApiKey` state near the picker grid (~line 763).
- Picker grid `onClick` (lines 763-789) branches on `option.authMethod`: `cli` → `createMutation.mutate({ option, baseUrl: "", apiKey: "" })` immediately (unchanged behavior); `api_key` → `setCredentialFor(option)` (opens inline form, no create yet).
- `createMutation` (lines 587-600) `mutationFn` signature becomes `{ option, baseUrl, apiKey }`; body conditionally spreads `credentialPayload: { apiKey }` only when `apiKey` is non-empty, and `baseUrl` only when non-empty — **cli path must send no `credentialPayload` key at all** (test 4 asserts `"credentialPayload" in sent === false`).
- Inline credential form: reuse `Field`/`.jds-input`/`Button` pattern already used in the Edit pane (lines 331-366) — `aria-label="Base URL"` and `aria-label="API key"` inputs, an "Add" button (`disabled` while `apiKey.trim()` is empty) and a "Cancel" button that clears `credentialFor`.
- Re-run: `pnpm exec vitest run tests/unit/settings-ai-admin-pane.test.tsx > /tmp/t1-green.log 2>&1; echo "EXIT=$?"` — expect `EXIT=0`, 5/5 pass.
- Commit (explicit path only: the `.tsx` file), TDD-green, `Co-Authored-By: Claude` trailer.

## Then: Task 2 (pending, TaskList #2)
`ProviderCard`'s `.prov__auth` block (lines ~234-245 pre-edit — recheck after Task 1 lands): collapse the `hasCredential ? "API key stored" : "No credential"` ternary to unconditional `"API key stored"` for non-cli providers (`hasCredential` is always true — `NOT NULL` column). Verify: `grep -n "No credential" apps/web/src/settings/settings-ai-admin-pane.tsx; echo "EXIT=$?"` expect `EXIT=1` (no match).

## Then: Task 3 (pending, TaskList #3)
Add a real API-key picker-flow UAT test to `tests/uat/specs/1270-provider-signin.uat.spec.ts`, replacing the `DELIBERATELY NOT COVERED` comment block (~lines 120-130), using existing helpers (`signIn`, `skipOnboarding`, `openAssistantAndAiSettings`, `addProviderFromPicker`, `providerCard`). Add a row to `.claude/skills/coordinate/uat-trigger-map.tsv` mapping the changed picker file to this spec.

## Rulings ledger additions already in the plan file (do not re-derive)
- Fable-verified: create route soft-fails discovery (`routes.ts` ~199-214, try/catch) — fake-key UAT create genuinely succeeds and the card renders.
- Fable-verified: `credentialPayload.apiKey` matches server reader (`provider-validation.ts:70`) and existing Edit-pane shape.
- Fast-follow (non-blocking, do NOT fix in this pass): "Local (Ollama)" is catalogued `authMethod: "api_key"`, forcing a dummy key even though Ollama ignores auth headers — pre-existing modeling, consistent with the one-credential-shape ruling.

## Before every push
```
pnpm format:check && pnpm lint && pnpm typecheck
git fetch origin main && git rebase origin/main
```

## Finish line
`coordinated-wrap-up`: isolated-gate-DB run (`verify-gate` skill, never improvised), push, PR tagged `[SECURITY]`, live-path proof via `gh pr comment` (UAT run link + exit code + assertions — screenshots forbidden by current `docs/DEVELOPMENT_STANDARDS.md`), cite the two Fable-verified facts in the PR body. Report PR + evidence to `Coordinator`. Do not merge, move the board, or close #1325 — Ben's sign-off required (security tier).

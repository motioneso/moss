# Relay 2: #1325 provider credential picker — finish line only

Worktree/branch: `1325-provider-credential-picker` (this worktree, `node_modules` present — do
NOT `pnpm install`). Security-tier lane. Coordinator label: `Coordinator` (herdr).

Tasks 1–3 (implementation, dead-code removal, UAT spec + trigger-map row) are **done**. This doc
covers only what's left: **finish line** per `coordinated-wrap-up`.

## Commits on this branch (rebased onto origin/main @ 198928da4)
```
43e7091d0 style(#1325): prettier formatting fix for plan doc
85a120330 style(#1325): prettier formatting fix
764bac33f test(#1325): live-path UAT coverage for the API-key picker flow
8b7c2a12b fix(#1325): drop dead "No credential" ternary branch
b42f83b1a feat(#1325): provider picker collects credential before create
9ed24e3f5 docs(#1325): relay continuation doc
cca8e5d87 test(#1325): RED — provider picker must collect credential before create
```
Working tree clean, 7 commits ahead of origin/main. Unit tests green (5/5), lint/typecheck green,
rebase already done — do not redo any of that.

## What's left

1. **Re-run the isolated gate** (`verify-gate` skill, DROP+CREATE fresh — never reuse):
   ```bash
   GATEDB=jarvis_gate_1325picker
   docker exec jarv1s-postgres psql -U postgres -c "DROP DATABASE IF EXISTS $GATEDB;"
   docker exec jarv1s-postgres psql -U postgres -c "CREATE DATABASE $GATEDB;"
   export JARVIS_PGDATABASE=$GATEDB
   ( pnpm verify:foundation > /tmp/vf-1325.log 2>&1; echo "### FINAL rc=$?" >> /tmp/vf-1325.log ) &
   ```
   Wait via `Monitor`, not in-context polling. First attempt failed (`rc=1`) at `format:check` on
   `docs/superpowers/plans/2026-08-13-1325-provider-credential-picker.md` (pre-existing from
   `0ea78c56e`, unrelated to code) — fixed and committed at `43e7091d0`. Downstream steps
   (check:file-size through test:integration) have **never run this session** — treat gate as
   fully unverified until this run goes green end-to-end. DROP the gate DB when done.

2. **Push**: `git push -u origin 1325-provider-credential-picker`.

3. **Open PR**, title tagged `[SECURITY]`. Body must cite:
   - Fable-verified: create route soft-fails discovery (`packages/ai/src/routes.ts` ~199-214,
     try/catch) — fake-key UAT create genuinely succeeds and the card renders.
   - Fable-verified: `credentialPayload.apiKey` matches server reader
     (`provider-validation.ts:70`) and existing Edit-pane shape.
   - Non-blocking fast-follow note (do not fix here): "Local (Ollama)" is catalogued
     `authMethod: "api_key"`, forcing a dummy key even though Ollama ignores auth headers —
     pre-existing modeling, consistent with the one-credential-shape ruling.

4. **Live-path proof**: actually run the new UAT test against a live dev instance —
   `tests/uat/specs/1270-provider-signin.uat.spec.ts`, test
   `"Settings collects an API key before creating a picker provider (#1325)"`. Post to the PR via
   `gh pr comment`: run command, exit code, assertions that passed. **Screenshots forbidden** per
   `docs/DEVELOPMENT_STANDARDS.md`.

5. **Report** PR URL + evidence to `Coordinator` (herdr label).

6. **Do NOT merge, move the board, or close #1325** — security tier, Ben's sign-off required.

## Do not re-derive
- Design ruling (Option 3: client collects the credential the catalog entry's `authMethod`
  needs; server 400 guard at `routes.ts:759` stays untouched) is Fable-approved — don't
  re-litigate it.
- Plan file: `docs/superpowers/plans/2026-08-13-1325-provider-credential-picker.md` — read by
  section only if needed, never in full.

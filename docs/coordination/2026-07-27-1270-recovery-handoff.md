# Handoff — #1270 recovery + live-path gate (2026-07-27)

Pointer-style. Details live in the commits, the PR, the spec, and agentmemory — not here.

## Where this stands

**#1270 is done pending merge.** Both process gates are clear and both halves of the live-path gate
are recorded on **PR #1323** (`recover/1270-0719-settings-onboarding`, worktree
`~/jarvis-recover-1270`, 13 commits).

- **Spec approved** by Ben 2026-07-27 —
  `docs/superpowers/specs/2026-07-27-1270-provider-signin-shared-design.md`.
- **Gate, automated half:** `pnpm test:uat 1270` → 2 passed, `### FINAL test:uat rc=0` on a freshly
  provisioned real stack, with live assertions. Spec:
  `tests/uat/specs/1270-provider-signin.uat.spec.ts`.
- **Gate, human half:** Ben confirmed he ran the provider sign-in **device code** on his own dev
  instance and it worked. The UAT cannot cover this — a provisioned stack has no provider CLIs, so
  `cliAvailable` is false and the automated dialog never renders; the spec walks the fallback
  "Use terminal to sign in" branch. **Do not re-litigate whether the device code works.**
- **Foundation gate green locally** before the UAT: unit 442 files / 3382 passed; integration 158
  files / 1721 passed / 2 skipped; migrations through `0128_person_context.sql`.

Remaining: merge #1323 once CI is green, then close #1270 and #1271 and move the board to Done.

## The gate's first real catch — issue #1325, PARKED

Adding an **API-key** provider from Settings (Mistral / Local (Ollama) / OpenAI-compatible / Custom)
fails end to end: `POST /api/ai/providers` returns `400 credentialPayload is required for api_key
auth method` because the picker never sends one. Error toast, nothing added. CI and code review both
passed; the live walk found it.

Ben's ruling: **"noted, we'll pick this up later."** Filed with three candidate fixes and a second
related defect (`hasCredential` is `encrypted_credential IS NOT NULL` on a `NOT NULL` column, so the
card's `"No credential"` state is unreachable and an empty credential would claim
`"API key stored"`). **Do not fix it unprompted, and do not fix it by sending
`credentialPayload: {}`** — that makes the UI lie about credential state.

Not a regression from this branch: `main` hardcoded `authMethod: "cli"` for every catalog entry, so
the same click silently created a bogus "Mistral CLI". Equally unusable, just quieter.

Consequence to remember: with the API-key assertion dropped, the UAT **no longer proves**
`f5b44c52`'s `authMethod` passthrough end to end — the remaining CLI assertion passes on `main` too.
Restore the API-key half as the regression test when #1325 lands.

## Also done and pushed to `main`

- `818bf2c0` — **live-path gate adopted**: hard invariant in `CLAUDE.md`, full rule in
  `docs/DEVELOPMENT_STANDARDS.md` → Live-Path Gate, pre-merge check in the `coordinate` skill that
  overrides every tier's auto-merge-after-green.
- `bcfcabe3` — replaced the nonexistent `herdr agent send` with `herdr agent prompt` in the docs.
- Ben approved the one behaviour-removing commit on the branch (`fdbe5f2e`, −296 lines, drops the
  #368 "Ask Jarvis" finish affordance).

## Closed, needs no further action

- **Voice/STT spec was never pending** — #874 closed *completed* 2026-07-09, feature is on `main`.
- **`docs/coordination/AWAITING-BEN.md` has no open items.**
- **Rescue directory `~/jarvis-uncommitted-rescue-2026-07-26/` is closed** — verdict in agentmemory
  `rescue-patch-triage-2026-07-27`; only live find became #1318.

## Traps earned here (also in agentmemory)

- **Read the real exit code.** Grep `### FINAL` in the run log; a wrapper `echo $?` reports the
  echo's status and masked an rc=1 twice this session.
- **CI red is not always code.** "Verify foundation and app" failed purely on a Docker Hub registry
  timeout pulling postgres/greenmail. `gh run rerun <id> --failed` clears it.
- **Playwright selector traps** are consolidated in agentmemory `uat-spec-gotchas` (six now) —
  including that a provider card's own "Edit" collides with its models' `Edit <model>` buttons.

## Selector facts, do not re-derive

- Wizard order `welcome → cliAuth → connectors → finish`; advance with **"Start setup"**.
- Wizard provider labels are **Claude / Codex / Antigravity** — the `google` kind is NOT "Gemini".
- Settings nav: usermenu → *Settings & permissions* → *Admin / Setup* → *Assistant & AI*.
- `supportsAutomatedProviderLogin` requires `cliAvailable`, so "Log in"/"Re-authenticate" render only
  when a CLI binary is present; otherwise the CLI block shows "Use terminal to sign in".

## Standing corrections

- Terse reporting. Lead with the result; no recaps, no option surveys.
- Never conclude "never built" from a `main`-only grep in this repo, and never conclude "not
  approved" from a spec status line — check whether the issue closed *completed* first.

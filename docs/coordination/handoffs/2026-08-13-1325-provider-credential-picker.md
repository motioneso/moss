# Build Handoff — 1325-provider-credential-picker

**GitHub issue:** #1325 — no separate spec doc; scoped fix, build off the issue text + Fable's
ruling below. Read `gh issue view 1325` first.
**Risk tier:** `security` — credential handling on an AI-provider create path. Gets adversarial
Opus QA + **Ben's explicit merge sign-off**.
**Design-fork ruling (Fable, binding — do not re-litigate):** Option 3. The picker must collect
the credential the catalog entry's auth method actually needs (API key / base URL / both) and
send it as `credentialPayload` on create. The server-side 400 guard at
`packages/ai/src/routes.ts:759` is correct fail-closed validation and STAYS as-is — the frontend
was the wrong half, not the backend. Do not weaken or route around that guard.
Rejected alternatives (do not re-propose): sending an empty `{}` credential (false "stored"
status); a migration to make credential nullable (buys an honest empty state at the cost of a
migration + contract change, to enable a worse create-then-edit flow).
Side effect of Option 3: the dead "No credential" UI branch and the always-true `hasCredential`
question both become moot — tidy them in the same pass if small, otherwise note as a fast-follow.
**Worktree:** `.claude/worktrees/1325-provider-credential-picker` **Branch:** `1325-provider-credential-picker` (off `origin/main`)
**Coordinator label:** `Coordinator` — resolve fresh via `herdr pane list`.
**Coordinator session id:** `caef4e32-df22-4310-a42d-866771a0ba6c`
**Plan reviewer:** pane labelled `spec-1248 (Fable)` / `spec-1248-fable`.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. `gh issue view 1325`, then re-read the ruling above — it settles the fork, don't reopen it.
3. Design-system skill applies before touching the picker's UI fields — reuse the Edit pane's
   existing field patterns rather than inventing new ones.
4. **Plan-authorship rule (standing, non-negotiable tonight):** draft a short plan per
   `plan-build`, message the `Coordinator` label with the pointer, and STOP. Coordinator routes
   to Fable for review. Wait for explicit "approved" before writing code.
5. Once approved: TDD build, block empty-key submit client-side, commit per step, follow
   `coordinated-build`/`coordinated-wrap-up`.

## Exit criteria

- Test proving an `api_key`-type provider create sends a real credential and the card never
  claims "API key stored" without one.
- Full gate green on an isolated gate DB (`verify-gate` skill).
- PR open, rebased on `origin/main`, tagged `[SECURITY]`.
- Touches a user-facing create flow — live-path proof required (installed + exercised on live dev,
  screenshot on the PR).

## Run-specific bans

- Work only in this worktree/branch; `git add` by explicit path.
- Never touch `docs/coordination/`, the project board, or merge anything yourself.
- No secrets (real or placeholder-looking) in any doc, payload, log, or prompt.

## Collision notes

- None identified against tonight's other 5 lanes — different package (`packages/ai` + provider
  picker UI) than the other security lanes' scope.

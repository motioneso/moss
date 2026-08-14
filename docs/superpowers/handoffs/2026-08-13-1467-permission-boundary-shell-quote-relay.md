# Relay — #1467 permission-boundary-shell-quote

**Status: plan drafted, committed, and posted to Coordinator. Zero code written. Waiting on
Fable's explicit "approved" — do NOT write any code until you see it.**

## Where things stand

- Branch: `1467-permission-boundary-shell-quote`, off `origin/main` @ `198928da4`. This worktree.
- Plan: `docs/superpowers/plans/2026-08-13-1467-permission-boundary-shell-quote.md` (committed at
  `03437bf0f`). Read it by section when you resume — it's short, but don't re-derive root cause
  from source again, it's already verified current on this branch.
- Handoff doc (original, from the coordinator): read once if you need original scope/exit
  criteria: `docs/coordination/handoffs/2026-08-13-1467-permission-boundary-shell-quote.md` (not
  in this branch's tree — fetch via `git show 1d5ceedc0:<path>` if needed, it lives on
  `coord/overnight-20260810`).
- Risk tier: **security** — adversarial cross-model QA + Ben's explicit merge sign-off required
  before merge (not before build — build proceeds once Fable approves the plan).
- Reviewer: **Fable**, Herdr pane labelled `spec-1248 (Fable)` / `spec-1248-fable`. She was
  finishing a quick #1487 scoping check before starting this review; may already be done.
- Coordinator: peer Claude session, Herdr pane labelled `Coordinator`, session id
  `caef4e32-df22-4310-a42d-866771a0ba6c` at last check (confirm fresh via `herdr pane list` —
  don't trust this session id blindly if it's been a while). Last exchange: I sent the plan
  pointer via `SendMessage`; Coordinator replied confirming routing to Fable and reiterated the
  wait-for-"approved" rule.

## What to do next

1. `herdr pane list` — confirm the Coordinator pane (by label, re-derive session id) and check
   whether Fable or the Coordinator has already sent a message with "approved" in it (check your
   inbox / recent cross-session messages first — may already have arrived).
2. If not yet approved: wait. This is a legitimate wait-for-external-review state, not a stall —
   don't nudge Fable, don't self-approve, don't start writing code speculatively.
3. Once "approved" arrives (from Fable directly or relayed by the Coordinator): proceed to Task 1
   of the plan via `superpowers:test-driven-development`, commit per task with
   `Co-Authored-By: Claude` trailer. Tasks are: (1) `vault-allowlist.ts` — extract/export
   `resolveVaultRoots()`; (2) `claude-permission-hook.ts` — inject `JARVIS_NOTES_ROOTS` via
   `vaultRootsEnvEntry()` into both hook command arrays (5 test cases specified in the plan,
   including the end-to-end shell-executed-command-string test that closes the false-positive gap
   in the existing test suite); (3) `settings-vault-chooser.tsx:156` string fix, no test needed.
4. Follow `coordinated-build` for the rest of the build/PR lifecycle; `coordinated-wrap-up` at the
   finish line. Live-path proof required on the PR (real notes read through UI on live dev,
  pre-approved with no permission card — record durable DOM, network, or application-log evidence;
  do not take screenshots).

## Traps already resolved (don't re-hit these)

- `gh issue view 1467 --json body` returns an unresolved `<<ccr:...>>` placeholder instead of real
  text — use `WebFetch` on the issue's GitHub URL instead.
- `SendMessage(to: "Coordinator")` fails — Herdr pane *labels* aren't `SendMessage` addresses.
  Cross-reference `herdr pane list` (label → `agent_session.value`) against `ListAgents` to find
  the addressable peer-session name, and use the full bracketed `name [ref]` form.
- This is a shared checkout — use the `shared-checkout` skill before any commit; commit by
  explicit path only, never `git add -A`/bare `git commit`.
- `node_modules` already present in this worktree — skip `pnpm install`.

## No open questions

Root cause, fix shape, and scope were all verified directly against source on this branch — no
drift from the issue text. See the plan's "Root cause" and "Open questions: None" sections.

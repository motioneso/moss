# Build Handoff — 1486-trust-proxy-fix

**Spec:** `docs/superpowers/specs/2026-08-10-self-hosted-tls.md` — but its "no broader than the
Compose bridge CIDR" baseline is **superseded** by the Fable ruling below. Follow the ruling, not
that line of the spec.
**GitHub issue:** #1486 — trustProxy boolean coercion trusts XFF from any peer, not just the
reverse proxy. Also read #901 (the ruling corrects it).
**Risk tier:** `security` (network-exposed trust boundary). Opus adversarial QA + delegated-Fable
merge sign-off required — but **DO NOT MERGE even after green QA**: see hold below.
**Worktree:** `.claude/worktrees/1486-trust-proxy-fix` **Branch:** `1486-trust-proxy-fix` off
`origin/main`
**Build skill path (absolute):** `.claude/skills/coordinated-build/SKILL.md`
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`, resolve pane fresh.
**Coordinator session id:** `0bb9f516-c026-454f-bc97-dc9faf43bd20`.
**Relay trigger:** context-meter 70% warning, or a compaction summary → message coordinator, use
`relay` skill.

## Design ruling — ALREADY DECIDED, build to this exactly

Fable ruled (delegated authority, posted at
https://github.com/motioneso/moss/issues/1486#issuecomment-5263217119):

- **Pin the exact static Caddy IP** (`ipv4_address` on the existing Compose network) as the
  trusted proxy address — NOT a CIDR/dedicated-network trust. Reasoning: Docker's userland proxy
  rewrites host-local connections to the published port to the bridge gateway IP, which sits
  inside any bridge CIDR — trusting the whole CIDR hands XFF-spoofing power to every on-box
  process. A dedicated network has the same gateway hole.
- **Fail loud at boot** on legacy boolean values (`1`/`true`/`yes`/`on`) or any unparseable
  value — do not silently fall back to trust-all (reproduces the vuln) or silently no-trust
  (breaks secure-cookie issuance, undiagnosable 403 on sign-in).
- Keep a `loopback` keyword in the env contract for #1403's host-dev tailscale-serve tier.
- This **corrects #901's locked spec** (`docs/superpowers/specs/2026-08-10-self-hosted-tls.md`).
  Grounding: the issue body, the #901 spec, and `apps/api/src/server.ts:221` directly (the
  `spec-1486-trust-proxy` worktree/branch referenced elsewhere does not exist — don't look for it).

## ⛔ MERGE HOLD — read before you finish

Prod currently runs `JARVIS_TRUST_PROXY=1` (a legacy value the new fail-loud code will reject at
boot), and prod auto-pulls from `:edge` ~4am. **Open the PR, get it QA'd, but do NOT merge** — this
is logged in `docs/coordination/AWAITING-BEN.md`, Ben must confirm the prod env var migration
timing first. Report PR as ready-to-merge-pending-Ben, not done.

## Start

1. `[ -d node_modules ] || pnpm install`
2. Read issue #1486 + #901 + the ruling comment in full.
3. Invoke **`coordinated-build`**: plan with **`plan-build`** → coordinator approval → TDD build →
   **`coordinated-wrap-up`** (PR + report). Flag the merge hold explicitly in the PR description.

## Exit criteria

- Exact-IP trust + fail-loud legacy handling implemented per the ruling.
- Env contract documents the `loopback` keyword for host-dev.
- Full gate green on an isolated gate DB. PR open, rebased on `origin/main`, security tier.
- PR description states the merge hold and points at `AWAITING-BEN.md`.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes

- None known.

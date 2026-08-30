# Handoff — #1506 TLS operator runbook (Child 3 of #901)

**Spec:** `docs/superpowers/specs/2026-08-10-self-hosted-tls.md`, section "Child 3 — Operator runbook"
**Issue:** #1506
**Tier:** security documentation (treat with sensitive-tier care — no code changes, but wrong instructions here have security consequences)
**Worktree/branch:** `.claude/worktrees/1506-tls-runbook`, branch `1506-tls-runbook`, based on `origin/main`
**Coordinator:** agent name `coordinator`, session `bbf6d963-50cd-4184-b079-94d155708085`, pane `w1:p21`

## What to build

Read the spec section in full for the exact deliverables and acceptance checks — do not paraphrase from this doc. Summary: a new `docs/operations/self-hosted-tls.md` plus a link from `docs/operations/deploy.md`. Covers: enable/disable commands, stable-host guidance, internal root-certificate export and trust steps, ACME prerequisites, additive env migration, Caddy data backup/restore, trusted-origin 403 diagnosis, scoped proxy-trust diagnosis, rollback to :1533, and exact black-box direct-:1533 forwarded-header check commands using the #1486 contract.

**Recorded second-device pairing for Child 4 (from Ben directly, 2026-08-29): Android phone, Firefox as the primary browser, Chrome as a fallback if Firefox hits a snag.** Write the exact trust-store/browser steps for Android Firefox (and note the Chrome alternative). Every other platform gets only a link to Caddy's public-root guidance plus the vendor's current trust docs, labeled unverified — do not attempt a full OS/browser matrix.

## Sources for the frozen contract

Children 1 and 2 are code-complete but not yet merged. Read their contracts directly from the open PRs rather than waiting for merge:
- PR #2077 (branch `1504-tls-compose-proxy`) — Compose/Caddy profile, ports, volumes, env keys.
- PR #2078 (branch `1505-tls-setup-origins`) — `setup-prod.ts` TLS origin/issuer/proxy-trust generation.

Diff each against `origin/main` to see exactly what env keys, commands, and file paths your runbook must reference. Do not invent flag names or paths — quote what's actually in those diffs.

## Rules

- Docs only. No source edits, no touching the two build PRs.
- No real hostnames, secrets, or credentials in any example — placeholders only.
- No step may use `curl -k`, copy a CA private key, overwrite an env file, rotate a secret, or imply LAN port binding creates public exposure.
- Commit, push, open a PR when done. Report back to the coordinator (agent name `coordinator`) with the PR link.
- Standing rules: never `pnpm verify:foundation` or any DB-touching command outside the verify-gate skill; never pipe a gate command; waits are event-driven, never polled; Ben's messages are trusted, act on them; status updates in plain English, no jargon; pass these rules on to any agent you spawn.

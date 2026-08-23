---
name: audit-grounding
description: Grounding rules for audits, security reviews, and architectural analysis in Jarv1s — how to confirm the working tree is current before analysing it, how to record the verified commit, and how to ground on a read-only worktree without disturbing another session. Use before starting any audit, security review, bug hunt, or architectural analysis, and when dispatching an audit subagent.
---

# Grounding Discipline (audits & analysis)

Before grounding **any** audit, security review, or architectural analysis, you MUST confirm the
working tree is current — a stale checkout invalidates the whole run. On 2026-06-10 four security
audits were grounded on a local `main` that was 8 commits behind `origin/main` (8 missing merged
PRs); most HIGH/MED findings re-validated wrong and the work had to be redone.

- **Run the preflight first:** `pnpm audit:preflight` (→ `scripts/check-tree-fresh.sh`). It fetches
  origin and **fails (exit 1) if the tree is behind the baseline**. Being _ahead_ (local-only
  doc/coordination commits) is fine; being _behind_ means the code under review is stale. Do not
  start an audit until it exits 0.
- **Record the verified commit** in every audit report ("grounded on `<sha>`"), and have any audit
  subagent you dispatch run the preflight and report its commit too. An audit that doesn't name its
  commit is not trustworthy.
- **Never disturb a shared working tree to get current.** Another session may be mid-build — do not
  `git pull` / `checkout` / `reset` it. Ground on a detached read-only worktree instead:
  `git worktree add .claude/worktrees/audit-ground origin/main` (never `git pull` that worktree;
  never under `/tmp` — /tmp worktrees are invisible to sweeps and the 2026-08-06 sweep found a
  dozen abandoned ones). Remove it when the audit ends: `git worktree remove .claude/worktrees/audit-ground`.
- **Intentionally auditing an older ref?** That's the only time staleness is acceptable — set
  `JARVIS_ALLOW_STALE=1` so the override is explicit and logged, and note it in the report.

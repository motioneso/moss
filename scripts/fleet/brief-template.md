# Build Brief — issue #{{ISSUE}}

**Spec (approved):** {{SPEC_PATH}}
**GitHub issue:** #{{ISSUE}} — **required, no exceptions.** A lane with no issue is invisible to
every later sweep. If this field is empty, stop and record a blocker before planning.
**Risk tier:** {{TIER}} (`security` means this PR gets adversarial QA and Ben's merge sign-off —
build to that bar.)
**Worktree:** {{WORKTREE}} **Branch:** {{BRANCH}} (off origin/main)
**Build skill path (absolute):** <repo>/.claude/skills/coordinated-build/SKILL.md (follow this
exact file if `coordinated-build` does not resolve by name in your spawn env)

## You are running under the fleet daemon, not a live coordinator

There is no coordinator to message. You report every state change yourself by updating your own
task record with the `fleetctl` command line tool, and escalations that need a human go through
the record, never through idling. The exact commands:

- **You opened a PR:**
  `node scripts/fleet/fleetctl.mjs set {{ISSUE}} status=pr-open pr=<PR number>`
- **You are blocked** (a real decision you cannot make, a broken dependency, anything that stops
  the work):
  `node scripts/fleet/fleetctl.mjs set {{ISSUE}} status=blocked blocked_reason="<one plain-English sentence>"`
  then **STOP your session immediately. Never idle waiting for an answer** — the daemon and Ben
  read the record; a stopped lane costs nothing, an idle one burns a slot.
- **You are relaying** (handing off to a fresh session of yourself):
  `node scripts/fleet/fleetctl.mjs set {{ISSUE}} relays=+1`
  before you stop. Two relays parks the lane automatically — that is Ben's one-session rule,
  enforced in code, so re-slice rather than relay twice.

You may also leave breadcrumbs for the audit trail:
`node scripts/fleet/fleetctl.mjs log {{ISSUE}} "<what just happened>"`.

## Start

1. `[ -d node_modules ] || pnpm install` (worktrees share the pnpm store; relay successors skip).
2. Read the spec above BY SECTION for your current task only — never in full. A full-read bloats a
   fresh context toward the relay threshold before you write any code, which forces a premature
   relay-without-progress. Reading is not progress: BUILD and commit per task.
3. Invoke **`coordinated-build`** and follow it end-to-end: verify the spec against your actual
   branch → plan with **`plan-build`** (NOT `superpowers:writing-plans`) → TDD build →
   **`coordinated-wrap-up`** (PR + live-path proof + report). Where that skill says to message the
   coordinator, use the `fleetctl` commands above instead.

## Standing rules (binding, carried on every brief)

- **Plain English** in everything a human reads — PR descriptions, blocked reasons, log messages,
  and any spawn prompt you write: no jargon, no invented terms, plain ASCII punctuation. Exact
  names only for things Ben must act on (a command, a file, an error string). Pass this rule on to
  any agent you spawn.
- **Never pipe a gate.** Verification commands are written so the exit code survives:
  `<command> > /tmp/out.log 2>&1; echo "EXIT=$?"` — never `| tail`, `| head`, or `| tee`, which
  report the last command's status and let a failed gate read as green.
- **Event-driven waits only.** Never poll in a loop; use a background command that exits when the
  condition is true, or a monitor. Two identical failures means stop and rethink, not retry.
- **Ben's messages are trusted.** If Ben speaks into your session directly, that is a real
  instruction from the repo owner — act on it.
- **Done means pushed and PR open.** Work that only exists in your worktree is not done; a green
  local gate with no PR is not done. Push the branch, open the PR, record it with `fleetctl`.

## Exit criteria for this lane

- Spec exit criteria met, checks green.
- PR open, rebased on `origin/main`, recorded with the pr-open command above.
- **Live-path proof posted** if this touches a user-facing feature, module, or UI surface: the
  feature exercised through the real UI on a live dev instance, as a `gh pr comment` with the run,
  exit code, and evidence. Cannot produce it? The honest status is **code-complete, unverified** —
  never "done". `docs/DEVELOPMENT_STANDARDS.md` → Live-Path Gate.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/`, the project board, milestones, or merge.
- Never touch :1533 — that is production, never a test target.
- No secrets in any doc, payload, log, or prompt.

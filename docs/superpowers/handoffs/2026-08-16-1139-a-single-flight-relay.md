# Relay — 1139-A single-flight action resolution (#1518)

## Where things stand

- **Worktree/branch:** `.claude/worktrees/1139-a-single-flight`, branch `1139-a-single-flight` (off origin/main).
- **Handoff doc (coordinator-authored, do not edit):** `docs/coordination/handoff-1518-1139-a-single-flight.md`.
- **Spec section (read only this section, ~line 78-137):** "Child 1139-A — Make action resolution single-flight" in `docs/superpowers/specs/2026-08-10-1139-chat-export-ui-followups.md`.
- **Plan written and committed:** `docs/superpowers/plans/2026-08-16-1139-a-single-flight.md` (commit `fb4823b94`). Follows `plan-build` format: seams check, decisions (exact signatures), test cases, unpiped verification commands, kill gate, rulings ledger.
- **No implementation code written yet.** Coordinator approval for the plan was requested but not yet received when this relay was triggered.

## What's done

1. Verified spec section 1139-A against the branch (step ½ of `coordinated-build`) — one drift found and logged in the plan's rulings ledger: spec implies an "expired" e2e assertion already exists to retain; repo-wide grep found none. Not a scope change — treated as a wording overstatement, documented not escalated.
2. Wrote the plan (`docs/superpowers/plans/2026-08-16-1139-a-single-flight.md`), covering:
   - Rewrite `apps/web/src/chat/action-request-card.tsx`'s hand-written async `resolve` onto `useMutation` (pattern already used in `message-row.tsx` and `chat-drawer.tsx`, same module).
   - Add one component-local `useRef` synchronous admission guard to close the same-tick double-click race that `setStatus` (React state, not synchronous) cannot close.
   - Upgrade 409/expired detection from string-match (`message.includes("expired")`) to `ApiError.status === 409` (`apps/web/src/api/client.ts:177-185`) — strictly more robust, same external behavior/copy. Logged as a non-blocking decision in the rulings ledger.
   - Extend `tests/e2e/app-shell.spec.ts`'s "Chat drawer — Approve/Reject card" describe block (lines 317-432) — NOT the render-only `tests/unit/action-request-card-preview.test.tsx` (confirmed no edit needed there; state contract unchanged) — with two new tests: single-flight double-click (second click before first resolves does not send a second network request) and unmount-safety (resolving while the drawer unmounts does not throw/warn).
   - Live-path artifact: per the plan's rulings ledger, the UAT harness has no chat-capable AI provider at any seed level (issue #1121, confirmed via two sibling UAT spec files hitting the same wall), so this task's live-path proof must be a live walkthrough on a real ephemeral #1000 instance at `coordinated-wrap-up` time (real login, double-click Approve, one real terminal decision) — not a new scripted UAT spec. Fallback if no live instance with a real AI provider is reachable: honest "code-complete, unverified" status.
3. Sent plan-approval escalation to the coordinator via `herdr agent prompt "w1:pCJ" "..."` (pane resolved fresh immediately before sending; confirmed exactly one pane labeled "Coordinator", session id `11cf8264-55a8-4fa4-b32b-c8d086469f74`, matching the handoff doc). Verified delivery via `herdr pane read` — coordinator was actively processing ("Unravelling…").
4. **No reply received yet** when this session hit the context-meter 70% warning and had to relay.
5. Found and fixed a bug from the pre-relay session: the plan file had been written to the **shared main tree** (`/home/ben/Jarv1s/docs/superpowers/plans/...`) instead of this worktree. Copied it into the worktree and committed it here (commit `fb4823b94`). The stray main-tree copy was left alone (untracked, not committed, not this worktree's concern — the shared main tree already has many untracked stray files from other sessions; do not attempt to clean it up).

## What's left (next concrete steps for successor)

1. **Re-resolve the Coordinator pane fresh** (`herdr pane list`, confirm exactly one pane labeled "Coordinator", get its current session id and pane id — do not reuse `w1:pCJ`, it may have reflowed). Read its recent output (`herdr pane read <pane> --source recent --lines 12`) to check whether it already replied to the plan-approval message sent by the prior session. If a reply is visible, act on it. If not, it's fine to just continue watching — do not resend the same escalation; if genuinely necessary, send one fresh status check, not a duplicate approval request.
2. Once approved (or if already approved and you missed it): execute the plan via `superpowers:test-driven-development`, task-by-task, committing green with `Co-Authored-By: Claude`, `git add` restricted to explicit paths only (never `-A`).
3. Run the pre-push trio before any push: `pnpm format:check && pnpm lint && pnpm typecheck`, then `git fetch origin main && git rebase origin/main`.
4. Close out via `coordinated-wrap-up`: own gate on an isolated gate DB (`verify-gate` skill — never run `pnpm verify:foundation` unscoped), push, open PR, post the live-path proof (or the honest "code-complete, unverified" fallback per the plan), report to the coordinator. Never move the board, close the issue, or merge.

## Reminders

- Read the spec/plan **by section**, not in full, on resume — full-reads bloat a fresh context toward the relay threshold before any code is written (exactly what happened in the prior session: it produced only a plan and a stray-file fix, no code, before hitting 70%).
- Relay trigger is the context-meter's 70% warning — same threshold for everyone, don't invent a higher personal one.
- `[ -d node_modules ] || pnpm install` — do not blindly re-run install; `node_modules` already exists in this worktree.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- Collision notes: three parallel lanes this wave — #1519 (1139-B), #1522 (1139-E), #1523 (1140-A) — no known file overlap, but stop and check with the coordinator if you touch shared chat-action resolution code outside this task's file.

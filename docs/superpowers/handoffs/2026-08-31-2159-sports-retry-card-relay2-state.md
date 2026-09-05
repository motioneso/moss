# State doc — issue 2159 sports retry action card (relay 2 checkpoint)

Written because this relay hit the 70% context warning with no open pull request. Per the
handoff's relay budget, this session is NOT relaying again. Re-slice into a fresh, smaller
lane instead of continuing this one.

## What's committed (green, verified)

Commit `5543c347b` on branch `fix/2159-sports-retry-card`, this worktree:
`tests/integration/sports-retry-source-card.test.ts` — the Phase 1 diagnostic integration
test from the approved plan (`docs/superpowers/plans/2026-08-31-2159-sports-retry-card.md`).

- Full repo type check (`npx tsc --noEmit -p tsconfig.tests.json`) is clean with this file
  included — zero errors anywhere, not just in the new file.
- The test exercises the real gateway (`AssistantToolGateway`), the real MCP HTTP transport
  (`registerMcpTransportRoute`), a real `ConfirmationRegistry`, and a real `AiRepository`
  query for the pending-row check — matching the plan's two seams exactly:
  1. `tools/list` includes `sports.retrySource` with `inputSchema.required` containing
     `sourceId`.
  2. `tools/call` for `sports.retrySource` triggers `notifier.emit` with
     `kind: "action_request"` and a summary matching `/^Retry sports source /`, the pending
     row is queryable as `status: "pending"`, and resolving it `"confirmed"` over the real
     HTTP resolve route lets the call settle and emits a second `kind: "action_result"`,
     `outcome: "executed"` record.
- One deliberate simplification from the plan text: instead of seeding a real
  `sports.sources` database row in state `failing`, `sportsRetrySourceExecute`'s dependency
  (`SportsSourceService`, wired through `configureSportsChatTools`'s third parameter) is a
  fake object implementing only `retrySource()`, the same convention this test suite already
  uses for `fakeCalendarWrite` and `fakeWriter`. This still exercises the real gateway,
  policy, confirmation, and notifier path — the actual seams under test — while skipping the
  unrelated sports-sources persistence/discovery machinery no assertion needs. Also: no
  custom `actionPolicy` was passed to the gateway, because the gateway's own default policy
  lookup (`getFamilyManifest` returns null -> `resolvePolicy` returns `"confirm"`,
  `packages/ai/src/gateway/policy.ts:47`) already produces the same `"confirm"` outcome the
  real `sports.sources` family manifest would.

## What's NOT done

**The test has never been run.** It has not gone through `verify-gate` — this session ran
out of context budget partway through checking `herdr pane list` before starting the gate,
and never got to `scripts/run-gate.sh start`. So Phase 1's actual signal (which branch of the
split fails, or whether it passes end-to-end) is still unknown. This is the very next step for
whoever picks this up.

## What to do next (new session, smaller lane)

1. `[ -d node_modules ] || pnpm install` if needed.
2. Check `herdr pane list` for a running gate before starting (standing rule, still applies).
3. Via `verify-gate`: `scripts/run-gate.sh start` then background
   `scripts/run-gate.sh wait --follow`, scoped to
   `tests/integration/sports-retry-source-card.test.ts` if the gate script supports narrowing
   to one file, else the nearest scoped `pnpm` test script that includes it. Never pipe.
4. Read the result. Report to the coordinator (agent name `coordinator`) which branch failed
   — tool listing, or confirm/notify/DB wiring — or that it passed end-to-end. This finding,
   not more code, is what the coordinator is waiting on. Do not write Phase 2 fix code without
   a fresh approval from the coordinator — the original approval (2026-08-31, quoted in
   `docs/superpowers/handoffs/2026-08-31-2159-sports-retry-card-relay.md`) only covers running
   Phase 1 and reporting.

## Everything else unchanged

The full original handoff — approval wording, seams check, Phase 2 candidate locations,
collision notes (PR #2158 overlap in `gateway.ts`), and standing rules — is still current and
authoritative: `docs/superpowers/handoffs/2026-08-31-2159-sports-retry-card-relay.md`. Nothing
in this checkpoint changes the plan; it only records that the checkpoint happened before the
gate ran.

# State doc — PR 2164 root-cause lane (relay 1)

Branch/worktree: `fix/2159-sports-retry-card`, this worktree (unchanged). Coordinator is the
sole agent named `coordinator` (re-resolve fresh, don't trust a pane number written here).

## Why this lane exists

PR 2164 is live-path RED. The r14 diagnostic run
(https://github.com/motioneso/moss/pull/2164#issuecomment-5502129698) found two problems in one
five-spec UAT run: the sports retry card's Approve button never appeared (180s timeout), and
`runtime-context.uat.spec.ts` never ran at all — no pass/fail/skip line anywhere in the log.

## Finding 1 — sports retry card: gateway path is proven intact, do not touch it

A prior session (see `docs/superpowers/plans/2026-08-31-2159-sports-retry-card.md` and the two
handoffs beside it) already wrote a Phase 1 diagnostic integration test but never ran it:
`tests/integration/sports-retry-source-card.test.ts`.

I ran it. **Both assertions passed** — commit `719bdbc0e` (pushed) added a narrow gate script
(`test:sports-retry-card` in package.json) so it can run alone instead of the whole integration
suite. Gate log: `/tmp/jarv1s-gate/fix_2159_sports_retry_card-20260901-170915.log`, `rc=0`, "2
passed (2)".

That means: `tools/list` really does include `sports.retrySource` with the right schema, and
calling it really does create a pending row, emit `action_request`, and — once confirmed — runs
the retry and emits `action_result`. Per the plan's own kill gate, a full pass here means the
defect is NOT in this repo's gateway/notifier/database code. Do not go looking there again.

**What's still unknown, and is the actual next step:** whether the live chat model ever decides
to call `sports.retrySource` during a real turn, or whether something in the real SSE/stream
delivery path (`packages/chat/src/routes.ts` — not yet read by anyone on this issue) drops the
`action_request` before the browser sees it. The diagnostic test can't distinguish these because
it talks to the gateway directly, bypassing both the live model and the SSE stream.

I flagged this fork to the coordinator (queued message, not yet acknowledged) and did not pick a
side myself — that's a product/architecture call above a build lane. **Read the coordinator's
reply before doing anything on this finding.** If no reply yet, the next concrete step either way
is to read `packages/chat/src/routes.ts`'s SSE handling for `action_request` records and compare
it against the chat drawer's live subscription — that's the untested boundary either branch would
touch first.

## Finding 2 — runtime-context spec: root cause found, fix not yet written

`tests/uat/run-uat.ts`, `resolveSpecPaths` (around line 19), filters the raw `readdir(SPEC_DIR)`
listing — filesystem order, effectively alphabetical — instead of preserving the order the caller
passed on the command line. Separately, `main()` (around line 133) calls `process.exit` the
instant any one spec fails, with no log line naming specs it will never reach.

Confirmed with a one-line Node check: filesystem order puts
`1909-sports-public-source-completion.uat.spec.ts` before `runtime-context.uat.spec.ts`, even
though the r14 diagnostic command listed `runtime-context.uat.spec.ts` third and the sports spec
fifth. So when the sports spec failed, the process exited before `runtime-context` ever ran — with
zero mention of it in the log. This exactly matches the evidence (four provisioning entries, no
fifth, no skip message).

**The fix (designed, not yet written):** make `resolveSpecPaths` preserve the caller's filter
order instead of the `readdir` order. Something like: iterate `filters` in order, and for each
filter push every still-unselected `available` path it matches, instead of filtering `available`
directly. Read the current file before editing — someone else may have touched it.

**Also worth doing, smaller and optional:** `main()`'s early-exit should log which remaining specs
it is not running, so this class of bug is visible in the log next time instead of silent. Do the
ordering fix first; only add the log line if there's budget left.

There's an existing unit test file for this runner, `tests/uat/run-uat.test.ts` — it currently
only covers single-spec selection. Add a multi-spec-order test there (mock `readdir` to return
files in one order, pass filters in a different order, assert `spawn` is called in the filter's
order) before calling this done.

## What's committed

Only `719bdbc0e` — the `test:sports-retry-card` package.json script. Nothing else on this branch
has changed. Tree was clean before that commit; confirm it's still clean when you pick this up.

## Next steps, in order

1. Check for the coordinator's reply on the sports-card fork (finding 1). Act on its steer.
2. Write and commit the `resolveSpecPaths` ordering fix (finding 2), plus its test.
3. Pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck`) + `git fetch origin main &&
   git rebase origin/main`, then push.
4. Get new-head CI. Report the fix commit SHA(s) and exact file:line citations to the coordinator,
   per the original brief — do not merge, do not touch `docs/coordination/`, do not use port 1533
   or start shared-dev live proof (coordinator authorizes that after the code fix).
5. If this successor also hits the 70% context warning with no PR open yet, STOP — do not relay
   again. Report to the coordinator that the slice needs re-scoping into smaller lanes instead
   (per the one-relay budget).

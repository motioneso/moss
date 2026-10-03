# Plan: fix-2934 — new chat stops a running turn, privacy rides with the request

Part of #2934. Risk tier: security (privacy boundary to the classifier model).
Worktree branch: fix-2934-newchat-stop. Collision note: lane #2942 later touches
chat-session-manager.ts, so this diff stays inside two source files plus one test.

## Problem

A turn waits on a settings read for the gate mode before its thread privacy is
known. A new chat that lands inside that wait flips the thread underneath the
turn, so private text is classified, written to the shadow log, and saved into
the new normal chat. New chat also never stops the running turn, while resume does.

## Spec verification against the branch (all premises current, nothing stale)

- The gate-mode wait exists at packages/chat/src/live/classifier-gate-lifecycle.ts:66,
  and the privacy read follows it at classifier-gate-lifecycle.ts:75-76.
- New chat is ChatSessionManager.clear at packages/chat/src/live/chat-session-manager.ts:692.
  It kills the engine and opens a new conversation but never aborts the turn
  controller. Resume is resumeThread at chat-session-manager.ts:749 and stops the
  turn at chat-session-manager.ts:764.
- The save points that run under the wrong thread are recordHandledTurn at
  classifier-gate-lifecycle.ts:165 and recordTurn at chat-session-manager.ts:614.
- Neither half of the fix exists: tryGatedTurn takes no privacy input, and clear
  calls no stop. The only caller of clear is POST /api/chat/clear at
  packages/chat/src/live-routes.ts:220, so no other caller depends on a turn
  surviving a new chat.

## Seams check (every assumed capability cited)

- AbortController per turn keyed by actor plus surface: chat-session-manager.ts:355-356.
- stopTurn aborts the controller and interrupts the engine, no-op when no turn
  runs: chat-session-manager.ts:675-689.
- tryGatedTurn already treats an aborted controller as authority after the gate
  wait: classifier-gate-lifecycle.ts:100. The same check is missing before the
  two save points.
- GateRequest carries an incognito flag and evaluate declines private chats
  before any classifier call: packages/chat/src/live/classifier-gate.ts:145,244-245.
  tryGatedTurn hardcodes that flag to false: classifier-gate-lifecycle.ts:83.
- Shadow begin takes an incognito input and skips private turns entirely:
  packages/chat/src/live/classifier-gate-shadow.ts:180-187. The manager feeds it
  session.incognito at chat-session-manager.ts:413, but the session resolves after
  the gate wait, inside the race window.
- Stopped-turn semantics (emit status, persist nothing) are the pattern to mirror:
  chat-session-manager.ts:566-574 and classifier-gate-lifecycle.ts:107-115.
- Test harness pattern (real ChatSessionManager over fake persistence, engine,
  gate): packages/chat/src/live/acp-turn-activity.test.ts:1-40.
- Unit runner accepts an explicit file: scripts/test-unit.ts:31-34, so
  `pnpm test:unit <file>` runs just that file.

## Decisions (signatures and paths, no bodies)

- D1. runTurn captures `requestIncognito` from
  `deps.persistence.getCurrentThreadState` before calling tryGatedTurn, and
  tryGatedTurn takes it as a required field and uses it for the Ruling 9 bypass
  instead of re-reading the thread after the mode wait.
- D2. tryGatedTurn puts the captured value into GateRequest.incognito (replacing
  the hardcoded false), so a private turn declines as private_chat before any
  classifier call.
- D3. runTurn passes the captured value to beginClassifierGateShadowTurn instead
  of session.incognito.
- D4. clear stops the turn first: `await this.stopTurn(actorUserId, chatSurface)`
  before any thread read or openNewConversation, in both the private and normal
  branches, mirroring resumeThread ordering.
- D5. Abort guards before both save points. persistGateOutcome returns the
  cancelled turn when the controller is aborted; runTurn checks the signal before
  recordTurn and takes the existing stopped path (status emit, no persist).
- Rejected option, steelmanned: serialize clear behind the in-flight turn (make
  new chat wait for the turn to finish). It keeps the window open rather than
  closing it, because the turn still resolves under the new thread, and it makes
  new chat block on a long turn. Abort matches resume and the issue direction.

## Tasks

1. Race test first: packages/chat/src/live/chat-session-newchat-stop.test.ts.
   Watch it fail before any source change.
2. Privacy capture (D1, D2, D3) in classifier-gate-lifecycle.ts and the runTurn
   call site in chat-session-manager.ts.
3. Stop on new chat (D4) plus save-point guards (D5) in chat-session-manager.ts
   and classifier-gate-lifecycle.ts.
4. Pre-push trio plus rebase, full gate on an isolated gate database per the
   coordinated-wrap-up skill, push, PR with release note, live-path proof.

## Test cases (behavior plus why each fails on broken code)

- T1. Private turn, new chat lands during the gate-mode wait: gate.evaluate is
  never called, recordHandledTurn is never called, the shadow log never opens,
  and the turn resolves cancelled. Fails today because clear never aborts and
  the privacy read sees the new normal thread.
- T2. New chat during a default-path turn: the turn returns on the stopped path
  and recordTurn is never called. Fails today because nothing aborts the read
  loop, so the reply is saved into the new thread.
- T3. Private turn with the gate on reaches evaluate with incognito true and
  declines as private_chat with no classifier call. Fails today because the
  request hardcodes incognito false.
- T4 (follows the security-claims rule). Each confinement claim above is tied to
  a failing-then-passing test: the test is run with the guard removed to watch
  it fail, then with the guard to watch it pass.

## Verification (unpiped, expected exit 0 unless noted)

- `pnpm test:unit packages/chat/src/live/chat-session-newchat-stop.test.ts > /tmp/2934-unit.log 2>&1; echo "EXIT=$?"` — expect EXIT=0 after the fix, nonzero before.
- `pnpm format:check > /tmp/2934-fmt.log 2>&1; echo "EXIT=$?"` — expect EXIT=0.
- `pnpm lint > /tmp/2934-lint.log 2>&1; echo "EXIT=$?"` — expect EXIT=0.
- `pnpm typecheck > /tmp/2934-ts.log 2>&1; echo "EXIT=$?"` — expect EXIT=0.
- `git fetch origin main > /tmp/2934-fetch.log 2>&1; echo "EXIT=$?"` then
  `git rebase origin/main > /tmp/2934-rebase.log 2>&1; echo "EXIT=$?"` — expect EXIT=0.
- Full gate per the verify-gate skill on an isolated gate database (never the
  live dev database, never piped).

## Kill gate (owner: coordinator)

- If the race test cannot be made to fail on unpatched code with fake
  persistence, gate, and engine, the window is not reproducible at unit level.
  Stop, do not re-scope silently, escalate to the coordinator.
- If any caller besides POST /api/chat/clear is found to depend on a turn
  surviving clear, stop and escalate before changing clear.

## Live-path proof (user-facing, on dev only)

Web http://192.168.50.36:5173, API :3000. Never prod port 1533. Through the real
UI with no network interception: start a slow turn, press new chat mid-turn,
expect a stopped status and a fresh thread with none of the first text in it or
the shadow log. Post the evidence as a PR comment. If the timing cannot be hit
reliably through the UI, report code-complete, unverified rather than faking it.

## Determinism boundary

No UI text changes. The only user-visible effect is that a turn cut off by a new
chat reports stopped instead of saving its reply into the wrong thread.

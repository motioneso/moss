# Relay: #1883 vault-search MCP error detail — live-path proof

Branch/worktree: `build/1883-vault-mcp-errors`, this worktree (unchanged — stay here).
Coordinator: agent name `coordinator` (re-resolve via `herdr agent list` before messaging —
pane id drifts).

## State: fix shipped, PR open, gate green — now doing live-path proof

- PR: https://github.com/motioneso/moss/pull/1892 — DO NOT MERGE (not my job; coordinator owns
  merge).
- Full gate green: `pnpm verify:foundation` rc=0, 212 files / 2044 tests passed, isolated gate DB
  `jarvis_gate_1883vault` (already dropped/reusable).
- Branch pushed, rebased on `origin/main`, includes the release note commit
  (`docs/WHATS_NEW.md`, `Category: Fixed`).
- Coordinator (pane resolved fresh each time — was `w1:pQ4`, name `coordinator`) REJECTED my
  first "not user-facing, no live-path proof needed" claim. Ruling: this IS user-facing — it
  changes the error text a real chat user sees when a built-in tool fails — so the live-path gate
  applies. Explicit instructions from that message:
  - Run this branch on a FRESH ISOLATED instance, not the always-on main-branch dev instance at
    192.168.50.36 (that one runs unmerged `main`, not this branch — never treat it as the proof
    target).
  - Exercise the failing vault-search path through the REAL chat UI.
  - Post command, exit code, and bounded UI/network/log assertions as a PR comment on #1892.
  - If a concrete environment blocker remains after trying, report the exact blocker to the
    coordinator rather than exempting the PR from the gate.
- I already posted one PR comment (https://github.com/motioneso/moss/pull/1892#issuecomment-5387478473)
  wrongly declaring this out of scope — leave it, just add the real evidence as a new comment when
  you have it, don't delete/edit the old one.

## What I found about the harness (read before doing anything else)

This repo has exactly the right tool for this: **scripted-chat UAT specs** run a REAL browser
against a REAL, freshly-provisioned, isolated instance (own DB/project), driving a REAL chat turn
through the REAL MCP gateway — but the assistant's tool-call decision is scripted (deterministic
fixture), not LLM-inferred, so it's fast and reliable while still exercising the real
`notesSearchExecute` -> real embedding provider -> real gateway -> real classifier path end to end.

- Runner: `pnpm test:uat -- <spec-filename-or-glob>` -> `tests/uat/run-uat.ts` ->
  `provisionForUat()` (`tests/uat/provisioner.ts`) spins up the isolated instance and DB, runs
  Playwright, tears down after.
- Spec pattern to copy: `tests/uat/specs/1252-audit-truth-livepath.uat.spec.ts` — read it in full,
  it is the closest precedent (real chat turn -> real tool call that fails -> assert on the
  chat reply text AND on `/api/ai/action-audit` AND on the Activity pane UI). Note
  `withoutNewsJsonBinding: true` is load-bearing for `admin+data` level (see that spec's header
  comment) or chat has no usable model and Enter never sends.
- `uatLevel` export controls seeding: `{ level, without, withoutNewsJsonBinding?, chatScript? }`
  (`tests/uat/seed/types.ts`).
- `chatScript` is an id into `UAT_CHAT_SCRIPTS` (`tests/uat/seed/types.ts` line ~47) — each id
  needs a fixture JSON at `tests/uat/fixtures/chat-scripts/<id>.json` (check that directory for
  the existing fixture format before writing a new one) plus the id added to the
  `UatChatScript` union and `UAT_CHAT_SCRIPTS` array in `types.ts`. The scripted provider fixture
  makes the "assistant" deterministically call a named tool with named args — copy an existing
  fixture's shape exactly.
- Notes' search tool: `packages/notes/src/tools.ts` `notesSearchExecute` — calls
  `getEmbeddingProviderConfig()` then `createEmbeddingProvider()`
  (`packages/memory/src/embedding-provider-config.ts`). Only two kinds exist: `"local"`
  (`LocalEmbeddingProvider`, real `@huggingface/transformers` model load/download — a real network
  fetch on first use if the model isn't cached) and `"stub"` (fake vector, no network — gated
  OFF outside tests unless `JARVIS_ALLOW_STUB_EMBEDDINGS=1` or `NODE_ENV=test`/`VITEST=true`, see
  that file's #1313 comment — do not fight this gate, it exists on purpose).

## Next steps — how to actually trigger a REAL dependency failure deterministically

To hit the classifier's `upstream_connection_refused` path live (matching the unit test's
`ECONNREFUSED` case) without flaky reliance on an actual broken host:

1. Point the embedding provider at an address that will refuse the connection instantly and
   deterministically. `@huggingface/transformers` reads `HF_ENDPOINT` / `HF_HUB_OFFLINE`-style env
   vars for where it fetches models from — check its actual env var names in
   `node_modules/@huggingface/transformers` (or its docs) before assuming `HF_ENDPOINT` is right.
   Setting it to `http://127.0.0.1:1` (a port nothing listens on) before starting the isolated
   instance's API process should make the first `notes.search` call's model load throw a real
   `fetch failed` / `ECONNREFUSED`, landing exactly in `classifyToolDependencyFailure`
   (`packages/ai/src/gateway/dependency-failure.ts`).
   - Verify this experimentally first with a quick manual `pnpm dev:api` + curl-less check (or a
     tiny throwaway script) before wiring it into a UAT spec, so you're not debugging two unknowns
     (harness plumbing + env var name) at once.
   - Only do this on the ISOLATED instance's env, never on the always-on main dev instance.
2. Write `tests/uat/fixtures/chat-scripts/1883-vault-search-dependency-failure.json` (copy the
   shape of whatever the `1252-audit-truth-livepath` fixture ships — find it under that same
   directory) scripting the assistant to call `notes.search` with some query.
3. Add `"1883-vault-search-dependency-failure"` to `UatChatScript` and `UAT_CHAT_SCRIPTS` in
   `tests/uat/seed/types.ts`.
4. Write `tests/uat/specs/1883-vault-search-dependency-failure.uat.spec.ts` modeled on the #1252
   spec: sign in, send a chat message that triggers `notes.search`, assert the chat reply (or the
   `/api/ai/action-audit` row, whichever surfaces the text) contains the classified cause text
   (e.g. `upstream_connection_refused`), not a raw/leaked message.
5. Run it: `( pnpm test:uat -- 1883-vault-search-dependency-failure > /tmp/uat-1883.log 2>&1; echo "### FINAL rc=$?" >> /tmp/uat-1883.log ) &` then a bounded wait loop on the sentinel — never pipe,
   never poll in-context (Monitor tool with an until-loop, or `run_in_background` + notification).
6. Whatever the actual outcome (pass, fail, or a concrete blocker like "the HF env var doesn't
   exist / model already cached so no fetch happens / provisioner has no hook for custom env
   vars"), post it as a new PR comment on #1892 with the exact command, exit code, and the
   relevant bounded log/assertion excerpt. If genuinely blocked after a real attempt, report the
   EXACT blocker (command tried, exact error) to the coordinator instead of quietly giving up or
   re-declaring it out of scope.

## Reminders from CLAUDE.md / boot brief

- Plain English in all chat/status/handoff text — no jargon, no coined shorthand.
- Own MCP transport + gateway path + focused tests/UAT for this issue only. Don't touch unrelated
  areas.
- Do not merge, do not touch project/coordination files. Don't revert others' edits.
- Sign every coordinator message with your pane id, resolved fresh each time via `herdr agent list`.
- Shared checkout: never `git add -A`/bare commit; commit by explicit path; diff-check any
  co-edited file before committing (see `shared-checkout` skill).
- Gate discipline: isolated DB per run (drop+create), never piped, sentinel-based (see
  `verify-gate` skill).
- This is a NEW, second live-path task layered on an already-closed build task — if it also grows
  past one context window, checkpoint again with a fresh handoff rather than pushing through on a
  compacted transcript.

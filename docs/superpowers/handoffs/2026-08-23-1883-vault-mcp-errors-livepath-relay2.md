# Relay 2: #1883 vault-search MCP error detail — live-path proof, build phase

Branch/worktree: `build/1883-vault-mcp-errors`, this worktree (unchanged — stay here).
Coordinator: agent name `coordinator` (re-resolve via `herdr agent list` before messaging — pane
id drifts, currently `w1:pQ4` but do not trust that number, re-resolve fresh).
My name in `herdr agent list` was `build-1883-livepath` — you are its successor; register/keep
that identity if the harness lets you, otherwise just sign messages with your own current pane id.

## State: research done, coordinator has RULED on the design, zero files edited yet

PR: https://github.com/motioneso/moss/pull/1892 — DO NOT MERGE. Fix already shipped and gate
green on this branch (see `docs/superpowers/handoffs/2026-08-23-1883-vault-mcp-errors-livepath-relay.md`
for that history — read it too, it has the original ask and the harness orientation, still
accurate). This doc only adds what changed since: the coordinator's exact design ruling and the
facts I verified that led to it.

**I found the first relay's plan was based on a wrong guess** (an env var called something like
`HF_ENDPOINT` that does not exist for this JS library) and escalated instead of building on a bad
premise. The coordinator answered with a concrete design. Nothing has been built yet — you are
building it now.

## Coordinator's ruling (verbatim, received directly, not summarized)

> DESIGN DECISION: use option 3, test-only. Reuse the new chatScript ID as the opt-in signal in
> writeUatEnvFile. Only for that script set JARVIS_EMBED_PROVIDER=local and
> NODE_OPTIONS=--import=/app/tests/uat/fixtures/embedding-refused.mjs. The preload fixture must
> only set Transformers env.remoteHost to http://127.0.0.1:65534/. Do not use port 1 because Node
> Fetch rejects it as a forbidden bad port rather than producing ECONNREFUSED. Extend the
> scripted-provider call schema with one exact expectedError string because it currently aborts on
> every MCP isError. Require exact equality to Tool notes.search failed
> (upstream_connection_refused), never log or echo the received payload dynamically, then emit a
> fixed safe reply and assert that reply in the browser. Scope is UAT provisioner, preload fixture,
> chat fixture registry/schema/runner, and one UAT spec only. No production config or product code.
> Fallback only if this exact preload fails: UAT-only internal Compose network, not a product env
> var. Continue and post bounded proof to PR 1892.

Treat this as approved — do not re-litigate it or ask again. Build it. Only escalate again if the
NODE_OPTIONS preload demonstrably fails in a real container run (see fallback clause above).

## Facts I verified experimentally (throwaway scripts, already deleted, not committed)

- `HF_ENDPOINT` / `HF_HUB_OFFLINE` env vars do nothing for `@huggingface/transformers` (the JS
  library, version 3.8.1 here) — those are Python-package conventions. Confirmed by printing
  `env.remoteHost` after setting them: unchanged from the hardcoded default
  (`https://huggingface.co/`).
- Setting the JS library's own config object property `env.remoteHost` (imported as
  `import { env } from "@huggingface/transformers"`) DOES redirect the real fetch. Confirmed by
  pointing it at `http://127.0.0.1:1/` (got `Error: bad port` — Node's fetch/undici blocks certain
  low ports outright, no network attempt at all) and then at `http://127.0.0.1:39999/` (got the
  real thing: `TypeError: fetch failed` with `.cause` = `Error: connect ECONNREFUSED
  127.0.0.1:39999` and `.cause.code === "ECONNREFUSED"`) — this is the EXACT shape
  `classifyToolDependencyFailure` (`packages/ai/src/gateway/dependency-failure.ts`) turns into
  `upstream_connection_refused`, and the exact shape the shipped unit test
  (`tests/unit/mcp-gateway-dependency-errors.test.ts`, "classifies a connection-refused cause")
  already covers synthetically. Coordinator's ruling uses port `65534` instead of my `39999` —
  either works, use the coordinator's number.
- The real error text a failed `notes.search` call returns over MCP is
  `Tool notes.search failed (upstream_connection_refused)` — read directly from
  `packages/chat/src/mcp-transport.ts` `gatewayResponseToMcp()`: on failure it returns
  `{ content: [{ type: "text", text: res.error }], isError: true }`, and `res.error` is exactly
  that string per the already-shipped gateway code.
- The Docker image already sets `HF_HOME=/app/.cache/huggingface` (Dockerfile) but nothing in
  `packages/memory` reads `HF_HOME` — it's consumed elsewhere (`scripts/start-jarv1s.ts` line ~84,
  unrelated to this task). Not a blocker, just don't assume it affects `env.remoteHost` or
  `env.cacheDir` — it doesn't, by inspection.
- Confirmed `notesSearchExecute` (`packages/notes/src/tools.ts`) calls
  `getEmbeddingProviderConfig()` then `createEmbeddingProvider()` — with
  `JARVIS_EMBED_PROVIDER=local` (not the UAT default `"stub"`), it instantiates
  `LocalEmbeddingProvider` (`packages/memory/src/local-embedding-provider.ts`), which on first use
  calls `pipeline("feature-extraction", modelId)` from `@huggingface/transformers` — the exact call
  that respects `env.remoteHost`.
- The container runs `node_modules/.bin/tsx scripts/start-jarv1s.ts` (Dockerfile `CMD`).
  `NODE_OPTIONS` is read by the Node process itself before any loader (including tsx's) runs, so a
  plain `.mjs` file needs no TypeScript transform — write it as plain ESM JS, not `.ts`.

## What to actually build (exact files, exact scope)

All in this worktree, no product code:

1. **`tests/uat/provisioner.ts`**, function `writeUatEnvFile` (~line 183-267). Currently line 234
   unconditionally writes `"JARVIS_EMBED_PROVIDER=stub"` plus the stub-allow line right after. Make
   both conditional: when `input.chatScript === "1883-vault-search-dependency-failure"`, write
   `JARVIS_EMBED_PROVIDER=local` and `NODE_OPTIONS=--import=/app/tests/uat/fixtures/embedding-refused.mjs`
   instead of the stub lines (skip `JARVIS_ALLOW_STUB_EMBEDDINGS=1` too — not needed for `local`).
   For every other case, keep exactly the current stub lines unchanged (do not regress the `bare`
   level's whole reason for defaulting to stub — see the existing comment at that line). Do not
   write both stub and local lines together; only one embed-provider line should ever land in the
   file. Follow the file's existing pattern of an inline comment citing #1883 explaining why, same
   style as the neighboring `#1121`/`#1306` comments already there.

2. **New file `tests/uat/fixtures/embedding-refused.mjs`** (plain ESM, no TypeScript):
   ```js
   import { env } from "@huggingface/transformers";
   env.remoteHost = "http://127.0.0.1:65534/";
   ```
   Add a short header comment (2-4 lines) explaining it's UAT-only, loaded via NODE_OPTIONS only
   when chatScript is `1883-vault-search-dependency-failure`, and why port 65534 not port 1 (bad-port
   block, verified). Never reference this file from product code.

3. **`tests/uat/fixtures/scripted-provider/script-schema.ts`**:
   - Add `readonly expectedError?: string;` to `ChatScriptCall` (after `captures`).
   - Add `"expectedError"` to `KNOWN_CALL_KEYS`.
   - Validate: if `c.expectedError !== undefined`, require `typeof c.expectedError === "string" && c.expectedError.length > 0`, else `fail(id, ...)` same pattern as the other field checks.
   - Check `script-schema.test.ts` for the existing test pattern and add one or two cases (valid
     `expectedError`, and a rejected invalid one) — keep it small, mirror existing test shape.

4. **`tests/uat/fixtures/scripted-provider/claude-main.ts`**, inside the `for (const call of
   turn.calls...)` loop (~line 207-233):
   - After getting `callBody` and `result` (line 224), branch on `call.expectedError`:
     - If **not set**: keep exactly the current behavior (`if (result?.isError) fail(...)`).
     - If **set**: 
       - If `result?.isError !== true` → `fail(scriptId, effectiveTurnIndex, "expected-error-but-succeeded")` (regression guard — don't silently pass if the dependency failure stops happening).
       - Read the text out safely (`(result as any)?.content?.[0]?.text`, matching the real shape from `packages/chat/src/mcp-transport.ts`) and compare with **exact string equality** to `call.expectedError`.
       - On mismatch: `fail(scriptId, effectiveTurnIndex, "expected-error-mismatch")` — **do not** include the actual received text in that failure class string or log it anywhere (this file's own header comment already states the never-leak rule; keep following it).
       - On match: fall through to the rest of the loop body as normal (captures extraction, `toolActivityRecords.push`) — do NOT call `fail` for this call.
   - Check `session-state.test.ts` / `launch-args.test.ts` aren't affected; if there's a
     `claude-main`-level test file, extend it minimally for the new branch, otherwise skip (I did
     not find one when I looked — only the three `.test.ts` files listed under
     `tests/uat/fixtures/scripted-provider/`, none named `claude-main.test.ts`; verify this is still
     true before assuming no test coverage is needed there).

5. **`tests/uat/seed/types.ts`**: add `"1883-vault-search-dependency-failure"` to both the
   `UatChatScript` union type and the `UAT_CHAT_SCRIPTS` array (follow the existing four-entry
   pattern exactly, same file, ~line 40-53).

6. **New file `tests/uat/fixtures/chat-scripts/1883-vault-search-dependency-failure.json`**, copy
   the shape of `1252-audit-truth-livepath.json` exactly:
   ```json
   {
     "version": 1,
     "turns": [
       {
         "expectIncludes": ["<some unique marker text, e.g. UAT-1883-VAULT-SEARCH>"],
         "calls": [
           {
             "tool": "notes.search",
             "arguments": { "query": "<anything>" },
             "expectedError": "Tool notes.search failed (upstream_connection_refused)"
           }
         ],
         "reply": "<a fixed, safe reply string, e.g. \"I couldn't search your notes right now — that service looks unavailable.\">"
       }
     ]
   }
   ```
   Pick your own exact reply text; it just has to be a plain fixed string the spec then asserts is
   visible in the chat transcript, and it must never contain the raw error detail.

7. **New file `tests/uat/specs/1883-vault-search-dependency-failure.uat.spec.ts`**, modeled closely
   on `tests/uat/specs/1252-audit-truth-livepath.uat.spec.ts` (read it in full again — it's short).
   `uatLevel` export: `{ level: "admin+data", without: [], withoutNewsJsonBinding: true, chatScript:
   "1883-vault-search-dependency-failure" }` (the `withoutNewsJsonBinding: true` is load-bearing per
   that spec's own header comment — copy the same reasoning into a comment here). Steps: sign in →
   open chat → send the message containing your `expectIncludes` marker → assert the fixed reply
   text becomes visible in the transcript → assert the raw MCP error text
   (`upstream_connection_refused` string or "ECONNREFUSED"/"fetch failed") is **not** present
   anywhere in the visible chat DOM (a real secrets-never-leak check, not just "did the nice message
   show"). **Before writing the audit-log assertion, read `packages/ai/src/gateway/gateway.ts`** to
   find what field name (e.g. `errorClass`) the dependency-failure path actually writes into the
   action-audit row (the #1252 spec's `errorClass === "module_reported"` is a DIFFERENT, unrelated
   code path — do not reuse that literal value; find the real one this fix's own code writes, or
   its own unit test file `tests/unit/mcp-gateway-dependency-errors.test.ts` may show it). Then poll
   `/api/ai/action-audit` for a `notes.search` row with that classification, same pattern as the
   #1252 spec's `fetchAuditLog` + `expect.poll`.

## Running it

```
( pnpm test:uat -- 1883-vault-search-dependency-failure > /tmp/uat-1883.log 2>&1; echo "### FINAL rc=$?" >> /tmp/uat-1883.log ) &
```
then a bounded wait (Monitor tool with an until-loop on the sentinel line, or `run_in_background` +
notification) — never pipe, never poll in-context. Read `/tmp/uat-1883.log` bounded (tail/grep), not
whole.

If the `NODE_OPTIONS` preload does not actually intercept the fetch (e.g. the container's `tsx`
invocation somehow doesn't inherit env, or `--import` of a bare-specifier-importing `.mjs` fails to
resolve `@huggingface/transformers` from that path) — that is the ONE case where you may deviate
from the ruling, per its own fallback clause: switch to cutting the UAT-only isolated instance's
own Docker network for this one run (compose-level, provisioner-only, never a product env var,
never touching any other running stack). Report exactly what failed to the coordinator before
switching, don't just silently pivot.

## Before pushing

`pnpm format:check && pnpm lint && pnpm typecheck`, then `git fetch origin main && git rebase
origin/main`, per the pre-push trio. Full gate (`pnpm verify:foundation`) only via the
`verify-gate` skill, isolated DB, never piped.

## Wrap-up

Use `coordinated-wrap-up` when done: push, confirm PR #1892 still open and this branch's commits
land on it, post the live-path proof as a **new** `gh pr comment` on #1892 (command, exit code,
bounded log/DOM excerpt) — do not edit or delete the earlier wrong comment
(https://github.com/motioneso/moss/pull/1892#issuecomment-5387478473), just add a new one. Report
the PR + proof (or the exact blocker) to agent `coordinator` (re-resolve pane fresh via
`herdr agent list`, sign with your own pane id) via the `herdr-pane-message` skill. Do not merge, do
not touch `docs/coordination/`, do not move the board.

## Reminders

- Plain English in all chat/status/handoff text — no jargon, no coined shorthand. This applies to
  every message you send, not just this doc.
- Commit only the exact paths listed above (shared checkout — use the `shared-checkout` skill
  before any commit; do not `git add -A`).
- If you also cross ~70% context before finishing, checkpoint again the same way: short handoff
  doc under this same `docs/superpowers/handoffs/` prefix, no pasted transcripts, then hand off.

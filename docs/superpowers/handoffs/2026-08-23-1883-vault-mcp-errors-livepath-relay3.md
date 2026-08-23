# Relay 3: #1883 vault-search MCP error detail — live-path proof, all code built, first run failed

Branch/worktree: `build/1883-vault-mcp-errors`, this worktree (unchanged — stay here).
Coordinator: agent name `coordinator` (re-resolve via `herdr agent list` before messaging — its
underlying session changed mid-run once already, the name is durable, the pane is not).
My name in `herdr agent list` was `build-1883-livepath2` — you are its successor.

Read `docs/superpowers/handoffs/2026-08-23-1883-vault-mcp-errors-livepath-relay2.md` in full first —
it has the coordinator's original design ruling (verbatim) and the exact file-by-file build list.
This doc only adds what changed since: everything in that list is built and committed, one real
test run happened and failed, and the coordinator separately ruled on a premise problem I found
(see below) — that ruling is already applied in the committed code, do not re-litigate it.

## What's already done (all committed on this branch, clean tree)

1. `tests/uat/provisioner.ts` — `writeUatEnvFile` now writes `JARVIS_EMBED_PROVIDER=local` +
   `NODE_OPTIONS=--import=/app/tests/uat/fixtures/embedding-refused.mjs` only when
   `chatScript === "1883-vault-search-dependency-failure"`, stub lines unchanged otherwise.
2. `tests/uat/fixtures/embedding-refused.mjs` — new file, sets `env.remoteHost` to
   `http://127.0.0.1:65534/`.
3. `tests/uat/fixtures/scripted-provider/script-schema.ts` (+ its test file) — new optional
   `expectedError` field on a chat-script call.
4. `tests/uat/fixtures/scripted-provider/claude-main.ts` — the call loop now branches on
   `expectedError`: requires the MCP call to fail and the returned text to match exactly, never
   logs the received text.
5. `tests/uat/seed/types.ts` — new chat-script id `1883-vault-search-dependency-failure` registered.
6. `tests/uat/fixtures/chat-scripts/1883-vault-search-dependency-failure.json` — new fixture, one
   `notes.search` call with `expectedError: "Tool notes.search failed (upstream_connection_refused)"`.
7. `tests/uat/specs/1883-vault-search-dependency-failure.uat.spec.ts` — new spec: sign in, ask the
   assistant to search notes, check the fixed safe reply shows up, check none of
   `upstream_connection_refused` / `ECONNREFUSED` / `fetch failed` / `127.0.0.1:65534` appear
   anywhere in the visible chat page text.
8. `.claude/skills/coordinate/uat-trigger-map.tsv` — two new blocking rows pointing at this spec.

Pre-push trio (`pnpm format:check`, `pnpm lint`, `pnpm typecheck`) all passed clean on this code
before the run below. Not yet rebased onto `origin/main` — do that before you push.

## A premise in the original plan was wrong — already found and ruled on, don't reopen

The relay-2 plan (item 7) said to poll `/api/ai/action-audit` for a `notes.search` row and check its
error classification. I read `packages/ai/src/gateway/gateway.ts` closely: a read-risk tool (which
`notes.search` is) never gets an audit row written at all on the normal chat call path — the audit-
recording call only runs when the tool's risk is not read, guarded by an explicit check right before
it. I checked every other place an audit row gets written in that file and none of them cover a
plain read-tool call either. So that poll could never succeed, pass or fail, regardless of whether
the underlying fix works.

I raised this with the coordinator before writing the spec. The ruling, received directly: **drop
the action-audit assertion. Do not add product logging, production behavior, or a test-only audit
seam just to satisfy the original plan.** Finish the UAT with only the chat-transcript proof (safe
reply visible, raw error text absent), and record that read tools are not audited — both are already
done in the committed spec file's own header comment and in commit `9d8fa7a3e`'s message. Treat this
as settled; only reopen it if you find NEW evidence it's wrong, not because it's an unusual shape.

## The one real run so far: failed, cause not yet found

```
( pnpm test:uat -- 1883-vault-search-dependency-failure > /tmp/uat-1883.log 2>&1; echo "### FINAL rc=$?" >> /tmp/uat-1883.log ) &
```

Result: the whole stack came up fine (postgres healthy, moss container healthy, UAT admin seeded,
reachable at `http://127.0.0.1:20000`), Playwright launched the one spec, but the very first
assertion after sending the chat message — waiting for the assistant's fixed safe reply text to
become visible — timed out after 60 seconds with no reply ever appearing. No exception or crash
elsewhere in the run's own console output; the container was already torn down (compose `down`
runs automatically at the end of `pnpm test:uat`) by the time I went looking for its logs, so I
never got to see what the app process itself said internally. I have NOT confirmed the login step
or the "open chat" step worked — the failure is reported on the very next step after those, so
they may have passed, or one of them may have silently done nothing (Playwright would still fail
at the next explicit assertion either way).

My best untested guess, not a finding: the Docker image sets `HF_HOME=/app/.cache/huggingface`
(Dockerfile) and may have the embedding model already pre-downloaded into the image at build time.
If so, the local embedding provider's first `pipeline()` call could find everything it needs in the
local cache and never touch the network at all — meaning `env.remoteHost` never gets consulted,
`notes.search` just succeeds (or returns an empty result) instead of failing, the scripted provider
sees `expectedError` set but the MCP call did NOT fail, throws `expected-error-but-succeeded`
inside the container's fixture script — and since the real chat engine only watches the transcript
file and never inspects the scripted CLI's exit code (see `claude-main.ts`'s own header comment),
a crashed scripted provider produces silence, not a visible error, which is exactly a 60-second
timeout with nothing more entertaining in the outer log. This is a guess — verify it, don't build on
top of it uncritically.

## What to actually do next

1. Re-run the same command, but this time keep the container alive long enough to inspect it, or
   capture its logs before teardown — e.g. run the compose stack directly rather than through
   `pnpm test:uat`'s full lifecycle, or add a temporary breakpoint/sleep before the script's
   `docker compose down` call so you can `docker logs <container>` and check
   `/data/cli-auth/uat-scripted-provider-failures.log` /
   `/data/cli-auth/uat-scripted-provider-success.log` inside it (paths are exported as
   `FAILURE_LOG_PATH` / `SUCCESS_LOG_PATH` from `claude-main.ts`) before it disappears.
2. If the guess above is right (cache pre-population skips the network entirely): the port-65534
   preload approach can't work as designed against this image, which is exactly the ONE case the
   relay-2 plan's own fallback clause covers — "switch to cutting the UAT-only isolated instance's
   own Docker network for this one run (compose-level, provisioner-only, never a product env var,
   never touching any other running stack)." Report the confirmed cause to the coordinator before
   switching, same as before — don't silently pivot.
3. If the guess is wrong, the real cause is something else in the login/open-chat/send-message path
   — trace it from there; don't assume it's the embedding provider without checking.
4. Once the spec passes for real: `pnpm format:check && pnpm lint && pnpm typecheck`, then
   `git fetch origin main && git rebase origin/main`, then use `coordinated-wrap-up` — push, open
   or confirm PR #1892 still open with this branch's commits on it, post a new `gh pr comment` with
   the live-path proof (command, exit code, and the specific pass output — do not edit the earlier
   wrong comment at
   https://github.com/motioneso/moss/pull/1892#issuecomment-5387478473), then report to `coordinator`.

## Reminders

- Plain English in every message you send, no jargon, no coined shorthand — this applies to every
  agent you spawn too, not just this session.
- Shared checkout: use the `shared-checkout` skill before any commit; commit only files you touched,
  never `git add -A`.
- Do not merge, do not touch `docs/coordination/`, do not move the board — the coordinator owns
  those.
- If you also hit the context relay trigger before finishing, checkpoint the same way: a short
  handoff doc under this same prefix, no pasted transcripts, then hand off.

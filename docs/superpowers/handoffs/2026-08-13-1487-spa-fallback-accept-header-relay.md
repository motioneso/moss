# Relay — #1487 SPA fallback Accept header

**Issue:** #1487. **Branch/worktree:** `1487-spa-fallback-accept-header` (this worktree, unchanged).
**Handoff doc (source of truth for scope):**
`docs/coordination/handoffs/2026-08-13-1487-spa-fallback-accept-header.md` — read it on the
`coord/overnight-20260810` branch if it 404s here:
`git show 6c3dbac25:docs/coordination/handoffs/2026-08-13-1487-spa-fallback-accept-header.md`
(it hasn't merged into this branch's history). This lane **skips plan-approval** — build directly,
no coordinator plan gate.

**Coordinator:** label `Coordinator`, session id `caef4e32-df22-4310-a42d-866771a0ba6c`. Resolve
fresh via `herdr pane list` — never trust a `…-N` number.

## Done (all committed, tree clean)

1. `180b784c1` — test(api): added 2 regression tests to `tests/unit/api-static-web.test.ts`:
   no-Accept `GET /` expects 200 index; `Accept: application/json` `GET /settings` expects 404.
2. `d4bd49315` — fix(api): `apps/api/src/static-web.ts` — SPA fallback now serves when
   `accept === "" || accept.includes("text/html") || accept.includes("*/*")` (was: required
   `text/html` literally).
3. `39ad3b82b` — docs(web): simplified the now-stale workaround comment in
   `apps/web/public/service-worker.js` (optional fast-follow from the handoff, done).
4. **Full gate green** on isolated DB `jarvis_gate_1487spa` (dropped after use — recreate fresh,
   don't reuse). First run hit an unrelated flake: `tests/unit/chat-drawer-surface.test.tsx` "resets
   state on a flip in both directions" (#1533, act() warning) — passed standalone, passed clean on
   the full re-run. Not caused by this branch; nothing here touches that file. If it recurs, it's a
   known flake, not a regression from this fix.

## Left to do

1. **Live-path proof** (blocking exit criteria) — no live dev API instance is currently running for
   this repo (checked: port 3000 free, port 3001 is an unrelated container `dawarich_app`, port 5173
   is a different worktree's Vite). Need to:
   - `pnpm build:web` (produces `apps/web/dist/index.html` — required, `registerStaticWeb` no-ops
     without it).
   - Start the API against the **shared dev Postgres** (`jarv1s-postgres`, db `jarv1s`, `:55433`) on
     a **non-default port** to avoid colliding with any other lane that spins up `:3000` —
     see `[[dev-instance-lan-spinup-trusted-origins]]` memory for the trusted-origins trap if auth
     matters (it doesn't for this test — no login needed, just static routing). Leave
     `JARVIS_CLI_RUNNER_SOCKET`/`_RPC_SECRET` and `NODE_ENV` **unset** (see
     `[[host-dev-install-seam-env-pair]]` memory — half-set socket crashes boot, `NODE_ENV` breaks
     decryption; neither matters for this test but don't trip them).
   - Two bounded curls once it's up:
     - `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:<port>/` (no Accept header) →
       expect `200`.
     - `curl -s -o /dev/null -w '%{http_code}\n' -H 'Accept: application/json'
       http://localhost:<port>/settings` (or any non-asset, non-api path) → expect `404`.
   - **Tear down the API process by explicit PID** when done (`[[prod-worker-looks-like-a-dev-orphan-in-ps]]`
     — never kill by name pattern, other lanes share this box).
   - Record both curl results as a `gh pr comment` on the PR (open the PR first — see next item).
2. **Pre-push trio + rebase** (not yet run this session): `pnpm format:check && pnpm lint &&
   pnpm typecheck`, then `git fetch origin main && git rebase origin/main`. (Format/lint/typecheck
   were confirmed green earlier this session against the pre-relay commit set — re-run quickly to
   be safe, they're cheap.)
3. **Push + open PR** (`gh pr create`), title referencing #1487, body summarizing the fix + linking
   the two new tests. Post the live-path curl proof as a `gh pr comment`.
4. **`coordinated-wrap-up`** — report the PR + verified evidence to the coordinator. Do not merge,
   do not touch the board — that's the coordinator's.

## Scope reminder

Touched files only: `apps/api/src/static-web.ts`, `tests/unit/api-static-web.test.ts`,
`apps/web/public/service-worker.js`. Nothing else in scope. If tempted toward option (i) — dropping
the `Accept` check entirely — **stop**, that's explicitly out of scope per the handoff (loses clean
404 for API-ish clients); only option (ii) (already built) is cleared.

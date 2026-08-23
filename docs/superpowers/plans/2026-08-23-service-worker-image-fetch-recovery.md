# Plan: #1872 — Service Worker image fetch recovery

Spec: `docs/superpowers/specs/2026-08-23-service-worker-image-fetch-recovery.md` (approved by Ben
2026-08-23). Issue: #1872 (`bug`, `task`, `sev:major`). Diagnosis confirmed on the issue
(comment 5384238958): deterministic sandbox repro of the rejected `respondWith()` promise.

## Seams check

Every capability this plan assumes, cited from the current tree (verified 2026-08-23, this
worktree):

- The defect: `apps/web/public/service-worker.js:48-50` — the generic GET branch is
  `event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)))`, no
  `.catch()`, no origin check. Any uncached GET whose `fetch()` rejects hands `respondWith()` a
  rejected promise. Confirmed by the issue's sandbox repro for both cross-origin and same-origin
  URLs.
- Only app-shell URLs are ever cached: `apps/web/public/service-worker.js:2` (`APP_SHELL_URLS`)
  and the install handler at lines 4-20 are the only `cache.put`/`addAll` calls. CDN images are
  therefore always on the uncached-fetch path.
- Offline navigation to preserve: `apps/web/public/service-worker.js:43-46` — `navigate` mode
  already has its own `.catch(() => caches.match("/offline.html"))`. This plan does not touch it.
- The Service Worker registers only in production builds:
  `apps/web/src/pwa/register-service-worker.ts:2` gates on `import.meta.env.PROD`. Consequence:
  the default Playwright config (`playwright.config.ts:20-25`, webServer = `vite dev` on :4173)
  can never exercise the registered SW. The browser regression check therefore needs a built app
  served by `vite preview` (Vite copies `apps/web/public/` into `dist/` root, so
  `/service-worker.js` is served).
- Unit tests: `tests/unit/` run by vitest via `scripts/test-unit.ts:10`
  (`DEFAULT_VITEST_ARGS = ["tests/unit"]`); a single file can be run as
  `pnpm test:unit tests/unit/<file>` (args replace the glob, `scripts/test-unit.ts:12-14`).
- No existing test anywhere references the service worker (grep over `tests/` for
  `service-worker|serviceWorker`: zero hits). Both tests below are net-new.
- Live-path config exists: `playwright.live.config.ts` (testDir `tests/live`, no webServer, no
  mocks) — but the live dev instance is `vite dev` on :5173, which never registers the SW (see
  PROD gate above). Live-path proof must run against a deployed-style (built) instance.
- Downstream has no recovery: `packages/sports/src/web/sports-parts.tsx` `<img>` tags carry no
  `onError`/retry (confirmed in the issue diagnosis). Recovery must come from the SW seam —
  which is what the spec locks anyway.

## Open questions

None blocking. One recorded assumption: the deployed instance at `https://jarvis.motioneso.com`
(or an equivalently built+served dev instance) is available for the live-path proof. If neither is
reachable when the build lands, the live-path step blocks the merge, not the code review.

## Determinism boundary

No AI/model involvement anywhere in this change. All behavior is deterministic Service Worker
code; the model has zero jobs here.

## Design decision — what the GET handler does instead

Chosen: keep intercepting all non-API GETs, add resilience at the one shared seam.

1. Cache hit: serve cached (unchanged).
2. Cache miss: `fetch(request)`. On rejection:
   - if `request.destination === "image"`: bounded retry — up to 2 further attempts with short
     fixed delays (250 ms, then 1000 ms). First success wins.
   - after retries exhaust, or for non-image requests immediately: resolve with
     `Response.error()`.
3. `respondWith()`'s promise never rejects for any GET, same-origin or cross-origin.

`Response.error()` is the browser's own "clean network failure" value: the page sees an ordinary
failed subresource (as if no SW existed), not an unhandled SW rejection, and nothing about it is
cached — the next render re-fetches through the retry path.

Steelmanned alternative, rejected: **stop intercepting cross-origin GETs entirely** (bail out
before `respondWith`, let the browser fetch natively). Genuinely simpler, and it would silence the
console error for CDN images — the strongest argument for it is that the SW adds zero value for
requests it will never cache. Rejected because (a) the spec locks covering *same-origin and*
cross-origin rejected uncached fetches, and same-origin GETs would still flow through the broken
branch; (b) it provides no recovery at all — a transient blip still leaves a permanently broken
`<img>`, failing the issue's "recover without a hard refresh" criterion, since the components have
no client-side retry; (c) the issue diagnosis explicitly established cross-origin interception is
not the defect — the missing resilience is.

Non-goals honored: no CSP change, no chat-stream change, no per-surface retry code, offline
navigation branch untouched.

## Task 1 — fix the generic GET branch in the Service Worker

File: `apps/web/public/service-worker.js`, lines 48-50 only.

Decisions (bodies get written against the real runtime):

- Extract the cache-miss fetch into a named helper in the same file, signature
  `fetchWithRecovery(request) -> Promise<Response>`, implementing the chosen design above.
- Retry constants live at top of file next to `CACHE_NAME`:
  `IMAGE_RETRY_DELAYS_MS = [250, 1000]`.
- Image detection is `request.destination === "image"` — the platform's own classification, no
  URL/extension sniffing.
- No new caching: this task adds zero `cache.put` calls. `CACHE_NAME` stays `jarv1s-shell-v1`
  (no cached-format change; the byte-diff on `service-worker.js` alone triggers the browser's SW
  update cycle).
- The `/api/` bail-out (line 39-41) and the `navigate` branch (line 43-46) are not modified.

## Task 2 — smallest deterministic regression test (unit seam)

File: `tests/unit/service-worker-fetch.test.ts` (net-new). Same seam as the issue's confirmed
repro: load the real `apps/web/public/service-worker.js` source into a `node:vm` sandbox
providing fake `self` (captures listeners), `caches`, `fetch`, `Response`, and `URL`; dispatch
the captured `fetch` listener with a synthetic event whose `respondWith` records the passed
promise.

Test cases — each stated as behavior plus why it fails against the broken implementation:

1. **Uncached cross-origin image GET, fetch always rejects** (`TypeError: NetworkError…`, the
   exact browser message): the promise passed to `respondWith` resolves (to an error Response) —
   it must not reject. *Red today: current code passes the bare rejection straight through; this
   is the issue's repro.*
2. **Uncached image GET, fetch rejects once then resolves**: `respondWith`'s promise resolves
   with the successful response, and the fake fetch was called more than once. *Red today: no
   retry exists, promise rejects on the first failure.*
3. **Uncached same-origin GET, fetch rejects**: promise resolves, never rejects. *Red today —
   and it pins the spec's same-origin requirement so a "just stop intercepting cross-origin"
   regression can't sneak back in.*
4. **Cached request**: served from cache, fake network fetch called zero times. *Guards existing
   behavior; goes red if the fix accidentally bypasses the cache.*
5. **Navigate-mode request whose fetch rejects**: resolves with the cached `/offline.html`
   entry. *Guards the offline app-shell invariant; red if Task 1 leaks into the navigate branch.*

Retry delays: the test runs with the real 250/1000 ms constants (worst case ~1.3 s in case 1) —
acceptable for one unit file; no timer mocking, no flake surface.

## Task 3 — agent-runnable browser regression check (registered SW)

The issue's first acceptance criterion requires the failure reproduced *through the registered
Service Worker* in a browser. Because registration is PROD-gated (seams check), this cannot ride
the default e2e config.

- New config `playwright.sw.config.ts` (root, alongside the existing two): testDir
  `tests/sw`, single chromium project, webServer command builds the web app then serves it —
  `pnpm --filter @moss/web build && pnpm --filter @moss/web exec vite preview --host 127.0.0.1 --port 4174`,
  baseURL `http://127.0.0.1:4174`. Port 4174 avoids colliding with the mocked e2e config's 4173.
- New spec `tests/sw/service-worker-image-recovery.spec.ts`. Inside the spec, start a tiny
  `node:http` helper on an ephemeral `127.0.0.1` port (different port ⇒ cross-origin, i.e. an
  "external" image) that destroys the socket on the **first** request to a path and serves a 1×1
  PNG on subsequent requests — a deterministic transient failure, no real network.
- Test cases:
  1. Load `/`, wait for `navigator.serviceWorker.ready` and a controlled page (reload once after
     ready, standard first-visit claim). Assert the SW controls the page — otherwise the check
     proves nothing.
  2. Inject an `<img>` pointing at the helper's flaky path. Assert the image reaches
     `complete && naturalWidth > 0` without any page reload (the SW's bounded retry absorbed the
     transient failure). *Red today: first fetch rejects, respondWith rejects, image stays
     broken.*
  3. Throughout, collect console messages; assert none contains `respondWith` /
     `FetchEvent … network error` rejection text. *Red today on the same trigger.*
- Run command (also the command a future agent runs):
  `pnpm exec playwright test --config playwright.sw.config.ts`.

## Task 4 — live-path proof (gate, recorded on the PR)

Per the Live-Path Gate and the issue's fourth criterion, on a deployed-style HTTPS/PWA instance
(the deployed `https://jarvis.motioneso.com` once the change ships there, or a built instance
served the same way on dev):

- Confirm the updated SW is active (DevTools → Application → Service Workers shows the new
  version controlling the page).
- Show at least one **article photo** (News/Today) and one **sports logo** (Sports) rendered,
  and the console free of `respondWith` rejection errors during normal navigation across Today,
  News, Sports.
- Offline check: DevTools offline mode, navigate — the offline app-shell page still appears.
- Record screenshots/console captures on the PR. Without this the PR's honest status is
  code-complete, unverified; it does not merge.

## Task 5 — release note

User-facing fix. PR template Release note section: Category **Fixed**, title along the lines of
"Photos and logos recover on their own", one plain-English sentence (no file paths, no jargon).
Then from the branch: `node scripts/append-release-note.mjs --pr <number>` and commit the
`docs/WHATS_NEW.md` change onto the same branch (merge-time automation was removed in #1795).

## Verification (unpiped, expected exit codes)

Run in this order; every command's exit code must survive:

```bash
pnpm test:unit tests/unit/service-worker-fetch.test.ts > /tmp/1872-unit.log 2>&1; echo "EXIT=$?"   # EXIT=0
pnpm exec playwright test --config playwright.sw.config.ts > /tmp/1872-sw.log 2>&1; echo "EXIT=$?"  # EXIT=0
pnpm test:e2e > /tmp/1872-e2e.log 2>&1; echo "EXIT=$?"                                              # EXIT=0 (existing suite unaffected)
pnpm verify:foundation > /tmp/1872-vf.log 2>&1; echo "EXIT=$?"                                      # EXIT=0
```

`verify:foundation` touches the live dev database — the builder must invoke the `verify-gate`
skill before running it, per CLAUDE.md. Known local red: `module-sdk-worker` tests fail locally
but are green in CI (recorded memory) — do not bisect over them.

Before any commit in a shared checkout, use the `shared-checkout` skill; never `git add -A`.

## Kill gate

Single-phase plan; the gate sits between green checks and merge. **Observation that ends the
line:** live-path proof (Task 4) shows images still requiring a hard refresh, or offline
navigation broken, despite Tasks 2-3 green — that would mean the shared-handler seam is
insufficient and the spec's escape hatch (per-surface fallback, explicitly a non-goal until
proven necessary) needs a new decision. **Call is Ben's**, routed through the coordinator; the
builder stops and reports rather than widening scope.

## Review checklist (plan-build)

- [x] Spec approved (`docs/superpowers/specs/2026-08-23-service-worker-image-fetch-recovery.md`) and task issue open (#1872)
- [x] Every assumed capability cited `file:line` above, or listed under Open questions
- [x] No function bodies — seam, signature, constants, and test cases only
- [x] Determinism boundary stated (no model involvement)
- [x] Browser-level test named per task (Tasks 3 and 4)
- [x] Verification commands unpiped with expected exit codes
- [x] Kill gate named with owner (Ben, via coordinator)
- [x] Rejected alternative steelmanned (stop intercepting cross-origin)

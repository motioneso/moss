# w5c-chat-surface relay 7 → 8 — 2026-08-10

**Issue:** #1254, lane C. **PR:** https://github.com/motioneso/moss/pull/1492 (open, NOT merged).
**Coordinator:** Codex session `019fe9e2-7fc6-7243-9894-d258562db9a6`, label `Coordinator`.
Re-resolve its pane fresh via `herdr pane list` before messaging (pane ids reflow) — do not reuse
any pane id from this doc.

**Task brief (unchanged, still the source of truth):**
`docs/coordination/boot-w5c-liveproof-relay4.txt` — read it in full. Scope: confirm prior
commits/gate, restage job-search module on a live dev instance, trigger `job-search.criteria.set`
through the real chat UI, screenshot the approval card (cropped), rebase+push, `gh pr comment`
1492 with the proof, teardown (exact PIDs, seeded rows), report to Coordinator. No merge, no board.

## State: code/gate done, live-proof not started, working tree clean, nothing to commit

Everything through relay 6 stands unchanged — see that doc
(`docs/superpowers/handoffs/2026-08-09-w5c-chat-surface-relay6.md`) for the full commit history and
gate result if needed, but you should NOT need to re-read it: this doc is a complete pointer.

Confirmed this relay (task #1/#2 from relay 6's list):
- `git log`: `98b3ce953` (actionLabel guard) sits clean on top of prior work, 3 commits ahead of
  `origin/w5c-chat-surface`, working tree fully clean (`git status --porcelain` empty).
- `gh pr view 1492`: OPEN, MERGEABLE, all CI checks SUCCESS.
- No live dev instance running for w5c-chat-surface specifically (checked `ps`/`ss -ltnp` across
  all worktree PIDs). Free port pair chosen: **API `:3099` / web `:5199`** (matches prior UAT
  precedent in `epic-1238-oneshot-engine-not-headless` memory).
- Job-search module **staged** (task #3, step 1 of 3) into `data/modules/job-search/` — copied
  `jarvis.module.json` (actionLabel confirmed present at line 80), `package.json`,
  `dist/worker.js`, `dist/web/**`, `sql/**` from `external-modules/job-search/`. This dir is
  gitignored — nothing to commit, don't look for it in `git status`. **Restage/re-enable (steps 2-3
  of 3) not done yet** — needs a running API to call
  `POST /api/admin/external-modules/job-search {"enabled": true}` then verify via `GET /api/modules`.

## What's actually blocking progress: env var research, not yet resolved

I was mid-investigation into what env vars a from-source dev instance needs for **real chat turns**
(not 503s) before starting `pnpm dev:api`/`pnpm dev:web`. Findings so far, to save you re-deriving:

- `apps/api/src/server.ts:151` reads plain `env.PORT ?? 3000` — **not** `JARVIS_API_PORT`. So set
  `PORT=3099` directly (not the Moss-shim name) when starting `apps/api`.
- `apps/web/vite.config.ts:12` hardcodes `port: 5173` in the config object — there's no env-var
  override wired in that file. To run on `:5199` you'll need `vite --port 5199` (CLI flag beats
  config) via `pnpm --filter @moss/web exec vite --host 0.0.0.0 --port 5199 --strictPort`, not the
  plain `pnpm dev:web` root script (which just runs `vite --host 0.0.0.0` on the hardcoded port).
- DB: do **not** set `JARVIS_PGHOST`/`JARVIS_PGPORT`/`JARVIS_PGDATABASE` — leaving them unset makes
  `getMossDatabaseUrls()` (`packages/db/src/urls.ts`) default correctly to the real shared dev DB
  `jarv1s` on `localhost:55433` with default-credentialed roles. Setting a non-default host/port
  without an explicit `*_DATABASE_URL` throws by design (#1383 guard) — don't fight this, don't set
  them.
- **Still unresolved — the actual next step:** whether the engine needs
  `JARVIS_CLI_RUNNER_SOCKET`+`JARVIS_CLI_RUNNER_RPC_SECRET` set (cli-runner RPC path,
  `packages/cli-runner/src/engine-host.ts`) or must be left UNSET (in-process
  `createRealEngineFactory`, `packages/chat/src/live/runtime.ts:184`, `selectEngineFactory`) for
  real chat turns to work on a plain from-source dev instance. Two memories read this relay seem to
  describe different topologies and were not yet reconciled:
  - `host-dev-install-seam-env-pair` — describes a specific non-standard install-seam deployment
    where chat 503s regardless (no cli-runner available there). Likely **not** the relevant case
    for a plain `pnpm dev:api`/`dev:web` source run.
  - `engine-selection-forks-at-the-rpc-seam` + `epic-1238-oneshot-engine-not-headless` — together
    imply that leaving `JARVIS_CLI_RUNNER_SOCKET` **unset** is correct for an ordinary source-run
    dev instance: it forces the in-process engine factory, which successfully ran live chat UATs
    before (headless one-shot engines: `claude -p`, `codex exec`) with no RPC pair needed.
  - **My working hypothesis, not yet verified**: leave both cli-runner vars UNSET. Verify this by
    checking `/proc/<pid>/environ` of a **currently running** sibling dev instance (e.g. the
    `w6a-secure-context` API process — find its pid fresh via `ps aux | grep dev:api`, don't trust
    any pid number from this doc, they're stale) to see whether it sets the cli-runner pair. That
    single check should resolve this — do it before spending more tokens re-reading the two memory
    files again.

## Also still needed before launch (not yet composed, from `dev-instance-lan-spinup-trusted-origins`)

- `JARVIS_AUTH_TRUSTED_ORIGINS` including `http://localhost:3099`, `http://localhost:5199`, and the
  LAN ip:5199 form (check that memory for the exact LAN-ip convention used elsewhere).
- A stable `BETTER_AUTH_SECRET`.
- `JARVIS_API_PROXY_TARGET=http://localhost:3099` for the web dev server to proxy `/api` correctly.
- `NODE_ENV` must stay **UNSET** (setting it breaks AES-256-GCM credential decryption per that
  memory).
- Ben's dev login credentials: check `dev-instance-lan-spinup-trusted-origins` memory for the exact
  email/password (recorded there, don't guess).

## Remaining tasks (unchanged shape from relay 6, still all open)

1. Resolve cli-runner env question (above), compose full env var set, start `apps/api`
   (`PORT=3099 ...`) and web (`vite --port 5199 ...`) **in the background**, record **exact PIDs**
   (required for teardown — never kill by name pattern, prod's worker looks like a dev orphan).
2. `POST /api/admin/external-modules/job-search {"enabled": true}`, verify via `GET /api/modules`
   (not `module_installs` row status).
3. Sign in as Ben's dev login, open job-search, trigger `job-search.criteria.set` through the real
   chat/onboarding UI, wait for the approval card with summary "Update your job search criteria".
4. Screenshot **cropped to the approval card only**, save to disk, view only the crop.
5. `git fetch origin main && git rebase origin/main && git push -u origin w5c-chat-surface`
6. `gh pr comment 1492 --body "<live-path proof narrative + screenshot>"`
7. Teardown: stop exact API/web PIDs, delete any seeded DB rows by recorded id (never TRUNCATE).
8. Report to Coordinator (`coordinated-wrap-up` step 4 format) — re-resolve pane fresh, re-verify
   session id `019fe9e2-7fc6-7243-9894-d258562db9a6` before sending. Then STOP.

## Relay trigger

Context hit 74% mid-investigation of the cli-runner env question, before any dev process was
started. Clean relay point — nothing running, nothing uncommitted, nothing mid-flight except the
one research question above.

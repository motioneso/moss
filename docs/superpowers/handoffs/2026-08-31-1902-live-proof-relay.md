# Relay — 1902 live-UI proof (relay 1 of this fresh assignment)

**Task:** issue #1902, PR #2101 is code-complete and CI-green. The only missing piece is the
live-UI proof required before merge: build a module with one chat tool through the real Workshop
chat flow on a live instance, then use that tool in the same chat session without restarting
anything, and post the proof as a PR comment.

**Worktree/branch:** this worktree (`resume-1902`), branch `resume/1902-live-proof`, tracking
`origin/1902-module-tools-live`. Tree is clean, up to date with origin. No code changes were made
this turn — this was pure research into how to run the proof safely.

**Coordinator:** agent name `coordinator` (currently a codex agent). Re-resolve with
`herdr agent list` before messaging — do not trust a pane number from this doc.

**Do NOT:**
- Reuse or depend on the old scratch worktree `.claude/worktrees/1902-module-tools-live` or its
  agent `pr2101-live-proof` (currently idle) — the coordinator explicitly said not to touch it.
  It looks like an earlier live-proof attempt that left a stray env var on the SHARED dev
  instance (see trap below) — do not repeat whatever it did.
- Touch `docs/coordination`, or run repo-wide formatting.
- Touch the shared dev instance at `http://192.168.50.36:5173` (API :3000 / web :5173, running
  from `~/Jarv1s` on branch `main`). Other lanes depend on it staying on `main`. Confirmed running:
  `pnpm dev:api` pid 1121269, `pnpm dev:web` pid 991459, worker `node dist/worker.js` pid 2015303.

**Trap found, not yet explained:** the shared instance's `dev:api` process (pid 1121269) already
has `JARVIS_CLI_RUNNER_RPC_SECRET=dev1902proofsecret` in its environment. That name strongly
suggests an earlier 1902 live-proof attempt injected it into the SHARED instance rather than an
isolated one. I did not change anything on that instance. Flag to the coordinator if it looks
like it's causing problems; otherwise leave it alone and build your own isolated instance instead
of extending that one.

## What the proof needs to look like

Read `docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md`, section "Live-path
proof" in `docs/superpowers/plans/2026-08-30-1902-module-tools-live.md`, and
`docs/DEVELOPMENT_STANDARDS.md` → "Live-Path Gate" (note: **no screenshots** — use executable
assertions or bounded text/log/DOM evidence instead).

The best template to copy is PR #1942's (issue #1890, "throw a draft away") live-path comment —
read it with `gh pr view 1942 --json comments -q '.comments[] | .body'`. That lane ran an
**isolated** dev instance from its own branch on non-standard ports (API :3010, web :5184),
against the same shared Postgres, real login `ben@ben.com` / `jarvistest123!`, and posted a
step-by-step comment: what was set up, what was clicked, what was checked afterward (DB row,
files on disk), and one honest note about a dev-server-only quirk that wasn't a real bug. Match
that shape and thoroughness for #1902 — but the button-clicking is different: you're building a
module with a chat tool, then using the tool.

## Key facts to build the isolated instance

- Postgres connection: no `JARVIS_PG*` env vars are set on the shared instance's processes —
  defaults already resolve to the shared dev Postgres (`jarv1s-postgres:55433`, db `jarv1s`,
  schema `app`). Leave `JARVIS_PG*` unset in your isolated instance too; it'll hit the same DB
  (that's expected and fine — same pattern PR #1942 used).
- Ports: API default is `PORT` env var (default 3000), web (Vite) default is 5173
  (`apps/web/vite.config.ts:12`). Pick non-colliding ports, e.g. API 3010 / web 5184 (same as
  #1942 used, so they're known-free by precedent — re-check with `ss -ltnp` before trusting that).
- Auth trap (memory: `dev-instance-lan-spinup-trusted-origins`): on non-standard ports, Better
  Auth rejects login unless the API is started with
  `JARVIS_AUTH_TRUSTED_ORIGINS="http://localhost:<apiPort>,http://<lan-ip>:<webPort>,http://localhost:<webPort>,http://localhost:3000"`
  and a stable `BETTER_AUTH_SECRET` (else sessions die every restart). The web dev server needs
  `JARVIS_API_PROXY_TARGET=http://localhost:<apiPort>` so its proxy rewrites the Origin header to
  something trusted.
- Module isolation: `JARVIS_MODULES_DIR` (read by `packages/module-registry/src/resolve-modules-dir.ts`)
  overrides where the server/worker scan for external modules — set it to a path inside this
  worktree (e.g. `<worktree>/data/modules-1902-proof`) so the module you build through chat does
  **not** land in the shared instance's real modules directory. `JARVIS_MODULE_BUILDS_DIR`
  similarly overrides where build sources live (`packages/module-registry/src/external/resolve-build-dir.ts`);
  it defaults to `<modulesDir>/../module-builds`, which will already be isolated if you set
  `JARVIS_MODULES_DIR`.
- The worker process must also run (module builds run as background jobs via the worker, and the
  worker also needs `JARVIS_MODULES_DIR` set to the SAME path as the API for discovery to line
  up). Start it from `apps/worker` the same way `dev:worker` (or equivalent script — check
  `package.json`) does, with the same env vars.
- There's an established `scripts/dev-instance/` toolkit (`config.ts`, `provision.ts`,
  `doctor.ts`, `fix.ts`, `cli-runner.ts`, `secrets.ts`, `signup.ts`) that looks purpose-built for
  standing up a dev instance including the chat cli-runner socket (needed for some chat-tool
  paths). **Read these first** before hand-rolling ports/env — they may already solve most of the
  above. Not yet read this session; do that before writing any ad hoc launch script.
- `scripts/redeploy-external-module.sh <module-id>` is the documented way to redeploy/reconcile an
  external module on a running instance (`docs/DEVELOPMENT_STANDARDS.md` → "Redeploying an
  external module on dev") — may or may not be relevant depending on whether Workshop's own build
  pipeline already handles install/enable for a freshly-built draft.

## The actual proof steps (once the isolated instance is up)

1. Log in as `ben@ben.com` / `jarvistest123!`.
2. In chat, ask Moss to build a small module with exactly one chat tool (keep it trivial — e.g.
   "build me a module with a chat tool that echoes back whatever text I give it").
3. Approve the plan card when it appears (or note if "stop asking me" is on and it skips straight
   to building).
4. Wait for the build to finish (Workshop page shows build state; it runs as a background job via
   the worker — this can take real wall-clock time since it's a real AI-driven build).
5. Without restarting the API or worker process, in the **same chat session**, ask the assistant
   to use the new tool. Confirm it appears in the tool list and executes with a real result.
6. Capture bounded evidence: exact chat exchange (tool call + result), and/or an API/worker log
   line showing the manifest getter picked up the new module without a restart (e.g. log the PID
   of the API process before and after to prove no restart happened).
7. Post the write-up as `gh pr comment 2101 --body "..."`, following #1942's comment shape.

## Teardown (before reporting done)

- Stop the isolated API/worker/web processes by the exact PIDs you started (never by name
  pattern — `dist/worker.js` also matches other lanes' processes).
- Delete the test module's DB rows and its module/build directories under your isolated
  `JARVIS_MODULES_DIR` — don't touch the shared instance's real `data/modules`.
- Leave the shared instance (`~/Jarv1s`, ports 3000/5173) exactly as you found it.

## Reporting

Report to the coordinator via `herdr-pane-message`, in plain English (no unexplained jargon —
box-wide rule, reaffirmed 2026-08-18), signed with your own pane id. State: proof posted (link),
gate status (already green from the prior lane — re-confirm nothing new needs gating unless you
changed code), branch pushed/up to date, teardown done. If you can't get a real build to complete
in reasonable time, say so honestly and report **code-complete, unverified** rather than faking
it — do not fabricate a tool call.

## Relay budget

If your own 70% context trigger fires again before the proof is posted, this counts as relay 1 of
this fresh assignment (the code-writing work already used its one relay in the old worktree,
tracked separately in `docs/superpowers/handoffs/2026-08-30-1902-module-tools-live-relay.md` — that
budget doesn't carry over to this new live-proof-only assignment). If you relay and your successor
also hits the trigger with no comment posted yet, stop relaying and report to the coordinator that
this slice needs to be re-scoped or handled by pairing with Ben directly.

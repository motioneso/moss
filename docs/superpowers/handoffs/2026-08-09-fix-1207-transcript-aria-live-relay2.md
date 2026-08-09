# Relay handoff #2 — fix-1207-transcript-aria-live

Third relay this run (context-meter hit critical again). Resume `coordinated-build` step 4
(live-path proof), then `coordinated-wrap-up` step 4 (report to coordinator). Read the prior
handoff first: `docs/superpowers/handoffs/2026-08-09-fix-1207-transcript-aria-live-relay.md` — its
"Done" section (code fix, regression test, plan doc, gate runs, UAT-trigger confirmation) is all
still accurate and not repeated here.

## State

- Worktree: `/home/ben/Jarv1s/.claude/worktrees/fix-1207-transcript-aria-live`, branch
  `fix-1207-transcript-aria-live`. Tree is clean except one **untracked, throwaway** file —
  `dom-proof-1207.mjs` at the worktree root — see "Live throwaway dev instance" below. Do not
  commit it; it's a one-off Playwright script, not part of the fix.
- **PR #1479 is OPEN**: https://github.com/motioneso/moss/pull/1479. No PR comment posted yet.
- Coordinator: agent name `coordinator-wave1-r6`, session id `f6461c25-9951-432c-9535-6fb497a92751`,
  label "Coordinator", pane `w1:p28`. Not yet messaged about this relay — **do that first**, then
  message again at the end per `coordinated-wrap-up` step 4.

## Live throwaway dev instance — already running, reuse it or tear it down

Standing up a fresh instance is NOT needed — one is already up on non-standard ports so it doesn't
collide with other sessions:

- API: pid `652358`, port `3210`, `PORT=3210 JARVIS_PGDATABASE=jarv1s` (shared dev DB, the real
  one, not a gate DB — do not reset it, insert/delete by explicit id only).
- Web (vite): pid `654517`, port `5210`, `JARVIS_API_PROXY_TARGET=http://localhost:3210`.
- Env file used to start both: `<scratchpad>/dev-env.sh` (scratchpad path is session-specific — if
  your session's scratchpad differs, the vars are also inlined in
  `dom-proof-1207.mjs`'s comments / this doc; recreate if the file's gone: see
  `JARVIS_AUTH_TRUSTED_ORIGINS="http://localhost:3210,http://localhost:5210,http://192.168.50.36:5210,http://localhost:3000"`,
  `BETTER_AUTH_SECRET="dev-throwaway-secret-1207"`).
- Sign-in works: `ben@ben.com` / `jarvistest123!` (Ben's standing dev credential, see
  `dev-instance-lan-spinup-trusted-origins` memory).
- Confirm still alive before reusing: `ss -ltnp | grep -E ':3210|:5210'`. If dead, restart per
  `dev-preview-recipe` / `host-dev-install-seam-env-pair` memories (`memory_recall` those two
  queries) — do NOT set `NODE_ENV`, it breaks credential decryption.
- **Teardown when fully done** (after PR comment posted): `kill 652358 654517` — explicit PIDs
  only, never by name pattern (a real prod worker can look like a stray dev process in `ps`).

## Key finding this relay — the aria-live container is NOT on the main chat drawer

Traced where `.assistant-surface__thread` (the element with the fix, `apps/web/src/chat/
assistant-surface/surface.tsx:145`) actually renders in a live page. It is **not** used by the
topbar chat drawer (`apps/web/src/chat/chat-drawer.tsx`) — that component renders its own
`Thread`/`.chatd-*` markup directly and never imports `AssistantSurface`. Confirmed by loading the
live throwaway instance, signing in, opening the topbar chat icon: it shows either
`ConnectProviderEmpty` ("Connect a provider to start chatting" — this account has no AI provider
connected) or a plain `EmptyState`/`Thread`, never `.assistant-surface__thread`.

`AssistantSurface` (`surface.tsx`) is only invoked via `createAssistantSurfaceHandle` →
`handle.ts:67`, which is the **external-module-embedded chat surface** host API (`apps/web/src/
app.tsx:349-376`, `ExternalModuleMount`). Grep confirms the only real consumers are the job-search
module's own screens: `external-modules/job-search/src/web/screens/{onboarding,discuss,inspector}.tsx`.
Job-search is **not installed** for `ben@ben.com` on this dev DB (no "Job Search" nav item showed
in the live shell).

**Two ways to get real DOM-level proof from here, pick whichever is faster to finish inside a
single window:**

1. **Install job-search for this dev account on the live throwaway instance**, navigate to its
   onboarding or discuss screen (these are the real, intended live surface for this component),
   and pull `outerHTML`/`getAttribute("aria-live")` from `.assistant-surface__thread` there. Heavier
   — module install/discovery has its own traps, see `module-discovery-needs-staged-package-dir`
   and `restage-drifts-module-out-of-the-nav` memories — but it's the *actual* product surface the
   fix ships on, so it's the most defensible proof.
2. **Connect an AI provider** for `ben@ben.com` on this instance instead, IF that turns out to also
   route through `AssistantSurface` somewhere in the main drawer flow once a provider is live
   (NOT yet confirmed — `chat-drawer.tsx`'s `ConnectProviderEmpty`/`EmptyState`/`Thread` branches at
   lines 488-502 looked like the only branches; there was no fourth branch spotted, so option 2 may
   be a dead end — verify by reading chat-drawer.tsx in full before trying it, don't assume).

Given the wording of the coordinator's amendment (dom proof of `aria-live="polite"` on
`.assistant-surface__thread` "from the live rendered page"), option 1 is almost certainly what's
wanted — the unit test already proves the JSX/SSR output (`tests/unit/assistant-surface.test.tsx:113`,
already green); the live-path gate exists specifically to catch cases where a component that
type-checks and unit-tests clean never actually mounts in the real runtime path. Confirming it does
mount, in the module surface it's actually used for, IS the point.

**A working sign-in Playwright script already exists**: `dom-proof-1207.mjs` at the worktree root.
It launches chromium, goes to `http://localhost:5210/`, signs in as `ben@ben.com` (submit button
must be scoped as `button[type="submit"]` — a naive `getByRole("button", {name: /sign in/i})`
matches the tab-toggle button first and silently no-ops), skips onboarding if it appears, and was
mid-edit to find/click into a module surface when the relay trigger fired. Reuse and extend it
rather than starting over — just change the post-sign-in navigation to reach job-search onboarding/
discuss instead of the topbar chat icon.

## Remaining (do this next, in order)

1. Message coordinator now with a one-line relay notice (pane `w1:p28` / agent
   `coordinator-wave1-r6`) — this hasn't been sent yet for this relay.
2. Decide option 1 vs 2 above (read `chat-drawer.tsx` in full first, per the note) and get real DOM
   proof of `aria-live="polite"` on `.assistant-surface__thread` from the live throwaway instance —
   `outerHTML` snippet or an Elements-panel screenshot, not a plain visual screenshot of the chat
   UI (has no visual rendering, per the coordinator's standing amendment).
3. Run the 4 blocking UAT specs — **none have been run yet this whole relay chain**:
   `pnpm test:uat -- "<spec>"` for each of:
   - `tests/uat/specs/1089-1090-chat-drawer-private.uat.spec.ts`
   - `tests/uat/specs/1133-chat-attachments.uat.spec.ts`
   - `tests/uat/specs/moss-assistant-name.uat.spec.ts`
   - `tests/uat/specs/runtime-context.uat.spec.ts`
   Note: `pnpm test:uat` provisions its **own** fully ephemeral, isolated Compose stack per spec
   (see `tests/uat/run-uat.ts` → `provisionForUat`) — it does NOT reuse the throwaway instance
   above and does NOT need it torn down first. Capture real exit codes to log files, never pipe:
   `pnpm test:uat -- "<spec>" > /tmp/1207-uat-<n>.log 2>&1; echo "EXIT=$?" >> /tmp/1207-uat-<n>.log`.
4. Post `gh pr comment 1479` with all 4 UAT results and the DOM-level proof from step 2.
5. Tear down the throwaway instance (`kill 652358 654517`, confirm both gone from `ss -ltnp`), and
   delete `dom-proof-1207.mjs` (untracked scratch script, not part of the fix — leaving it in the
   worktree isn't a gate risk since it's untracked, but clean it up anyway).
6. Report to the coordinator per `coordinated-wrap-up` step 4 format (terse, result-first): PR
   link, VF_EXIT/gate summary (unchanged from relay 1 — already have it, no need to re-run the full
   gate), live-path proof status (posted / link), branch pushed+rebased state, deferred items
   (none), teardown state (throwaway instance PIDs killed, `dom-proof-1207.mjs` deleted, worktree
   reapable).
7. Then STOP — do not touch the board, milestones, or merge. That's the coordinator's.

## Guardrails still in force

- Work only in this worktree/branch. `git add` by explicit path — never `-A`. Never touch
  `docs/coordination/` (coordinator-only), the project board, milestones, or merge. No secrets in
  any doc/payload/log/prompt (the throwaway `BETTER_AUTH_SECRET` above is a fixed dev-only
  placeholder, not a real secret — fine to leave in a doc). Never edit an applied migration.
- If a 4th relay trigger fires (context-meter critical again), repeat this exact relay procedure:
  message coordinator, update this doc (amend "Remaining", don't rewrite from scratch), spawn a
  fresh successor in this same worktree, request reap.

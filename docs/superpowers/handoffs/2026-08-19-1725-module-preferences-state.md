# Live state — #1725 module preferences, and #1720 card delivery

Updated 2026-08-19. Two jobs run in parallel in two worktrees. Read this after any
compaction instead of re-deriving from history.

## Job A — #1725: installed modules can have a settings page

Worktree `~/Jarv1s/.claude/worktrees/module-prefs-1725`, branch `module-prefs-1725`.
Spec `docs/superpowers/specs/2026-08-19-module-preferences.md`, approved by Ben, committed
as `6b1ab339a`. Everything below this line is uncommitted.

Done, with `npx tsc --noEmit` clean (exit 0) and the validator suite at 44/44:

1. Manifests may declare `preferences` — `packages/module-sdk/src/external-module.ts`
   (`ExternalModulePreferenceDeclaration`), validated in
   `packages/module-registry/src/external/validate.ts` next to the #1019 navigation block.
   `settings` stays in `FORBIDDEN_FIELDS`. Booleans only, 1-8 entries, default required.
   Tests: `tests/unit/external-validate.test.ts`, `describe("preferences (#1725)")`.
2. Carried through install — `external/reconcile.ts` defaults to `[]`,
   `external/types.ts` `ReconciledExternalModule.preferences`.
3. Storage and resolution — `packages/module-registry/src/external/preferences.ts`
   (`modulePreferenceKey`, `resolveModulePreferences`, `writeModulePreferences`). Reuses
   `app.preferences` under `module:<moduleId>:<key>`, so NO migration. Unwritten == the
   manifest default; nothing is written at install.
4. Endpoints — `apps/api/src/module-preferences.ts`, `GET`/`PATCH`
   `/api/modules/:moduleId/preferences`, registered in `apps/api/src/server.ts` right after
   `registerPlatformRoutes`. Undeclared key or non-boolean value is a 400, unknown or
   inactive module is a 404.
5. Modules read their switches — `ctx.preferences` on `ModuleWorkerContext`
   (`packages/module-sdk/src/worker.ts`), passed on the wire by
   `packages/module-registry/src/external/worker-runtime.ts`, resolved per invocation in
   the actor's data context by `apps/worker/src/external-module-invoke.ts`. Read-only.

**Next step: the settings page itself.** Nothing is rendered yet — a user cannot see or
flip any of this. Was mid-way through reading how panes register:
`apps/web/src/settings/settings-page.tsx` holds the section registry (the "Extensions"
group, `id: "modules"`, `ModulesPane` from `settings-personal-data-panes.tsx`). Follow the
`design-system` skill and the `jds-*` audit before writing any markup.

Then still owed: uninstall deletes the `module:<id>:` namespace; unit tests for the routes;
the live-path end-to-end proof named in the spec; a PR.

Separate follow-on PR after this one lands: Food drops `food.consent.grant` and its prompt,
declares an `aiEstimates` preference defaulting to on, and the estimator reads it. Deleting
a meal still confirms.

### Where job A actually stands (later on 2026-08-19)

All five steps including the settings page are COMMITTED on `module-prefs-1725`:
`13dbf9784` (the feature, 25 files) and `a68feafe1` (prettier). The first gate run failed on
formatting alone and is re-running; log `/tmp/vf-1725b.log`, read `### FINAL rc=`.

The settings page is `apps/web/src/settings/settings-module-preferences.tsx`, reached from
the modules list via the existing `?module=<id>` deep link. `MyModuleDto` gained
`hasPreferences` so the list can offer "Configure" without asking every module in turn;
that flag rides `MossModuleManifest.preferences`, which `createExternalToolManifests`
copies across. Known gap worth stating in the PR: only modules with a runtime AND assistant
tools become tool manifests, so a preferences-only module would not appear yet.

Still owed before the PR: uninstall deletes the `module:<id>:` key namespace, unit tests for
the two routes, and the live end-to-end proof.

### Checkpoint 2026-08-19 21:20 — read THIS first

Both PRs are open with auto-merge armed: **#1730** (this branch, module preferences) and
**#1729** (the #1720 test fix). Nothing is owed on #1725 itself.

Commit `7aa8a97f4` added `tests/unit/module-preferences-routes.test.ts` (8 tests, all passing)
and closed the uninstall item as **not applicable** — there is no uninstall path anywhere in the
platform, so the spec and the route file now say so instead of implying it was built.

**Next job: the Food follow-on**, and it must wait for #1729 to merge, because it has to rewrite
`tests/uat/specs/926-food-real-chat.uat.spec.ts`, which #1729 is currently changing. The Food PR:

- `external-modules/food/jarvis.module.json` declares one preference, `aiEstimates`, default on;
  drops the `food.consent.grant` tool and the `food_consent` action family.
- Both consent gates read `ctx.preferences.aiEstimates` instead of the `food.settings` kv record:
  `external-modules/food/src/worker/handlers/estimate.ts` (`hasGrantedConsent`, ~line 55) and the
  synchronous path in `external-modules/food/src/tools/meals.ts`.
- `external-modules/food/src/tools/consent.ts` and its registry entries go; so does the consent
  strip in the Food web page (`.fud-consent` in `src/web/styles.ts`).
- That PR carries the live-path proof for BOTH it and #1730: turn the switch off in Settings, log
  a meal through real chat, assert no estimate; turn it on, log another, assert the estimate lands.

### Checkpoint 2026-08-19 20:05 (superseded by the one above)

Branch `module-prefs-1725` is pushed, five commits ahead of origin/main. **PR not yet opened**
(deliberately: finish the two items below first, then open with them included).

Gate `/tmp/vf-1725d.log` ends `### FINAL rc=1`, and that failure is NOT this branch. Three unit
files fail (`module-sdk-worker`, `mcp-gateway-validation`, `external-worker-runtime`); all three
reproduce on a worktree that is origin/main plus a test-only commit. Everything before
`test:unit` in the chain passed, including the file-size check that failed the previous two runs.
Do not bisect over these — see the agentmemory note "three local-only failing files".

Two commits this round were pure gate repair, no behaviour change: `8ab840ad5` split
`apps/api/src/better-auth-adapter.ts` out of server.ts and
`packages/module-registry/src/external/validate-declarations.ts` out of validate.ts (both files had
crossed the 1000-line limit); `561f1fa1a` dropped the two imports that split left unused.

**Still owed, in order:**

1. Uninstall must delete the `module:<id>:` key namespace from `app.preferences`. Not started —
   was mid-grep for the uninstall path when this checkpoint fired.
2. Unit tests for `GET`/`PATCH /api/modules/:moduleId/preferences`. Cover: undeclared key → 400,
   non-boolean → 400, unknown or inactive module → 404 (never 403), unwritten key resolves to the
   manifest default.
3. Live end-to-end proof, then open the PR.

## Job B — #1720: SOLVED, shipped as PR #1729

The issue title was wrong and the product was never at fault. `async function sendMessage()`
returned the in-flight turn promise, and `await` flattens that, so `await sendMessage(...)` waited
for the whole chat turn — which for a confirm-gated tool cannot end until someone approves. The
test therefore blocked for the full 150s approval window, then clicked Approve and got a 409.
Measured: server emitted the card 8-17s in, browser logged receiving it 14ms later.

Fixed in `tests/uat/specs/926-food-real-chat.uat.spec.ts` alone (commit `b896714cc`, branch
`fix-1720-card-delivery`): `sendMessage` returns `{ turnSettled }`. Two adjacent test defects fixed
with it — `locator.count()` does not auto-wait, and the file's two tests ran in parallel as the
same user against one instance (now serial). Real-model run: approve 204 at 24s, both tests pass,
`### FINAL rc=0`. All instrumentation reverted. Full detail is in the PR body and agentmemory.

## Job B history — how #1720 was chased (kept only to avoid re-deriving)

Worktree `~/Jarv1s/.claude/worktrees/food-phase1`, branch `fix-1720-card-delivery`.
Nothing committed. Instrumentation in the tree is TEMPORARY and must come out:
`packages/chat/src/live/chat-session-manager.ts` (emit logging),
`apps/web/src/chat/use-chat-stream.ts` (client logging), the `page.on("console")` block and
the `test.fixme` → `test` flip in `tests/uat/specs/926-food-real-chat.uat.spec.ts`, and
`tests/uat/specs/1720-card-delivery-probe.uat.spec.ts` (delete it).

### Ruled out, with evidence

- Not platform-wide: a built-in destructive tool (`memory.forget`) shows its card in 8.3s.
- Not a silently dropped emit. The leading hypothesis was that
  `ChatSessionManager.emit` discards a record when no one is subscribed. **Disproved** —
  the card was emitted to the right channel with 2 subscribers attached.
- Not nginx buffering (measured directly), not a service worker, not two server processes,
  not an uncommitted write, not a slow model, not pool exhaustion.
- No response compression is registered anywhere, so SSE writes are not buffer-delayed.

### The measured timeline (probe 5, `~/probe5-emit.log`)

User message at 0s → server emits `action_request` for `food.consent.grant` at **+11.8s**
to a channel with 2 listeners → nothing answers → the server's 150-second answer window
expires at **+161.8s** → the test clicks Approve at ~+169s and gets a 409.

So the server does its job promptly and the record is written to the SSE stream
(`GET /api/chat/stream`, `packages/chat/src/live-routes.ts:489`). The card does not appear
on screen for roughly three minutes. **The loss is on the browser side of that stream.**

Note for anyone reading older notes: the earlier claim that chat does not use EventSource
was wrong. `apps/web/src/chat/use-chat-stream.ts` opens an EventSource against
`/api/chat/stream`; the earlier probe watched `addEventListener`, but these are unnamed
`data:` events delivered through `onmessage`.

Two subscribers on one channel is the open suspect — the test navigates to `/m/food`
mid-test, so a dead page's stream may still be registered.

### Running now

`~/probe6.sh` (background) rebuilds the image and reruns the Food spec with BOTH probes:
server emits to `~/probe6-emit.log`, browser receipts printed into `~/probe6.log` as
`probe_1720_client` lines. About 12 minutes.

Read it like this: if the browser logs the `action_request` at ~+12s, the transport is fine
and the defect is in rendering or state. If it logs it at ~+180s or never, the defect is in
the stream reaching that page.

### Traps that cost real time

- The UAT log does NOT capture container stdout, and the containers are destroyed at
  teardown. Capture with a `docker logs -f moss` watcher started before the run.
- A run that dies leaves a container named `moss` behind, and the next run fails with a
  name conflict. `docker compose down` fails without `POSTGRES_PASSWORD` in the shell —
  remove by label instead: `docker rm -f $(docker ps -aq --filter "label=com.docker.compose.project=<project>")`.
- Each UAT run takes about 10 minutes and builds a Docker image. Three runs filled the disk
  on 2026-08-18; `docker builder prune -f` recovers it and touches no images or data.

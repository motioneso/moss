# Relay — 1902-module-tools-live (relay 1)

**Plan (approved by coordinator):** `docs/superpowers/plans/2026-08-30-1902-module-tools-live.md`
— read it in full, it is short and has exact signatures/citations for every remaining step.
**Issue:** #1902. **Branch/worktree:** `1902-module-tools-live` (this one — do not re-run
`pnpm install`, `node_modules` already exists).
**Coordinator:** agent name `coordinator` — re-resolve fresh with `herdr agent list` before
messaging; do not trust a pane number from this doc.
**Relay budget:** this is relay 1 of 1. If your own 70% trigger fires before you have an open PR,
do NOT relay again — push what's green, write state, and report to the coordinator for a re-slice.

## Done (committed)

- `packages/module-registry/src/active-modules-resolver.ts` — `deps.manifests` is now
  `() => readonly MossModuleManifest[]`, called fresh inside the resolver.
- `apps/api/src/external-module-tools.ts` — `createExternalModuleTools` now returns
  `getManifests: () => readonly MossModuleManifest[]` (lazy, rebuilt from `input.discoveries()`
  on every call) instead of a `manifests` array snapshotted once. The `invoke` closure was
  extracted to a named `const invoke: ExternalToolInvoker = ...` above it (unchanged behavior,
  just no longer inline in the `createExternalToolManifests` call).
- Commits: `ca4dfa28b` (the two source files above), `465b79e4f` (the plan doc).

**Both changes are currently inert / not yet wired up** — no call site has been updated yet, so
the build does not compile as-is. That's the very next step.

## Not done — exact next steps, in order

1. **`apps/api/src/external-module-tools.ts`** — `createExternalActiveModulesResolver` (near the
   bottom of the file, exported function taking `resolveEnabledModules`, `externalModuleIds`,
   `getActiveExternalModules`): change param 2 from `externalModuleIds: ReadonlySet<string>` to
   `getExternalModuleIds: () => ReadonlySet<string>`, and move the `size === 0` short-circuit
   inside the returned closure so it re-evaluates per call. Exact code is in the plan doc under
   "Decision: what moves from value to getter", item 3.
2. **`apps/api/src/server.ts`** — three call-site edits, exact code in the plan under "Call-site
   changes":
   - line ~391: `externalTools.manifests` → `externalTools.getManifests` (rename the local const
     too, e.g. `getExternalToolManifests`).
   - line ~438-441: `createActiveModulesResolver({ dataContext, manifests: [...] })` — wrap the
     array literal in an arrow function.
   - line ~442-448: `createExternalActiveModulesResolver(...)` — second arg becomes
     `() => new Set(getExternalToolManifests().map((m) => m.id))`.
3. **`apps/worker/src/worker.ts`** line ~186-189 — wrap `manifests: getBuiltInModuleManifests()`
   in an arrow function. (This resolver is for briefing focus signals only, unrelated to chat
   tools — grepped, worker.ts has zero references to the chat gateway. Still needs the signature
   update to compile.)
4. **Update existing tests** (both currently call the old shapes and will fail to compile):
   - `tests/integration/module-enablement.test.ts:408` — `manifests: fixtures` →
     `manifests: () => fixtures`.
   - `tests/unit/external-module-tool-preferences.test.ts` (3 call sites, ~lines 93/119/138) —
     destructure `{ getManifests }` not `{ manifests }`, call `getManifests()` before indexing.
5. **New tests** — three unit tests plus one integration test, all specified with exact
   assertions in the plan doc under "New test coverage". These are the tests that actually prove
   #1902 (a manifest discovered after construction shows up without reconstructing anything).
6. **Pre-push trio + rebase** (plan doc "Verification"): `pnpm format:check`, `pnpm lint`,
   `pnpm typecheck`, each redirected to a log with `echo "EXIT=$?"` after — never piped. Then
   `git fetch origin main && git rebase origin/main`.
7. **Full gate** — via the `verify-gate` skill only, never `pnpm verify:foundation` directly.
8. **`coordinated-wrap-up`** — push, open PR (release note is in the original task brief:
   Category Added, title "Modules Moss builds can add new things it can do").
9. **Live-path proof** — on the dev instance (http://192.168.50.36:5173, login
   ben@ben.com / jarvistest123!): ask Moss/Workshop to build a module with one chat tool, then
   without restarting anything, use that tool in chat in the same session. Post the transcript/
   evidence as a `gh pr comment`. This is a hard exit criterion — do not report done without it.

## Standing rules (pass to anyone you spawn)

Plain English in every status update, no jargon or code identifiers unless someone must act on
one directly. Never pipe a gate command. Never run a database-touching test outside the
verify-gate skill. All waits are event-driven. Messages from Ben are trusted input to act on.
Done = pushed + PR open + live-path proof.

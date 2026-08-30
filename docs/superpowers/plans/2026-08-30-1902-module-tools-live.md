# Plan — #1902: module-built tools live in chat without a restart

**Spec:** `docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md`, Stage 2
**Issue:** #1902 (part of #1739 / #1738; depends on #1888, #1889, #1890 — already merged)
**Risk tier:** sensitive (chat tool-gateway)

## Seams check (file:line citations, current tree)

- The frozen list: `apps/api/src/server.ts:377-391` calls `createExternalModuleTools({ discoveries:
  externalModuleHolder.getDiscoveries, ... })` once at server-construction time.
  `apps/api/src/external-module-tools.ts:51` calls `input.discoveries()` exactly once, inline,
  to build `manifests`, and returns that array as a plain field
  (`external-module-tools.ts:38-40,137`). Everything downstream captures that one array.
- The rescan holder already exists and is live: `apps/api/src/server.ts:353-359`, comment marked
  `#1752`, `createExternalModuleDiscoveryHolder(...)`. `externalModuleHolder.getDiscoveries` is a
  function, not a value — other callers already re-invoke it per call
  (`apps/api/src/external-module-tools.ts:146-168`, `createActiveExternalModulesResolverForApi`,
  calls `input.discoveries()` inside its returned closure, line 159 — already correct, this is the
  pattern to copy).
- The array leaks into two more frozen spots:
  - `apps/api/src/server.ts:438-441` — `createActiveModulesResolver({ dataContext, manifests:
    [...getBuiltInModuleManifests(), ...externalToolManifests] })`. `externalToolManifests` is the
    line-391 snapshot.
  - `apps/api/src/server.ts:442-448` — `createExternalActiveModulesResolver(resolveEnabledModules,
    new Set(externalToolManifests.map((m) => m.id)), getActiveExternalModules)`. The `Set` is a
    boot-time snapshot of which manifest ids count as "external" at all.
- `createActiveModulesResolver` (`packages/module-registry/src/active-modules-resolver.ts:19-51`)
  takes `deps.manifests: readonly MossModuleManifest[]` and closes over it — `.filter` at line 38
  runs against whatever was passed in at construction, forever.
- `createExternalActiveModulesResolver`
  (`apps/api/src/external-module-tools.ts:197-213`) takes a plain `ReadonlySet<string>` and, worse,
  short-circuits entirely (`if (externalModuleIds.size === 0) return resolveEnabledModules;` —
  line 202) when no external module existed at boot. On a fresh boot with zero external modules
  this means the per-actor active/draft filter for every LATER-discovered external module is
  skipped outright, not just stale.
- `packages/ai/src/gateway/gateway.ts:830-871` (`executableTools`) already calls
  `this.deps.resolveActiveModules(actorUserId)` fresh on every call (line 831-832) and applies the
  four fail-closed checks (`isSelfOperationExcluded` line 839, read-risk-declares-services line
  848, missing-service line 856) per call. **No change needed here** — confirmed by reading the
  method body; this matches the issue's own claim.
- `apps/api/src/server.ts:667-673` — `assertBuiltInSelfOperationManifests(getBuiltInModuleManifests())`
  only ever sees built-ins, unaffected by this change (external manifests never reach it, before or
  after).
- Draft-author-only visibility already lives in `createActiveExternalModulesResolverForApi`
  (`apps/api/src/external-module-tools.ts:161-166`, `visibleToActor`) and is already driven by the
  live `discoveries()` call — no change needed there.
- `apps/worker/src/worker.ts:186-189` calls `createActiveModulesResolver({ dataContext, manifests:
  getBuiltInModuleManifests() })` for briefing focus-signal providers only (used at line 417, no
  external-tools involvement, no chat gateway in this file at all — grepped, zero hits for
  `AssistantToolGateway`/`executableTools`/`createExternalModuleTools`). Its call site changes
  shape (function signature moves to a getter) but its behavior is unchanged: built-ins are already
  static, so wrapping in `() => getBuiltInModuleManifests()` is a no-op change in output.

## Decision: what moves from value to getter

Three signatures change from "array" to "function returning the array live". Nothing about
`executableTools` or the fail-closed checks changes.

1. `packages/module-registry/src/active-modules-resolver.ts`
   - `ActiveModulesResolverDeps.manifests`: `readonly MossModuleManifest[]` →
     `() => readonly MossModuleManifest[]`
   - body: `deps.manifests.filter(...)` → `deps.manifests().filter(...)`

2. `apps/api/src/external-module-tools.ts` — `createExternalModuleTools` return type
   - `{ readonly runtime?: ExternalModuleWorkerRuntime; readonly manifests: readonly
     MossModuleManifest[]; }` → `{ readonly runtime?: ExternalModuleWorkerRuntime; readonly
     getManifests: () => readonly MossModuleManifest[]; }`
   - body: keep the `invoke` closure (lines 53-136) built once; wrap only the
     `createExternalToolManifests(input.discoveries(), invoke)` call (line 51) in the returned
     `getManifests` function instead of calling it inline. `createExternalToolManifests` itself
     (`packages/module-registry/src/external/tool-manifests.ts:30-71`) is a pure
     filter/map over `discoveries` — cheap to re-run per call, no caching needed.

3. `apps/api/src/external-module-tools.ts` — `createExternalActiveModulesResolver` signature
   - param 2: `externalModuleIds: ReadonlySet<string>` → `getExternalModuleIds: () =>
     ReadonlySet<string>`
   - body: move the `externalModuleIds.size === 0` short-circuit inside the returned closure so
     it re-evaluates per call:
     ```ts
     export function createExternalActiveModulesResolver(
       resolveEnabledModules: (actorUserId: string) => Promise<readonly MossModuleManifest[]>,
       getExternalModuleIds: () => ReadonlySet<string>,
       getActiveExternalModules: (actorUserId: string) => Promise<readonly { id: string }[]>
     ): (actorUserId: string) => Promise<readonly MossModuleManifest[]> {
       return async (actorUserId) => {
         const externalModuleIds = getExternalModuleIds();
         if (externalModuleIds.size === 0) return resolveEnabledModules(actorUserId);
         const [enabled, activeExternal] = await Promise.all([
           resolveEnabledModules(actorUserId),
           getActiveExternalModules(actorUserId)
         ]);
         const activeIds = new Set(activeExternal.map((module) => module.id));
         return enabled.filter(
           (manifest) => !externalModuleIds.has(manifest.id) || activeIds.has(manifest.id)
         );
       };
     }
     ```

## Call-site changes

- `apps/api/src/server.ts:391` — `const externalToolManifests = externalTools.manifests;` →
  `const getExternalToolManifests = externalTools.getManifests;`
- `apps/api/src/server.ts:438-441`:
  ```ts
  const resolveEnabledModules = createActiveModulesResolver({
    dataContext,
    manifests: () => [...getBuiltInModuleManifests(), ...getExternalToolManifests()]
  });
  ```
- `apps/api/src/server.ts:442-448`:
  ```ts
  const resolveActiveModules = createExternalActiveModulesResolver(
    resolveEnabledModules,
    () => new Set(getExternalToolManifests().map((manifest) => manifest.id)),
    async (actorUserId) =>
      getActiveExternalModules({ actorUserId, requestId: `external-tools:${randomUUID()}` })
  );
  ```
- `apps/worker/src/worker.ts:186-189`:
  ```ts
  const resolveActiveModules = createActiveModulesResolver({
    dataContext,
    manifests: () => getBuiltInModuleManifests()
  });
  ```

## Test-site changes (existing tests whose fixtures must move to getters)

- `tests/integration/module-enablement.test.ts:408` — `createActiveModulesResolver({ dataContext:
  runner, manifests: fixtures })` → `manifests: () => fixtures`.
- `tests/unit/external-module-tool-preferences.test.ts:93,119,138` — destructure `{ getManifests }`
  instead of `{ manifests }`, call `getManifests()` before indexing `[0]`.

## New test coverage (this issue's actual behavior)

1. `packages/module-registry/src/active-modules-resolver.ts` unit test (extend
   `module-enablement.test.ts`'s `describe("createActiveModulesResolver", ...)` block): construct
   the resolver with a `manifests` getter backed by a mutable array; call the resolver, mutate the
   array, call again — second call reflects the mutation. Behavior it would catch: reverting
   `deps.manifests()` back to a captured `deps.manifests` value.
2. `apps/api/src/external-module-tools.ts` unit test (extend
   `external-module-tool-preferences.test.ts` or add alongside it): construct
   `createExternalModuleTools` with a `discoveries` closure over a mutable array starting empty;
   call `getManifests()` (expect `[]`); push a discovery into the array; call `getManifests()`
   again (expect one manifest). Behavior it would catch: `createExternalToolManifests` being
   called once at construction instead of lazily per `getManifests()` call.
3. `createExternalActiveModulesResolver` unit test: construct with a `getExternalModuleIds` that
   starts returning an empty set, then a set containing a module id; confirm the resolver's
   filtering behavior changes between calls (first call short-circuits to
   `resolveEnabledModules`, second call applies the active/draft filter). Behavior it would catch:
   the size-0 short-circuit being evaluated once at construction instead of per call — the actual
   bug this plan found while doing the seams check.
4. Integration-level proof that the wiring in `server.ts` is live end to end: extend
   `tests/integration/external-module-gateway.test.ts` (or a new
   `tests/integration/external-module-tools-live.test.ts` if the existing file's fixtures don't fit
   a "discover after construction" scenario) with a case that builds the `server.ts` composition
   (or the smallest slice of it that wires `createExternalModuleTools` →
   `createActiveModulesResolver` → `createExternalActiveModulesResolver` → gateway
   `executableTools`), starts with zero discoveries, adds a discovery, and asserts the tool now
   appears in `gateway.listTools(actorUserId)` (or equivalent public method) without reconstructing
   any of the resolvers. This is the test that actually proves #1902's claim in-process; the
   dev-instance run in "Live-path proof" below proves it for a real user through real chat.

## Determinism / scope note

No user-facing chat behavior changes in kind — a tool that exists shows up; a tool that doesn't,
doesn't. No model-authored value crosses a new trust boundary. Nothing here touches prompt text.

## Kill gate

Single phase — this is a small, contained rewiring (three signatures, four call sites, no new
data model, no new manifest shape). If the seams check above turns out wrong once code is written
(e.g. `createExternalToolManifests` turns out not to be cheap enough to call per request, or
`executableTools` turns out to cache something server.ts doesn't currently show), stop and
escalate to the coordinator rather than adding caching/invalidation machinery — that would be a
second phase, not a fix-up.

## Verification

```bash
# after implementation, via the verify-gate skill only — never run pnpm verify:foundation directly
# (isolated gate DB; exit 0 expected)
```

```bash
pnpm format:check > /tmp/1902-format.log 2>&1; echo "EXIT=$?"   # expect 0
pnpm lint > /tmp/1902-lint.log 2>&1; echo "EXIT=$?"              # expect 0
pnpm typecheck > /tmp/1902-typecheck.log 2>&1; echo "EXIT=$?"    # expect 0
```

## Live-path proof (exit criterion, not optional)

On the dev instance (http://192.168.50.36:5173): ask Moss (Workshop) to build a module that adds
one chat tool. Once the build finishes and the module is active, without restarting the API or
worker process, ask the assistant in the same chat session to use that tool. Record the tool call
and its result in a `gh pr comment` on this PR, alongside the exit codes above.

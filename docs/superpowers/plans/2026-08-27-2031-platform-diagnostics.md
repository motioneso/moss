# Build plan — #2031 platform diagnostics, piece 2 of #1586

Spec: `docs/specs/2031.md` on this branch (copy of the approved SPEC comment on issue #2031).
Branch: `fleet/lane-2031`. Risk tier: security.

## Seams check — every assumed capability, cited on this branch

Verified by reading the tree at `491148343` before planning. Every premise the spec relies on is
still true; nothing it asks for already exists.

| Capability assumed | Citation | State |
| --- | --- | --- |
| Read tools get a separate service bag from write tools | `packages/ai/src/gateway/gateway.ts:562` (`servicesFor`), `:566` returns `readToolServices` | Present, unchanged |
| The two bags are assembled in one place | `packages/chat/src/gateway-services.ts:172` (`toolServices`), `:193` (`readToolServices`) | Present |
| Generic per-provider aggregator to copy | `packages/module-sdk/src/index.ts:344` `aggregateFocusSignals`; fresh context per provider, 250 ms deadline, sanitized drop hook at `:317` | Present |
| Manifest seam pattern | `packages/module-sdk/src/index.ts:652` `focusSignal?` | Present |
| External manifests must reject function fields | `packages/module-registry/src/external/validate.ts:61` `FORBIDDEN_FIELDS` contains `focusSignal`, `proactiveMonitor`, `personContextProvider` | Present; `diagnosticsProvider` absent |
| Host diagnostics builder plus its guard | `packages/settings/src/host-diagnostics.ts:61` `buildHostDiagnostics`, `:116` `assertDiagnosticsSafe`, `:59` `CREDS_IN_URL` | Present |
| Host diagnostics assembly is inline in the route | `packages/settings/src/host-diagnostics-routes.ts:38-93` | Present, still inline |
| App map exposes build info and resolves admin the same way | `packages/settings/src/app-map.ts:22` `getBuildInfo`, `:53` `is_instance_admin` via `getUser` | Present |
| Actor-scoped error rows | `packages/ai/src/repository.ts:2065` `listRecentErrors` | Present |
| Actor-scoped audit rows | `packages/ai/src/repository.ts:2004` `listActionAuditLog` | Present |
| Reviewed error projection to copy exactly | `packages/ai/src/error-tools.ts:59-69` | Present |
| News freshness read that never selects the payload | `packages/news/src/personalization-repository.ts:578` `readRefreshDiagnostics`, shape at `:49` | Present (landed in #2045) |
| Workspace root discovery to copy | `packages/module-registry/src/index.ts:407` `findWorkspaceRoot` | Present |
| Path containment precedent, and its symlink hole | `packages/vault/src/vault-path.ts` — resolves, never calls `realpath` | Present; our reader must close that hole |
| Composition points | `packages/module-registry/src/index.ts:2381` `focusSignalProvidersFor`, `:2570` `appMapService`, `:554` `hostDiagnostics` dep | Present |
| Chat threading pattern | `packages/chat/src/routes.ts:121`, `:259` | Present |
| Package edges allow the placement | `@moss/ai` depends on `@moss/settings`; `@moss/news` on `@moss/module-sdk` + `@moss/db`; `@moss/module-sdk` only on `@moss/db` | Verified from each `package.json`; no new declaration needed |
| Test harness to copy | `tests/integration/error-log.test.ts:1-25` (`resetFoundationDatabase`, `DataContextRunner`, `ids.userA`/`userB`) | Present |

Two extra constraints found while reading, not stated in the spec:

- `packages/module-sdk/src/index.ts:8-11` — the barrel must stay free of any `node:*` import, guarded
  by `tests/unit/module-sdk-barrel-browser-safety.test.ts`. `diagnostics.ts` therefore imports nothing
  from node.
- The host diagnostics route runs its admin check and its database reads in one transaction on
  purpose (`host-diagnostics-routes.ts:22-28` documents this). The extraction must not turn that into
  two transactions.

## Open questions

None. The spec settles every fork it raises, and each premise above verified true.

## Determinism boundary

This piece adds no user-facing surface: no route, no assistant tool, no screen, no prompt text, no
model call. Everything it produces is a plain data record assembled from database reads and host
facts. Nothing here renders from model output, and no module injects a chat turn. Piece 3 (#2032) is
where any of that could appear.

## Tasks

Each task commits green on its own.

### Task 1 — the provider seam, in module-sdk

New file `packages/module-sdk/src/diagnostics.ts`, exported by name from
`packages/module-sdk/src/index.ts` (a named list, as `route-errors.js` and `time.js` are).

```ts
export interface ModuleDiagnosticProvider {
  readonly domain: string;
  readonly providerId: string;
  observe(
    scopedDb: unknown,
    ctx: { readonly actorUserId: string; readonly requestId: string }
  ): Promise<ModuleDiagnosticObservation | null>;
}

export interface ModuleDiagnosticObservation {
  readonly domain: string;
  readonly providerId: string;
  readonly observedAt: string;
  readonly status: "ok" | "degraded" | "failed" | "unknown";
  readonly summary: string;
  readonly remediationActionId?: string;
  readonly facts?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RegisteredModuleDiagnosticProvider {
  readonly moduleId: string;
  readonly provider: ModuleDiagnosticProvider;
}

export type ModuleDiagnosticContextRunner = <T>(
  work: (scopedDb: unknown) => Promise<T>
) => Promise<T>;

export interface ModuleDiagnosticAggregateOptions {
  readonly onProviderError?: (moduleId: string, errorName: string) => void;
}

export const MODULE_DIAGNOSTIC_LIMITS: {
  readonly providerTimeoutMs: 2000;
  readonly summaryMaxLength: 300;
  readonly maxFactKeys: 12;
  readonly factValueMaxLength: 120;
};

export async function aggregateModuleDiagnostics(
  providers: readonly RegisteredModuleDiagnosticProvider[],
  runInContext: ModuleDiagnosticContextRunner,
  ctx: { readonly actorUserId: string; readonly requestId: string },
  options?: ModuleDiagnosticAggregateOptions
): Promise<ModuleDiagnosticObservation[]>;
```

Behaviour, mirroring `aggregateFocusSignals`: a fresh context per provider, a 2000 ms deadline per
provider, a throw or a malformed return becomes no observation, and the drop is reported with the
module id and the error's name only. An observation that breaks a limit in
`MODULE_DIAGNOSTIC_LIMITS` is dropped, not truncated, and reported as a malformed return.

Also: add `readonly diagnosticsProvider?: ModuleDiagnosticProvider;` to `MossModuleManifest`, and add
`"diagnosticsProvider"` to `FORBIDDEN_FIELDS` in
`packages/module-registry/src/external/validate.ts:61`.

### Task 2 — the bounded source reader, in settings

New file `packages/settings/src/source-inspector.ts`, exported from `packages/settings/src/index.ts`.

```ts
export const SOURCE_INSPECTOR_LIMITS: {
  readonly maxMatches: 10;
  readonly maxFilesScanned: 2000;
  readonly maxExcerptLines: 40;
  readonly maxExcerptBytes: 4096;
  readonly maxResponseBytes: 32768;
  readonly maxFileBytes: 524288;
};

export const SOURCE_INSPECTOR_ALLOWED_ROOTS: readonly string[];
export const SOURCE_INSPECTOR_EXCLUDED_SEGMENTS: readonly string[];

export interface SourceExcerpt {
  readonly path: string;      // relative to the workspace root, never absolute
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

export interface SourceSearchResult {
  readonly matches: readonly SourceExcerpt[];
  readonly filesScanned: number;
  readonly truncated: boolean;
  readonly rejected: readonly { readonly path: string; readonly reason: string }[];
}

export interface SourceInspector {
  search(input: {
    query: string;
    pathPrefix?: string;
    limit?: number;
  }): Promise<SourceSearchResult>;
  read(input: {
    path: string;
    startLine?: number;
    lineCount?: number;
  }): Promise<SourceExcerpt>;
}

export function createSourceInspector(options?: { workspaceRoot?: string }): SourceInspector;
```

Decisions:

- Workspace root found by walking up for `pnpm-workspace.yaml`, the same loop as
  `packages/module-registry/src/index.ts:407`. The `workspaceRoot` option exists only so a test can
  point at a temporary directory; production passes nothing.
- Allowed top-level roots: `packages`, `apps`, `scripts`, `infra/postgres`, `tests`, `docs`.
- Excluded path segments: `node_modules`, `dist`, `build`, `coverage`, `.git`, `.turbo`, `.cache`,
  `.superpowers`, `external-modules`, `data`, `vaults`, `.claude`.
- Excluded names and extensions: `.env` and anything starting `.env.`, `pnpm-lock.yaml`, and
  `.pem .key .p12 .pfx .crt .map .png .jpg .jpeg .webp .ico .woff .woff2 .zip .tar .gz`.
- Containment survives symlinks: resolve, `realpathSync` the result, then re-check containment
  against the real path of the root. An absolute input path is rejected outright.
- `node:fs` and `node:path` only. No shell, no child process.
- Secret guard matches shape, never vocabulary: reject an excerpt on `CREDS_IN_URL` (reused from
  `host-diagnostics.ts`), on a secret-looking assignment whose right side is a 16-plus character
  literal that is not a placeholder (`changeme`, `example`, `<...>`, `process.env...`), or on
  `-----BEGIN`. Rejection replaces the whole excerpt with a reason; excerpts are never doctored.

### Task 3 — extract the host diagnostics assembly

New file `packages/settings/src/host-diagnostics-collect.ts` (a sibling, so the pure builder and its
guard stay free of database types), exported from `packages/settings/src/index.ts`.

```ts
export interface HostDiagnosticsCollectorDependencies {
  readonly repository: Pick<SettingsRepository, "pingDatabase" | "getChatMultiplexerSetting">;
  readonly hostDiagnostics: HostDiagnosticsProvider;
  readonly getChatMultiplexerStatus?: GetChatMultiplexerStatus;
}

export function collectHostDiagnostics(
  deps: HostDiagnosticsCollectorDependencies,
  scopedDb: DataContextDb
): Promise<HostDiagnosticsDto>;
```

A pure move of `host-diagnostics-routes.ts:46-93`. The route keeps its admin check and its 503 for a
missing provider, and calls the collector inside its existing transaction, so the one-transaction
property documented at `host-diagnostics-routes.ts:22-28` is preserved. The route's response does not
change and `tests/integration/host-diagnostics-admin.test.ts` passes untouched.

The one behavioural difference, stated deliberately: the pg-boss probe and the multiplexer status
call now happen inside that transaction instead of after it. Neither touches the database
transaction, and both were already awaited before the response was built, so the response is
identical; the transaction is held open for the duration of two host-side calls.

### Task 4 — the platform diagnostics service, in ai

New file `packages/ai/src/platform-diagnostics.ts`, exported from `packages/ai/src/index.ts`.

```ts
export type HostRuntimeObservation = HostDiagnosticsDto;

export interface StructuredErrorObservation {
  readonly occurredAt: string;
  readonly feature: string;
  readonly operation: string;
  readonly errorCategory: string;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly internalSummary: string;
  readonly requestId: string | null;
}

export interface ActionAuditObservation {
  readonly occurredAt: string;
  readonly toolModuleId: string;
  readonly toolName: string;
  readonly actionKind: string;
  readonly approvalMode: string;
  readonly outcome: string;
  readonly errorClass: string | null;
  readonly requestId: string | null;
}

export interface PlatformDiagnosticsQuery {
  readonly domain?: string;
  readonly include?: readonly ("version" | "runtime" | "modules" | "errors" | "actions")[];
  readonly query?: string;
  readonly limit?: number;
}

export interface PlatformDiagnosticsReport {
  readonly observedAt: string;
  readonly build: { readonly version: string; readonly buildId: string };
  readonly runtime: HostRuntimeObservation | null;
  readonly modules: readonly ModuleDiagnosticObservation[];
  readonly errors: readonly StructuredErrorObservation[];
  readonly actions: readonly ActionAuditObservation[];
  readonly redactions: readonly string[];
}

export interface PlatformDiagnosticsService {
  observe(
    scopedDb: DataContextDb,
    ctx: { readonly actorUserId: string; readonly requestId: string },
    query?: PlatformDiagnosticsQuery
  ): Promise<PlatformDiagnosticsReport>;
}

export function createPlatformDiagnosticsService(deps: {
  readonly appMap: Pick<AppMapReadService, "getBuildInfo">;
  readonly collectHostDiagnostics?: (scopedDb: DataContextDb) => Promise<HostDiagnosticsDto>;
  readonly repository: Pick<AiRepository, "listRecentErrors" | "listActionAuditLog">;
  readonly moduleProviders: () => Promise<readonly RegisteredModuleDiagnosticProvider[]>;
  readonly runInContext: ModuleDiagnosticContextRunner;
  readonly isInstanceAdmin: (scopedDb: DataContextDb, actorUserId: string) => Promise<boolean>;
  readonly assertDiagnosticsSafe: (dto: HostDiagnosticsDto) => void;
  readonly onProviderError?: (moduleId: string, errorName: string) => void;
}): PlatformDiagnosticsService;
```

Rules it enforces, each from the spec:

- `build` is for everyone — the same values the existing app map tool already shows.
- `runtime` is admin-only. Non-admin gets `null` and `"runtime"` in `redactions`. Admin resolution
  reads `is_instance_admin` the way `app-map.ts:53` does. Admin never changes which rows a query
  returns.
- Errors and audit rows come from the actor's own scoped handle with no owner filter added; row-level
  security is the boundary. Errors use exactly the field list at `error-tools.ts:59-69`. Audit rows
  leave `input_summary` out.
- `assertDiagnosticsSafe` runs on the host section before returning. No second sanitizer.
- Module observations go through `aggregateModuleDiagnostics`; a provider that throws is dropped and
  logged with the module id and error name only.
- `limit` caps at 10. `include` defaults to every section.
- Read-only by construction: read ports in, one `observe` method out, no queue handle, no write path.

### Task 5 — the news provider

New file `packages/news/src/diagnostics-provider.ts`, exported from `packages/news/src/index.ts`,
attached as `diagnosticsProvider` on `newsModuleManifest` in `packages/news/src/manifest.ts`.

```ts
export function createNewsDiagnosticsProvider(
  repository?: Pick<NewsPersonalizationRepository, "readRefreshDiagnostics">
): ModuleDiagnosticProvider;
```

Domain `"news"`, provider id `"news.refresh"`, `remediationActionId` `"news.refreshNews"` (a label
only — nothing in this piece can execute it).

Status mapping:

| Condition | Status |
| --- | --- |
| No refresh row and no snapshot (`refresh.updatedAt` null and `snapshotCompiledAt` null) | `unknown` |
| `refresh.state === "failed"`, or `lastFailureAt` newer than `lastSuccessAt` | `failed` |
| No snapshot, or `snapshotAgeSeconds` over 86400, or `requestedGeneration > compiledGeneration` while state is `idle` | `degraded` |
| Otherwise | `ok` |

`facts` carries only: the live state, the failure kind, the four history timestamps, the snapshot age
in seconds, the item count and the two generation numbers. No headline, no source name, no article
text — which is exactly why `readRefreshDiagnostics` never selects the payload.

### Task 6 — composition

In `packages/module-registry/src/index.ts`:

- `moduleDiagnosticProvidersFor(manifests: readonly MossModuleManifest[]):
  RegisteredModuleDiagnosticProvider[]` next to `focusSignalProvidersFor` at `:2381`, same generic
  shape, fed the actor's active manifests so a module the user turned off does not report.
- Build the service next to `appMapService` at `:2570`, feeding it `appMapService`,
  `deps.hostDiagnostics`, an `AiRepository`, and the provider list.
- Thread it to chat the way `appMapService` is threaded (`packages/chat/src/routes.ts:121`, `:259`)
  and register it in `readToolServices` in `packages/chat/src/gateway-services.ts:193` as
  `platformDiagnostics`.

No tool consumes it yet — that is deliberate: it proves the wiring here and makes piece 3 a small
change.

## Tests — behaviour, and how each would fail against a broken implementation

**`tests/integration/source-inspector.test.ts`** — pure, no database.

- An allowed read returns a relative path and the requested lines. Fails if the reader returns an
  absolute path, which would leak the deployment layout.
- An allowed search finds a known string under `packages`. Fails if the allowed-root check rejects
  everything.
- Each excluded segment is rejected: `node_modules`, `dist`, `.git`, `external-modules`. Fails if the
  exclusion list is checked against the input string rather than the resolved path.
- Traversal is rejected in all three forms: a leading `../`, an absolute path, and a path that only
  escapes after resolution (`packages/../../etc`). Fails if containment is checked before resolution.
- A symlink inside an allowed root pointing outside the workspace is rejected, created in a temp
  directory by the test. Fails against the `vault-path.ts` approach, which never calls `realpath`.
- Each limit binds: at most 10 matches, at most 40 lines and 4096 bytes per excerpt, at most 32768
  bytes per response. Fails if a limit is declared but never enforced.
- A file containing a URL with embedded credentials is rejected; so is one containing `-----BEGIN`.
- The regression that proves shape over vocabulary: reading
  `packages/settings/src/host-diagnostics.ts` succeeds even though it contains the literal text
  `DATABASE_URL`. Fails against the obvious-but-wrong implementation that reuses
  `FORBIDDEN_SECRET_KEYS`.

**`tests/integration/platform-diagnostics.test.ts`** — database-backed, harness copied from
`tests/integration/error-log.test.ts`.

- An admin gets a runtime section; a non-admin gets `null` and `"runtime"` in `redactions`. Fails if
  admin is resolved from anything other than `is_instance_admin`, or if the redaction is silent.
- User A seeded with error rows, audit rows and news state sees none of user B's, in any of the three
  sections. Fails if any query adds its own owner filter instead of relying on row-level security, or
  if a scoped handle is swapped for a root one.
- A provider that throws is dropped, the report still returns, and the drop hook received the module
  id and the error name and nothing else. Fails if one provider's failure breaks the report, or if
  the hook leaks a message.
- A scan of the whole serialized report finds no connection URL and no credentials in a URL.

**`tests/integration/news-diagnostics-provider.test.ts`** — database-backed.

- No refresh row gives `unknown`.
- A recorded failure followed by a success gives `ok` while the last-failure history survives — the
  invariant piece 1 established. Fails if the provider reads live state only.
- A snapshot older than a day gives `degraded`; the item count is reported.
- The serialized observation contains none of the article titles seeded into the snapshot payload.
  Fails the moment a provider reaches for the payload.

**`tests/unit/chat-gateway-dependencies.test.ts`** — extended.

- Build the dependencies with a platform diagnostics service supplied, then assert it is present in
  `readToolServices` and absent from `toolServices`. That is the machine-checked form of "a read-only
  inspection cannot obtain a write-capable service". Fails if the service is registered in the wrong
  bag — the exact mistake that would break the write-then-confirm floor.

## Verification, unpiped, with expected exit codes

```bash
pnpm --filter @moss/module-sdk exec tsc --noEmit > /tmp/2031-sdk.log 2>&1; echo "EXIT=$?"   # 0
pnpm typecheck > /tmp/2031-typecheck.log 2>&1; echo "EXIT=$?"                                # 0
pnpm lint > /tmp/2031-lint.log 2>&1; echo "EXIT=$?"                                          # 0
pnpm format:check > /tmp/2031-format.log 2>&1; echo "EXIT=$?"                                # 0
pnpm check:file-size > /tmp/2031-filesize.log 2>&1; echo "EXIT=$?"                           # 0
pnpm check:package-deps > /tmp/2031-deps.log 2>&1; echo "EXIT=$?"                            # 0
```

The full gate (`pnpm verify:foundation`, and every database-backed test) runs **only** through the
repository's `verify-gate` skill — an unscoped run points at the live development database.

## Kill gate after task 1

If the seam cannot be added to `packages/module-sdk/src/index.ts` without either pushing that file
past the 1000-line gate or pulling a `node:*` import into the browser-safe barrel, stop and report,
rather than relaxing either gate. Owner: this lane, escalated through the task record.

## Not in scope

No assistant tool, no route, no migration, no new workspace package, no end-to-end conversation test.
Those are piece 3 (#2032). If SQL or a route appears in a diff here, that is the signal to stop.

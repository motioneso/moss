# Jarvis Module Developer Guide

How to build a module for Jarvis: a self-contained feature (its own tables, routes, jobs,
frontend surfaces, and external data sources) that docks into the platform through declared
seams instead of hand-wired edits across the app.

**Current state (read this first).** Jarvis has one product concept: **Modules**. Bundled modules
ship with core as workspace packages under `packages/` and are registered in the composition root
(`packages/module-registry/src/index.ts`). Downloaded modules are distributed as hash-verified GitHub
Release artifacts and installed separately without rebuilding core — see
[§13 Distribution](#13-distribution). The docking seams (manifest, data lifecycle, dataset
connector, web registry) are the stable contract for both paths; only delivery differs. `external`
remains an internal name for the downloaded-module loader and its security boundary, not a second
kind of module in the product.

**Parity status.** Navigation, runtime web UI, assistant tools, queued jobs, credentials, and
platform KV work for downloaded modules today. Per-user module toggles, module-contributed settings,
notifications, briefings, host-diagnostics counts, and account export/delete for downloaded
module-owned database tables are not unified yet. Job Search is KV-only, so its current user data is
already covered by the generic module-KV export/delete path. Do not design a downloaded module that
depends on the remaining surfaces until the sensitive parity work under epic #860 has an approved
spec; the target is for delivery to be the only product-level difference.

Authoritative deep references: the four seam specs under `docs/superpowers/specs/`
(`2026-07-04-module-boundary-enforcement.md`, `-data-lifecycle-ports.md`,
`-dataset-connector-sdk.md`, `-web-registry.md`) and `docs/DEVELOPMENT_STANDARDS.md`.
The best living example is `packages/sports` — it exercises every seam in this guide.

---

## 1. Ground rules

These are platform invariants. A module that violates any of them will be rejected at
registration, by CI gates, or in review — they are not conventions.

1. **Private by default.** All user data is owner-only unless explicitly shared. Every
   module-owned table gets Row-Level Security; admins get no data bypass (admin power is
   configuration power only).
2. **Module isolation.** Modules collaborate only through declared public APIs and events.
   Never import another module's internals (`@jarv1s/other/src/...`) or query another module's
   tables. Two automated gates enforce this (see §10).
3. **`DataContextDb` only.** Repositories accept the branded `DataContextDb` handle, never a
   root Kysely instance. All vault (filesystem) I/O goes through `VaultContext`, never raw `fs`.
4. **`AccessContext` is `{ actorUserId, requestId }`.** Nothing else. Do not add fields.
5. **Secrets never escape.** Credentials, tokens, and password hashes never reach frontend
   responses, logs, job payloads, exports, or AI prompts.
6. **Metadata-only job payloads.** pg-boss payloads carry IDs, job kind, idempotency key, and
   small command params — never private content or prompts.
7. **Provider-agnostic AI.** Never hardcode an AI provider or model. Request capabilities; the
   router selects the user's configured model.
8. **Spec before build.** In-repo modules need an approved design spec in
   `docs/superpowers/specs/` and a GitHub `task` issue before code.

## 2. Anatomy of a module

```
packages/<your-module>/
├── package.json          # workspace package; declares EVERY dependency it imports
├── sql/                  # module-owned migrations (never in infra/postgres/migrations/)
│   └── 0134_your_tables.sql
├── src/
│   ├── index.ts          # public API — the ONLY thing other packages may import
│   ├── manifest.ts       # the JarvisModuleManifest (the docking contract)
│   ├── routes.ts         # Fastify route registration
│   ├── repository.ts     # data access (DataContextDb only)
│   ├── source/           # external-data adapter(s), if any (§8)
│   ├── settings/         # settings pane entry, if any (declared via "./settings" export)
│   └── web/              # frontend contribution, if any (declared via "./web" export)
│       └── index.tsx     # default-exports a ModuleWebContribution (§9)
└── tests/                # module tests (exempt from boundary lint, still run in the gate)
```

`package.json` for a module with all surfaces (from `packages/sports`):

```jsonc
{
  "name": "@jarv1s/your-module",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts", // backend public API
    "./settings": "./src/settings/index.tsx", // settings pane (optional)
    "./web": "./src/web/index.tsx" // frontend contribution (optional)
  },
  "dependencies": {
    "@jarv1s/module-sdk": "workspace:*", // manifest types (always)
    "@jarv1s/db": "workspace:*", // DataContextDb (backend)
    "@jarv1s/module-web-sdk": "workspace:*", // only if you ship "./web"
    "@jarv1s/datasets": "workspace:*" // only if you declare externalSources
  }
}
```

Declare **every** package you import. The `check:package-deps` gate fails on undeclared
imports (they only work by accident of pnpm hoisting) and on declared-but-unused
`@jarv1s/*` dependencies.

## 3. The manifest

`src/manifest.ts` exports one `JarvisModuleManifest` object — the single declaration the
platform reads to dock your module. Core fields:

```ts
export const yourModuleManifest = {
  id: "your-module", // globally unique, stable forever
  name: "Your Module",
  version: "0.1.0",
  publisher: "you",
  lifecycle: "user-toggleable", // "required" | "optional" | "user-toggleable" | ...
  compatibility: { jarv1s: ">=0.0.0" },
  availability: { defaultEnabled: true, required: false, supportsUserDisable: true },
  database: {
    migrations: ["sql/0134_your_tables.sql"],
    migrationDirectories: ["packages/your-module/sql"],
    ownedTables: ["app.your_table"] // tables ONLY you may touch
  },
  navigation: [
    // sidebar entries; each path must match a "./web" route (§9)
    { id: "your-module", label: "Yours", path: "/yours", icon: "puzzle", order: 40 }
  ],
  permissions: [{ id: "your-module.view", label: "View", description: "..." }],
  dataLifecycle: {
    /* REQUIRED for new modules — §7 */
  },
  externalSources: [
    /* only if you fetch external data — §8 */
  ]
} satisfies JarvisModuleManifest;
```

Other optional manifest surfaces (see `packages/module-sdk/src/index.ts` for the full types):
`settings` (settings panes), `jobs` + queue definitions (§6), `notifications`,
`shareableResources`, `assistantTools` / `assistantActionFamilies` (§11), `featureFlags`,
`sourceBehaviors`, `focusSignal`, `proactiveMonitor`, `personContextProvider`.

`assertModuleRegistryConsistency` runs at boot and rejects: duplicate module/source IDs,
missing `dataLifecycle` (for new modules), invalid `fetchHosts`, and `credential: "api-key"`
(reserved, unsupported). A broken manifest fails fast, not silently.

## 4. Database and migrations

- SQL lives in your module's `sql/` directory — **never** in `infra/postgres/migrations/`.
- Migration numbers are global across the whole app, assigned by landing order. Take the next
  free number when you merge, not when you branch.
- **Never edit an applied migration.** The runner hash-checks applied files; fix-forward with a
  new file.
- Every user-data table needs:
  - an ownership column (usually `owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE`),
  - `ENABLE ROW LEVEL SECURITY` plus owner-scoped policies (see any recent module migration
    for the pattern),
  - an `ON DELETE CASCADE` foreign-key chain that terminates at `app.users` — an integration
    test (`tests/integration/module-data-lifecycle-cascade.test.ts`) verifies this for every
    table you declare in `dataLifecycle.deletion.tables`, so a missing cascade fails CI.
- `tests/integration/foundation.test.ts` asserts the **full** migration list with `toEqual` —
  add your migration's row there and run the full `test:integration` suite, or it breaks
  latently for the next person.

## 5. Backend data access and routes

- **Repositories** take the branded `DataContextDb`. Where a seam hands you an untyped handle
  (e.g. lifecycle `collect`), narrow it with `assertDataContextDb` — the established pattern.
- **RLS + explicit predicates.** Even though RLS scopes queries, write the explicit
  `WHERE owner_user_id = ...` too (defense in depth; see `packages/wellness/src/data-lifecycle.ts`).
- **Routes** are plain Fastify, registered by your module's `registerRoutes(server, deps)`
  function, called from the composition root with `dataContext`, `resolveAccessContext`, and
  friends. Request/response contracts are shared TypeScript schemas in
  `packages/shared/*-api.ts` — the frontend imports the same types.
- Gate module UI behind a `permissionId`; the shell enforces it for navigation and settings
  surfaces.

## 6. Background jobs

Declare queue definitions and export a `registerWorkers(boss, deps)` if you need async work.
Payloads are **metadata-only**: actor/resource IDs, job kind, idempotency key, small params.
Fetch private content inside the worker through your repository (RLS-scoped) — never put it in
the payload.

## 7. Data lifecycle: deletion and export

Every new module must declare `dataLifecycle` — this is how "delete my account" and "export my
data" stay complete without anyone editing central scripts.

```ts
dataLifecycle: {
  // What "delete this user" must remove. Strategy is cascade-only in this slice:
  // your FK chain to app.users does the deletion; this declaration drives the
  // before/after count sweep and the cascade-verification test.
  deletion: {
    strategy: "cascade",
    tables: [
      { table: "app.your_table" },                                // owner_user_id = $1::uuid (default)
      { table: "app.your_other", countPredicate: "user_id = $1::uuid" } // custom predicate
    ]
  },
  // What full-account export includes. Runs under the actor's own RLS-scoped
  // DataContextDb; return a JSON-serializable object. Declare an explicit empty
  // array if you genuinely have nothing to export (the parity check requires the
  // explicit statement — silence is not allowed).
  exportSections: [
    {
      key: "yourModule",
      displayName: "Your Module",
      collect: async (scopedDb, ctx) => {
        const db = assertDataContextDb(scopedDb);
        return { rows: await db.selectFrom("app.your_table")/* ... */ };
      }
    }
  ]
}
```

What enforces this: boot-time registration rejects new modules without `dataLifecycle`; the
cascade integration test proves each declared table really cascades from `app.users`; the
export integration tests (`tests/integration/data-export.test.ts`) are the parity guard
pattern to follow.

## 8. External data: the dataset connector SDK

If your module fetches data from the outside world, you do **not** call `fetch`. You declare
the source in the manifest and implement an adapter; the platform runs your fetches inside a
hardened runtime (`@jarv1s/datasets`).

Declare the source:

```ts
externalSources: [
  {
    id: "your-source", // globally unique
    displayName: "Your Source",
    credential: "none", // "api-key" is reserved and REJECTED today
    fetchHosts: ["api.example.com"], // exact lowercase hostnames — no ports, no IPs
    imageHosts: ["img.example.com"], // hosts your UI renders images from (feeds the CSP)
    datasets: [
      { key: "things", ttlMs: 10 * 60 * 1000, staleness: "degrade-empty" },
      { key: "feed", ttlMs: 3 * 60 * 1000, staleness: "serve-stale-on-error" }
    ]
  }
];
```

Implement the adapter:

```ts
export function createYourAdapter(): ExternalSourceAdapter {
  return {
    async fetchDataset(datasetKey, params, ctx) {
      // ctx.fetchFn is host-pinned: https-only, exact-hostname allowlist,
      // re-validated on every redirect hop. Using global fetch here is a bug.
      const res = await ctx.fetchFn(`https://api.example.com/${datasetKey}`);
      return res.json();
    }
  };
}
```

The composition root wires `createDatasetClient(source, adapter)` and hands the client to your
routes/services. What the runtime gives you:

- **SSRF protection**: any URL or redirect leaving your declared `fetchHosts` throws.
- **TTL caching** per dataset with two staleness policies: `degrade-empty` (fall back to the
  caller-supplied `fallback` on failure) or `serve-stale-on-error` (serve the expired entry as
  `degraded: true` for up to `staleRetentionMs`, default 6 h).
- **Graceful degradation**: `getDataset` never throws on fetch failure — you always get a
  `{ data, degraded, fetchedAt }` envelope. Surface `degraded` in your UI.

Constraints to respect: hostnames must pass `isPinnableHost` (lowercase, no port, no IP
literal); authenticated sources are out of scope until the api-key slice lands; the cache is
instance-level and keyed by params only — if a future dataset is per-user, user identity must
be part of `params`. Full worked example: `packages/sports/src/source/espn-source.ts`.

## 9. Frontend: the module web registry

Your UI docks into the shell through the `"./web"` subpath export — no edits to `apps/web`.
A build-time scanner (`virtual:jarvis-module-web`) discovers every workspace package declaring
that export, validates it, and generates the wiring.

`src/web/index.tsx` default-exports a `ModuleWebContribution`:

```tsx
import type { ModuleWebContribution } from "@jarv1s/module-web-sdk";

const contribution: ModuleWebContribution = {
  moduleId: "your-module", // must equal the manifest id
  routes: [{ path: "/yours", title: "Yours", icon: "puzzle", order: 40, element: <YourPage /> }],
  todayWidgets: [{ slot: "brief", element: <YourTodayWidget /> }],
  commandPaletteEntries: [
    /* optional */
  ],
  onboarding: {
    /* optional tour section + welcome line */
  }
};
export default contribution;
```

Rules the scanner and tests enforce:

- Each route `path` must match a manifest `navigation[].path`; duplicate paths across modules
  fail the build.
- **Browser safety**: nothing reachable from `./web` may import `node:*` or backend code —
  don't import your own `manifest.ts` from web code (it pulls in `node:url`); mirror the few
  literals you need and let `tests/unit/module-web-scanner.test.ts`-style assertions keep them
  in sync. `tests/unit/module-web-browser-safety.test.ts` is the guard.
- Routes render lazily and are gated by module enablement automatically — a disabled module's
  page is unreachable without you writing gating code.

Conventions:

- **HTTP**: use `requestJson` from `@jarv1s/module-web-sdk` — identical behavior to the shell's
  client (cookie credentials, `X-Timezone`, typed `ApiError`). Paths are relative (`/api/...`).
- **React Query keys**: `[moduleId, ...]` tuples, e.g. `["your-module", "overview"]`.
- **Design system**: use the authored `jds-*` primitives and existing patterns (serif headings,
  mono eyebrows, sans body). Raw CSS colors belong in `apps/web/src/styles/tokens.css` only.
  Empty/loading states reuse existing authored patterns. The lucide `Sparkles` icon is banned
  (lint-enforced).
- **Settings pane**: declare a `settings` surface in the manifest with `entry: "./settings"`
  and export it from `./settings` — same scanner mechanism (`virtual:jarvis-module-settings`).

## 10. Boundary gates (what will fail your build)

Two complementary gates, both in `pnpm verify:foundation`:

- **ESLint `no-restricted-imports`** on all `packages/*/src` and `apps/*/src`: bans
  `@jarv1s/*/src/*` deep imports, package-crossing relative imports, and `**/packages/*/src/*`
  path imports. Test directories are exempt.
- **`scripts/check-package-deps.ts`**: every import must be declared in your `package.json`;
  every declared `@jarv1s/*` dependency must actually be imported.

Also enforced repo-wide: `check:file-size` caps every source file (CSS included) at 1000
lines — split by section rather than fighting it.

## 11. AI integration

Declare `assistantTools` in the manifest with an honest `risk` (`read` / `write` /
`destructive`) and `executionPolicy` (`auto` / `confirm`). Tools receive RLS-scoped data
access; results must never include secrets. Never name a provider or model — request
capabilities and let the user's configured router decide.

- Every `assistantTools[].name` and `assistantTools[].permissionId` must be prefixed with
  `"<moduleId>."` (e.g. `"acme-widgets.lookup"`). This is enforced by
  `validateExternalModuleManifest` as an anti-spoof check — an unprefixed name or permission id
  fails the build.
- Any declared external data source's `fetchHosts` must be a non-empty array of lowercase
  hostnames, no ports, no IP literals (see §8). An empty or missing `fetchHosts` array fails the
  build.
- A tool's `executionPolicy: "auto"` requires `actionFamilyId` to name a declared
  `assistantActionFamilies` entry whose `allowedTiers` includes `"trusted_auto"`; otherwise omit
  `executionPolicy` or use `"confirm"` (read-only tools should not set `executionPolicy` at all).
  Violating this fails with `requires an actionFamilyId` or `requires family ... to allow
trusted_auto`.
- Any `actionFamilyId` must match a family id declared in `assistantActionFamilies`, or the build
  fails with `references undeclared action family`.

## 12. Registration (composition root)

A bundled module is activated by one entry in `BUILT_IN_MODULES`
(`packages/module-registry/src/index.ts`):

```ts
{
  manifest: yourModuleManifest,
  sqlMigrationDirectories: [yourModuleSqlMigrationDirectory],
  queueDefinitions: [...YOUR_QUEUE_DEFINITIONS],       // or []
  registerRoutes: (server, deps) => {
    // DI wiring lives HERE, not in the module: construct dataset clients,
    // repositories, etc., and hand them to your register function.
    const client = createDatasetClient(source, createYourAdapter(), { fetchFn: deps.fetchFn });
    registerYourRoutes(server, { dataContext: deps.dataContext,
      resolveAccessContext: deps.resolveAccessContext, datasetClient: client });
  },
  registerWorkers: (boss, deps) => { /* if you have jobs */ }
}
```

The `LOADER-SEAM(sports)` comments in that file mark every touchpoint a future dynamic loader
will replace — keep your entry to the same shape.

## 13. Distribution

Downloaded modules ship as GitHub Release artifacts and install separately without rebuilding
core. Once installed, they use the same product model and the host contracts exposed by the
downloaded-module ABI. This section covers only the distribution-specific surface — manifest
authoring, RLS, and the web entry are unchanged from the rest of this guide. Internal source paths,
loader APIs, and security checks retain the name `external`.

**Publishing.** `scripts/publish-module-registry.ts` builds the publication set: for each module
source directory under the internal `external-modules/` path (dockerignored — the core image never
ships it), it runs the JS-01 bundler, validates the manifest, and packs a portable gzip tarball of
exactly the on-disk trust set (`jarvis.module.json` + `dist/**` + `sql/**`) as
`<id>-<version>.tgz` (a bare filename, never a URL — `ARTIFACT_FILENAME_RE` in
`packages/module-registry/src/distribution/index-schema.ts` rejects anything else and the whole
registry entry is dropped, fail-closed). It also emits `index.json`, retaining the current version
plus the 4 previous per module (`REGISTRY_RETAINED_VERSIONS = 5`). `.github/workflows/
modules-registry.yml` runs this in CI on release; run the script locally to test a publish before
tagging. **Bump the manifest and package version for every trust-set change.** Update detection is
version-based, and the publisher rejects a same-version artifact when its filename, SHA-256, or size
differs; only an identical idempotent rerun is allowed.

**Declaring owned tables and migrations.** No distribution-specific syntax beyond what §4 already
covers: `database.ownedTables` in the manifest plus a `sql/` migrations directory is exactly what
both the bundled and downloaded install paths consume.

**Install lifecycle.** Downloaded-module discovery is always on; do not set
`JARVIS_ENABLE_EXTERNAL_MODULES`. Admins use **Settings → Instance modules** to download and stage a
package, then restart Jarvis so boot reconciliation validates and installs it. The same settings
surface handles enable/disable/remove/purge
(`ModuleRegistrySection`, `apps/web/src/settings/settings-module-registry-section.tsx`) through the
admin routes documented for `routes-module-registry.ts`. Boot reconcile applies migrations and
creates the module's Postgres roles
(`jarvis_mod_<slug>_runtime`, `jarvis_mod_<slug>_install`), remove disables without touching data,
purge drops owned tables and roles. The admin registry list reflects a boot-time-only discovery
snapshot of the downloaded package directory (`discoverExternalModules` is the internal function
name in `apps/api/src/server.ts`) — a
process restart is required to see on-disk changes; this is a deliberate startup-only design, not
a bug.

**`JARVIS_MODULES_ENSURE`.** Comma/whitespace-separated `id` or `id@version` tokens
(`packages/module-registry/src/distribution/ensure-list.ts`), parsed leniently: invalid IDs and
duplicates become non-fatal parse errors rather than a boot crash, and the first entry wins on a
duplicate ID. Boot reconcile downloads and installs every listed module that isn't already
present, applying migrations as it would for an admin-triggered install.

**Dev parity.** `pnpm db:reconcile` (`tsx scripts/module-reconcile.ts`) runs the same reconcile
pass boot uses, against your local registry and `JARVIS_MODULES_ENSURE` — use it to test an
install/update/purge cycle without restarting the whole server. #1468: once a target has a
bootstrap owner, this confirms `MOSS_RECONCILE_CONFIRM_OWNER_EMAIL` matches that owner's email
before proceeding (fresh installs are exempted).

### Runtime credential writes (`ctx.auth.setCredential`)

Workers may persist runtime-minted secrets (e.g. the access token from an
OAuth-style exchange) with `await ctx.auth.setCredential(authId, value)`:

- `authId` must be a declared `auth` entry with `scope: "user"`. Instance-scope
  credentials are always human-entered via admin settings.
- Only write-risk tool invocations may call it; the value must be a non-empty
  string of at most 32 KiB.
- One slot holds one string. Modules needing per-item tokens store a JSON map
  inside a single declared slot — and must serialize their own
  read-modify-write (run token-touching work on a single per-user queue;
  concurrent writers are last-writer-wins and will drop each other's entries).
- The written value is treated like a resolved secret for the rest of the
  invocation: it is redacted from worker output and rejected from `ctx.ai` /
  `ctx.fetch` inputs.

### Instance KV write policy (`instanceWritePolicy`)

Instance-scoped KV writes from handlers are admin-gated by default. A storage
declaration with `"instanceWritePolicy": "module"` opts that namespace into
handler writes for any acting user — use it for module-managed shared pools.
The admin approves this as part of the reviewed, hash-pinned manifest.

## 14. Pre-flight checklist

Before opening a PR:

- [ ] Approved spec in `docs/superpowers/specs/` + GitHub `task` issue (in-repo modules).
- [ ] Manifest declares `dataLifecycle` (explicit empty `exportSections` if truly none).
- [ ] Every owned table: RLS policies + `ON DELETE CASCADE` chain to `app.users`.
- [ ] Migration row added to `tests/integration/foundation.test.ts`; full
      `pnpm test:integration` run.
- [ ] All external fetches go through a declared source + adapter (`ctx.fetchFn` only).
- [ ] `./web` entry is browser-safe (no `node:*`, no manifest import) and mirrors manifest
      navigation literally.
- [ ] No deep imports of other modules; `package.json` deps exactly match imports.
- [ ] Shared API contracts in `packages/shared/*-api.ts`; permissions declared and used.
- [ ] `pnpm verify:foundation` green locally (record commands + exit codes if CI is down).

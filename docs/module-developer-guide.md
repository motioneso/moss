# Moss Module Developer Guide

Code-grounded authoring guidance, refreshed 2026-09-04 against `~/Jarv1s` at `bedfb0382`.

Moss presents one product concept, **Modules**, through two different authoring contracts:

- **Built-in modules** are compiled workspace packages under `packages/`. Sections 2–12 describe
  that contract: a TypeScript `MossModuleManifest`, public package APIs, and build-time web exports.
- **Custom/installable modules**, including Workshop output, ship `jarvis.module.json` and built
  worker/web files. Start at [§13](#13-custom-and-installable-modules). Their JSON manifest and
  host RPC APIs are different; copying a built-in manifest does not create a valid custom module.

The existing `jarvis.module.json` filename, `compatibility.jarv1s` key, and internal `external`
identifiers remain API names. Use current `@moss/*` package imports.

Source code is authoritative when historical comments or older specs disagree. The main references
are `packages/module-sdk/src/index.ts`, `packages/module-sdk/src/external-module.ts`,
`packages/module-sdk/src/worker.ts`, `packages/module-registry/src/external/validate.ts`, and
`apps/web/src/external-modules/loader.ts`. Product/design rules live in
[DEVELOPMENT_STANDARDS.md](DEVELOPMENT_STANDARDS.md).

This guide describes current contracts, not proof of a functioning Workshop build. The
[Workshop assessment and redesign requirements](reviews/2026-09-04-workshop-assessment.md)
separate agreed behavior from missing implementation and open product decisions.

---

## 1. Ground rules

These are platform invariants. A module that violates any of them will be rejected at
registration, by CI gates, or in review — they are not conventions.

1. **Private by default.** All user data is owner-only unless explicitly shared. Every
   module-owned table gets Row-Level Security; admins get no data bypass (admin power is
   configuration power only).
2. **Module isolation.** Modules collaborate only through declared public APIs and events.
   Never import another module's internals (`@moss/other/src/...`) or query another module's
   tables. Two automated gates enforce this (see §10).
3. **Host-scoped data access.** Built-in repositories accept the branded `DataContextDb`, never a
   root Kysely instance; vault I/O uses `VaultContext`. Custom module workers use the host RPC
   ports in §13 rather than importing database or vault internals.
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
│   ├── manifest.ts       # the MossModuleManifest (the docking contract)
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
  "name": "@moss/your-module",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts", // backend public API
    "./settings": "./src/settings/index.tsx", // settings pane (optional)
    "./web": "./src/web/index.tsx" // frontend contribution (optional)
  },
  "dependencies": {
    "@moss/module-sdk": "workspace:*", // manifest types (always)
    "@moss/db": "workspace:*", // DataContextDb (backend)
    "@moss/module-web-sdk": "workspace:*", // only if you ship "./web"
    "@moss/datasets": "workspace:*" // only if you declare externalSources
  }
}
```

Declare **every** package you import. The `check:package-deps` gate fails on undeclared
imports (they only work by accident of pnpm hoisting) and on declared-but-unused
`@moss/*` dependencies.

## 3. The manifest

`src/manifest.ts` exports one `MossModuleManifest` object — the single declaration the
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
} satisfies MossModuleManifest;
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
  add your migration's row there and verify through the isolated verify-gate procedure.

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

Every new built-in module must declare `dataLifecycle` — this is how "delete my account" and "export my
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
hardened runtime (`@moss/datasets`).

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
A build-time scanner (`virtual:moss-module-web`) discovers every workspace package declaring
that export, validates it, and generates the wiring.

`src/web/index.tsx` default-exports a `ModuleWebContribution`:

```tsx
import type { ModuleWebContribution } from "@moss/module-web-sdk";

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

- **HTTP**: use `requestJson` from `@moss/module-web-sdk` — identical behavior to the shell's
  client (cookie credentials, `X-Timezone`, typed `ApiError`). Paths are relative (`/api/...`).
- **React Query keys**: `[moduleId, ...]` tuples, e.g. `["your-module", "overview"]`.
- **Design system**: use the authored `jds-*` primitives and current typography tokens
  (`--font-display` for headings, `--font-sans` for body and labels; no new mono or serif styles). Raw CSS colors belong in `apps/web/src/styles/tokens.css` only.
  Empty/loading states reuse existing authored patterns. The lucide `Sparkles` icon is banned
  (lint-enforced).
- **Settings pane**: declare a `settings` surface in the manifest with `entry: "./settings"`
  and export it from `./settings` — same scanner mechanism (`virtual:moss-module-settings`).

## 10. Boundary gates (what will fail your build)

Two complementary gates, both in `pnpm verify:foundation`:

- **ESLint `no-restricted-imports`** on all `packages/*/src` and `apps/*/src`: bans
  `@moss/*/src/*` deep imports, package-crossing relative imports, and `**/packages/*/src/*`
  path imports. Test directories are exempt.
- **`scripts/check-package-deps.ts`**: every import must be declared in your `package.json`;
  every declared `@moss/*` dependency must actually be imported.

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

## 13. Custom and installable modules

This is the contract Workshop must target. Use `JsonMossModuleManifest`, the custom worker SDK,
and the external web loader; sections 2–12 are not a template for this path.

### 13.1 Package and manifest

A source directory is independent of the core workspace. The host's
`scripts/build-external-module.ts` builds these conventional entrypoints:

```text
<module>/
├── jarvis.module.json
├── src/worker/index.ts      # defineModuleWorker from @moss/module-sdk/worker
├── src/web/index.ts         # optional web entry; may import sibling .tsx components
├── sql/                    # optional, installed by the privileged host migration path
└── dist/
    ├── worker.js           # bundled Node CJS
    └── web/index.js        # browser ESM using the host React runtime
```

A minimal manifest for a module with a worker and page is:

```json
{
  "schemaVersion": 1,
  "id": "example-module",
  "name": "Example module",
  "version": "0.1.0",
  "publisher": "Module author",
  "lifecycle": "optional",
  "compatibility": { "jarv1s": ">=0.1.0" },
  "runtime": { "workerEntrypoint": "dist/worker.js", "workerContractVersion": 1 },
  "web": { "entrypoint": "dist/web/index.js", "contractVersion": 2 },
  "navigation": [{ "id": "example-module", "label": "Example module", "path": "/" }]
}
```

The example is a structural starting point. Choose a compatibility range matching the actual
APIs used; add only capabilities the module needs. The validator is
`validateExternalModuleManifest` in `packages/module-registry/src/external/validate.ts`.
Its normalized result is the host contract; unknown fields can be dropped and must not be treated
as supported. Certain built-in fields are explicitly rejected.

| Need                            | Custom JSON declaration or API                                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity and core compatibility | `schemaVersion`, `id`, `name`, `version`, `publisher`, `lifecycle`, `compatibility`                                                            |
| Assistant tools                 | `assistantTools` with handler names, bounded input schemas, honest risk, and module-prefixed names/permission IDs; handlers live in the worker |
| Approval/action policy          | `assistantActionFamilies` and supported tool policy fields; an automatic policy requires a matching declared family allowing it                |
| External network access         | Top-level `fetchHosts`; request through worker `ctx.fetch`                                                                                     |
| Credentials                     | `auth` declarations and host-managed slots; worker `ctx.auth`                                                                                  |
| Stored records                  | `storage` namespaces and scopes; worker `ctx.kv`                                                                                               |
| Owned database tables           | `database.ownedTables`, package SQL, and host provisioning; worker `ctx.db.query`                                                              |
| Scheduled/background work       | `worker.queues`, `worker.schedules`, `worker.reconcileJobs`; not built-in `jobs`                                                               |
| Page and navigation             | `web` contract v2 and `navigation` paths relative to `/m/<moduleId>`                                                                           |
| Host-rendered settings          | `preferences` (currently boolean or integer, with nullable integer support), not a `settings` component                                        |
| Briefing contribution           | `briefing` with worker handler and supported sections                                                                                          |
| Notifications                   | Worker `ctx.notify.post`; not a top-level `notifications` manifest field                                                                       |
| Assistant onboarding            | `assistantOnboarding`                                                                                                                          |

Do not copy built-in `availability`, `permissions`, `settings`, `routes`, `jobs`, `dataLifecycle`,
`externalSources`, or executable provider fields into this JSON. The full forbidden-field list
and individual validation rules are in the validator; the public declaration types are in
`packages/module-sdk/src/external-module.ts`.

### 13.2 Worker access and authority

Register named handlers using `defineModuleWorker` from `@moss/module-sdk/worker`. Handler input
arrives as `ctx.input`; validate it and the data returned by outside services. Never import core
repositories or another module's internals, open a direct database connection, or obtain data by
reading host files. Stdout carries the JSON-RPC protocol; do not write application logs to it.

`ModuleWorkerContext` in `packages/module-sdk/src/worker.ts` exposes:

- Declared storage through `ctx.kv`; user scope is actor-bound by the host. Instance scope is
  shared state, not private user storage. Declare any intentional sharing. Instance writes default
  to admin-only; `instanceWritePolicy: "module"` explicitly permits handler writes by other actors.
- Declared credentials through `ctx.auth.getCredential`. Runtime token refresh is supported by
  `setCredential` only for declared user-scoped slots on write-risk invocations. A module can read
  its authorized secret to contact its service; it must never return that secret to the browser,
  AI, logs, exports, or queue payloads. The Workshop builder must not receive credential values.
- Host-mediated fetch through `ctx.fetch`, with exact declared hosts and redirect checks. Optional
  `fetchHostGrantsNamespace` adds actor-specific host grants from a declared user KV namespace;
  this broadens authority and needs an explicit reviewed grant flow, not blanket network access.
- Parameterized queries through `ctx.db.query` against owned tables, under the module role and RLS.
  Interactive SQL is restricted to SELECT/INSERT/UPDATE/DELETE, with read-risk enforcement,
  a 5-second statement timeout, 5,000-row cap, and 5 MiB result cap. No runtime DDL.
- Structured AI through `ctx.ai.generateStructured({ schema, prompt, tierHint })`, embeddings
  through `ctx.embed`, actor-scoped extracted attachment text through `ctx.attachments.readText`,
  and bounded notifications through `ctx.notify.post`. Host configuration and invocation risk
  still apply; a port's presence does not mean every call will succeed.
- Resolved `ctx.preferences`, `ctx.localTimezone`, and `ctx.deadlineAt`. Use the user's timezone
  for calendar-day behavior. Handle an unset integer preference as unset, not zero.

Enforcement is in `packages/module-registry/src/external/worker-rpc-host.ts` and
`packages/db/src/module-storage-rpc.ts`. Read-only invocations cannot mutate KV/credentials or post
notifications. Respect deadlines; declared queue timeouts cannot exceed `MAX_INVOCATION_MS`.
Keep queue payloads metadata-only and make retryable/scheduled work safe to repeat.

**Enforcement limit:** `external/worker-runtime.ts` launches a Node subprocess with a restricted
environment and host RPC checks. That launcher does not establish an OS filesystem/network sandbox.
Using only the SDK is an authoring rule, not proof that arbitrary module code cannot bypass RPC via
Node APIs. The Workshop redesign must resolve execution confinement before claiming that stronger
security guarantee. Do not weaken host checks or represent prompt instructions as a sandbox.

### 13.3 Database schema and user-data lifecycle

The custom database manifest contains only `ownedTables`. Table names must use the module's
normalized prefix, such as `app.example_module_items`. SQL belongs in the module's `sql/` directory;
never change applied files. The custom migration validator currently accepts one statement per file
from its explicit command allowlist. Do not copy the built-in global migration procedure.

The privileged host installer (`scripts/module-install.ts`) creates scoped roles, runs accepted
migrations, and generates table RLS through `packages/db/src/module-rls-emitter.ts`. Authors declare
schema; they do not grant roles or supply replacement security policies. Use the expected
`owner_user_id` ownership/cascade structure and stable row IDs; host export reads order by `id`.

The host derives custom table export/deletion coverage from `database.ownedTables`, rather than a
function-valued `dataLifecycle` field. See `readExternalModuleExportRows` in
`packages/settings/src/data-export.ts` and `getExternalModuleDeletionTables` in
`packages/module-registry/src/index.ts`. Generic host KV covers its own account export/deletion.
Test ownership, export, deletion, and data-preserving upgrades for the chosen schema.

**Workshop limit:** `installModuleDraft` validates the manifest, hashes/stages the folder, and
writes the draft row. It does not call the database installer. SQL support in the ordinary
installation path does not prove live SQL-backed Workshop drafts work. Until that path is supplied
and verified, Workshop must disclose this limitation during requirements gathering. Host KV may
satisfy a request without custom tables; do not substitute it silently if it changes the requirements.

### 13.4 Web UI and integration with Moss

The custom web entry exports `{ contractVersion: 2, Root, css? }`, as in
`external-modules/finance/src/web/index.ts`. It does not export the built-in `ModuleWebContribution`.
`Root` receives host actions and an optional assistant-surface handle. Use the supported host APIs;
do not import `apps/web` internals. The loader in `apps/web/src/external-modules/loader.ts` currently
renders an empty component on incompatible/malformed exports, so successful bundling is not enough.

Use components and runtime hooks exported by `@moss/module-web-sdk`; the bundler maps React to the
host runtime. Never ship a second React copy. Browser code must stay free of Node/database/secrets.
Module tool reads use the host's read-tool invocation API. Mutations must use a supported write
path with host approval/risk enforcement; a read-only tool endpoint is not a general write API.

Export CSS as the contribution's `css` string. The host confines it to the module and owns style
mount/unmount; do not inject a global style tag. Follow the host design tokens and `jds-*` primitives,
including accessible inputs, keyboard/focus behavior, user timezone, and useful empty/loading/error
states. Keep module CSS for supported layout; do not redefine Moss's global visual identity.

Keep navigation labels/paths, tool descriptions, and preferences truthful. App-map truthfulness
also requires feature/error/remediation metadata. **Current gap:** the custom JSON type has no
`features` field, and the app-map reader queries a built artifact. Merely inventing that field in
`jarvis.module.json` will not register a generated module's features. The Workshop design needs a
supported host declaration/refresh path for that metadata; record this as a prerequisite.

### 13.5 Build, install, draft, and shipping are distinct operations

A developer/host can bundle an authorized source directory from `~/Jarv1s` with:

```sh
pnpm exec tsx scripts/build-external-module.ts <module-source-directory>
```

This runs esbuild, not generated tests, database migrations, or live UI acceptance checks. The
current Workshop builder is instructed not to run shell commands; host code owns this operation.
Run meaningful module checks separately and exercise the real page/tools before declaring success.

For distributed packages, publication validates and packs the trust set (`jarvis.module.json`,
`dist/**`, `sql/**`) and updates the signed catalog. The installed manifest/package hashes and
version identify the accepted artifact. Bump the version when that trust set changes. Download,
SQL provisioning, staged update acceptance, and purge use the privileged host reconcile lifecycle;
reconcile is not a command generated module code may run.

Live discovery exists: `POST /api/admin/modules/rescan` refreshes the API's discovered modules and
signals the worker. Discovery does not provision a schema or accept every staged update.
Workshop's “Look at the draft” currently requests a rescan before navigating to its page.

A draft is owned by its author. `POST /api/admin/modules/:id/ship` is admin- and owner-checked;
`shipExternalModule` changes it to enabled and clears draft ownership. This currently combines
finishing with wider availability; it does not implement a separate finished-but-private state.
Draft deletion uses `DELETE /api/admin/modules/:id/draft`; ordinary module removal/purge follow
separate host lifecycle operations. Specify effects on saved data before destructive actions.

Workshop generation/refinement still needs its own end-to-end proof. Do not treat validation,
installation, or a closed issue as evidence that the module works for its user.

## 14. Pre-flight checklist

For built-in modules, before opening a PR:

- [ ] Approved spec in `docs/superpowers/specs/` + GitHub `task` issue (in-repo modules).
- [ ] Manifest declares `dataLifecycle` (explicit empty `exportSections` if truly none).
- [ ] Every owned table: RLS policies + `ON DELETE CASCADE` chain to `app.users`.
- [ ] Migration row added to `tests/integration/foundation.test.ts`; full
      integration verification through the verify-gate skill.
- [ ] All external fetches go through a declared source + adapter (`ctx.fetchFn` only).
- [ ] `./web` entry is browser-safe (no `node:*`, no manifest import) and mirrors manifest
      navigation literally.
- [ ] No deep imports of other modules; `package.json` deps exactly match imports.
- [ ] Shared API contracts in `packages/shared/*-api.ts`; permissions declared and used.
- [ ] Repository verification through the verify-gate skill; never run DB-touching gates bare.

For custom modules and Workshop output:

- [ ] Requirements and acceptance examples fit the installed custom-module capabilities.
- [ ] Manifest passes the existing validator; every declared handler and artifact exists.
- [ ] Supported SDK access, input validation, owner isolation, and credential boundaries hold.
- [ ] Meaningful tests run and the actual module renders/behaves through real navigation.
- [ ] Settings, navigation, tool descriptions, and app-map coverage match shipped behavior.
- [ ] Data survives supported changes; export/delete and removal behavior are verified.
- [ ] Draft, approval, sharing, restart, and cleanup behavior are demonstrated, with failures visible.

Run formatter/static checks appropriate to changed files. Any DB-touching verification uses
`.claude/skills/verify-gate/SKILL.md` and its isolated database procedure. User-facing repository PRs
also need live-path evidence and the release-note/app-map requirements in DEVELOPMENT_STANDARDS.md.
These are developer checks; do not give the generated builder authority to run core deployment or
database administration commands.

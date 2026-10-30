# Module Distribution & Install — Design Spec

- **Date:** 2026-07-12
- **Issue:** task #964 — Part of epic #860 (pluggable modules)
- **Grounded on:** `origin/main` @ `c23a93b8` (verified via detached read-only worktree)
- **Status:** DRAFT — awaiting Ben + adversarial council review (per issue #964 process gate)
- **Depends on:** spec `2026-07-08-open-module-system-user-authored-modules.md` (#818,
  built through discovery/enable) and spec `2026-07-09-module-data-plane.md` (#914, built
  but dormant — no caller invokes the 4-phase installer yet)

## 1. Problem

Jarvis can discover, validate, hash-pin, and (via the dormant #914 installer) privilege-install
external modules — but there is no way for a module to _arrive_ on an instance. The
`external-modules/` sources are dockerignored out of the published image, prod compose mounts no
modules directory, and `scripts/module-install.ts` has no caller. #964 closes the loop: a
registry the app can query, an in-app admin download, integrity verification of fetched
artifacts, and a safe invocation path for the privileged installer.

**Locked product decisions (from the #964 interview):**

- Users never run docker/terminal commands to install a module. The whole flow is: admin
  clicks Download in Settings → restarts the container → module is installed and enabled.
  Restart is the only ops action, ever.
- v1 registry is the Jarv1s repo's own CI-published index — a single hard-pinned source. No
  configurable registry URLs, no third-party repos (marketplace follow-on).
- Trust posture is **HTTPS + hash pinning with guardrails** (HACS-style, option C): no
  artifact signing in v1, but the index schema reserves a `signature` field so a marketplace
  can add it without a schema break.
- Modules declared in the compose file are ensured present at boot: downloaded from the
  registry if missing, then installed in the same boot pass.

## 2. Goals

1. CI publishes an artifact-per-module registry (index + tarballs) from `external-modules/**`.
2. Admin-gated, unprivileged in-app download: fetch → verify → safe-extract → atomic stage
   into a writable modules volume, with the admin's intent recorded as a staged hash.
3. Boot-time module reconcile in the prod supervisor: accept staged content as the new
   trusted baseline, auto-enable, and run the #914 4-phase installer for `ownedTables`
   modules — after core migrations, before the API starts.
4. Declarative `JARVIS_MODULES_ENSURE` compose env: ensure-present (download + install at
   boot), one-way, offline-tolerant.
5. In-app uninstall: **Remove** (files + disable, data preserved) and **Remove and purge
   data** (marked in-app, executed at next boot by the privileged phase).
6. Settings UX exposing the full lifecycle with a pre-download capability review.

## 3. Non-goals

- No third-party or user-configurable registry sources; no marketplace; no module browsing
  of arbitrary GitHub repos.
- No cryptographic artifact signing (index reserves `signature: null` per entry).
- No hot reload — installing, updating, and purging always take effect at restart.
- No in-app restart button (a restart-hint footnote in the existing settings style is fine).
- No automatic background update checks; the registry list refreshes when an admin opens the
  Modules screen (server-side cache, below).
- No SQL downgrade/rollback — module migrations are forward-only per #914.
- No change to the #818 runtime security model (frozen runtime global, worker isolation,
  tool confirm flow) — this spec is purely arrival + install lifecycle.

## 4. Design overview

```
CI (merge to main touching external-modules/**)
  └─ build tarballs + index.json → rolling GitHub Release tag `modules`

Admin (Settings → Modules)                         Operator (compose env)
  └─ POST download ──┐                               JARVIS_MODULES_ENSURE=…
                     ▼                                        │
        API process (unprivileged)                            │
          fetch (pinned hosts) → size cap → sha256 vs index   │
          → safe-extract → #818 package validation            │
          → atomic rename into JARVIS_MODULES_DIR/<id>        │
          → record staged_version + staged_package_hash       │
                     │                                        │
                container restart                             │
                     ▼                                        ▼
        Boot supervisor (scripts/start-jarv1s.ts, has bootstrap URL)
          core migrate.ts → module-reconcile:
            ensure-present fetches (compose list, same verify path)
            on-disk hash == staged hash → pin baseline + auto-enable
            ownedTables → run #914 4-phase installer (advisory-locked)
            purge_requested → drop tables/roles/ledger/rows + delete files
            hash matches neither pinned nor staged → drift auto-disable
          → start API + worker (unprivileged URLs only)
```

The privilege boundary is unchanged from #914: only the boot supervisor ever holds the
bootstrap URL; the API/worker processes download files but can never execute DDL, and
downloaded code never loads until a restart when the module is enabled.

## 5. Registry & publishing (CI)

A new CI job runs on merge to `main` when `external-modules/**` changes:

1. For each module under `external-modules/`, run `scripts/build-external-module.ts`, then
   pack `jarvis.module.json` + `dist/**` + `sql/**` into `<id>-<version>.tgz` (gzip tar).
   `<version>` comes from the module manifest.
2. Compute SHA-256 and size for each tarball.
3. Generate `index.json` and upload index + tarballs as assets on a **rolling GitHub Release**
   tagged `modules` on `motioneso/jarv1s` (assets replaced in place). One stable URL:
   `https://github.com/motioneso/jarv1s/releases/download/modules/index.json`.

Prior versions' tarballs are retained on the release (versioned filenames), so explicit
`id@version` pins keep working after newer publishes. A retention cap (keep the last 5
versions per module) bounds asset growth.

**Index schema (v1):**

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-12T00:00:00Z",
  "modules": [
    {
      "id": "job-search",
      "name": "Job search",
      "version": "0.3.0",
      "description": "…",
      "artifact": "job-search-0.3.0.tgz",
      "sha256": "…64 hex…",
      "sizeBytes": 123456,
      "compatibility": { "jarv1s": ">=0.1.10" },
      "capabilities": {
        "permissions": ["…"],
        "fetchHosts": ["…"],
        "tools": [{ "name": "…", "risk": "read" }],
        "ownsTables": false
      },
      "signature": null
    }
  ]
}
```

- `artifact` is a bare filename, resolved against the release download base — the index can
  never point the server at an arbitrary URL.
- `capabilities` is denormalized from the manifest so the Settings UI can show a capability
  review **before** any bytes are downloaded.
- `compatibility.jarv1s` is a semver range checked against the running core version using
  the existing compat-gate machinery; incompatible entries render as "requires Jarvis ≥ X".
- `signature` is reserved (always `null` in v1); consumers must tolerate unknown fields.
- Each module entry also carries a `previousVersions` array (filename + sha256 +
  sizeBytes only, for the retained versions) so explicit `id@version` pins resolve with
  full hash verification. Only versions present in the index are pinnable.

**Registry URL pinning:** the index URL and the allowed artifact hosts
(`github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`) are
constants in code. A `JARVIS_MODULE_REGISTRY_URL` env override exists **only** for
integration tests and is refused when `NODE_ENV=production`.

## 6. Download & staging (in-app, admin-gated, unprivileged)

**New shared contracts** in `packages/shared/` (declare every response field in the route
schema — the fast-json-stringify `additionalProperties:false` trap silently drops
undeclared fields) and **new routes** in `packages/settings/src/routes-modules.ts` following
the existing discipline (`assertAdminUser` FIRST, before any 404/409 branch):

- `GET /api/admin/module-registry` — server-side fetch of the pinned index (10-minute
  in-process cache; `?refresh=1` busts it), merged with local state: on-disk discovery,
  `app.external_modules` enable/staged state, and `app.module_installs` journal status.
  Returns one row per module with a derived lifecycle state (§8). Registry fetch failure
  degrades to local-only rows plus a `registryUnavailable: true` flag — never a 500.
- `POST /api/admin/external-modules/:id/download` body `{ version?: string }` (default:
  latest compatible) — performs the download pipeline below synchronously (artifacts are
  small; 60 s route timeout) and returns the updated module row. Used for install, update,
  reinstall, and retry alike.
- `POST /api/admin/external-modules/:id/remove` body `{ purgeData: boolean }` — see §9.

**Download pipeline** (runs in the API process; no privileged connection involved):

1. Re-fetch and validate the index (never trust a client-supplied URL or hash; the request
   carries only `id` + optional `version`).
2. Resolve the artifact URL; require HTTPS and a host on the pinned allowlist. Follow
   redirects only within the allowlist (GitHub release downloads redirect to the CDN).
3. Stream to `JARVIS_MODULES_DIR/.staging/<id>.tmp/` enforcing caps: index ≤ 1 MiB,
   artifact ≤ 50 MiB (and ≤ the index's `sizeBytes`), hashing while streaming.
4. Verify SHA-256 against the index entry; mismatch → delete temp, 422 with reason.
5. Safe-extract: reject absolute paths, `..` segments, symlinks/hardlinks, and entries
   outside the module root (zip-slip class); cap decompressed size (4× artifact cap) and
   entry count.
6. Validate the extracted package with the existing #818 loader (manifest schema, id
   prefix, `dist/worker.js` + `dist/web/index.js` presence, path bounds). The manifest id
   must equal the requested id and the manifest version must equal the index version.
7. Atomic swap into `JARVIS_MODULES_DIR/<id>`: rename existing dir to
   `.staging/<id>.prev`, rename temp in, then delete `.prev` (restore `.prev` on failure).
   `.staging/` is ignored by boot discovery and swept of stale temp dirs at boot.
8. Compute the package hash exactly as #818 discovery does and record intent on the
   module's `app.external_modules` row (created disabled if absent): `staged_version`,
   `staged_package_hash`, `staged_at`, `staged_by`, `staged_source = 'admin-download'`,
   clear `last_install_error`.

The staged hash is what lets the next boot distinguish "admin authorized this exact
content" from tampering: today any on-disk change to an enabled module trips #818 drift
auto-disable; the staged hash is the one sanctioned exception, consumed at boot.

**Updating an enabled module** is the same pipeline; the running process keeps serving the
old in-memory code until restart. The UI labels the state "update downloaded — restart to
apply".

**Prod compose change:** the `jarv1s` service gains a named volume
`jarv1s-modules:/data/modules` and env `JARVIS_MODULES_DIR: /data/modules`,
`JARVIS_ENABLE_EXTERNAL_MODULES: "1"`. The volume persists across image pulls — this is why
downloads cannot live in `packages/` (image filesystem is discarded on every pull;
`packages/*` is for preinstalled built-ins).

## 7. Boot-time module reconcile (the privileged phase)

New `scripts/module-reconcile.ts`, invoked by `scripts/start-jarv1s.ts` immediately after
`scripts/migrate.ts` and before the API/worker start (the established
privileged-work-at-boot seam). Also runnable standalone; the compose `--profile ops`
`module-install` service switches its command to this script and remains the manual
recovery hatch. All DB work uses `getJarvisDatabaseUrls()` bootstrap/migration URLs; the
whole phase is serialized under a Postgres advisory lock (two supervisors racing must not
double-install).

Order of operations:

1. **Sweep** stale `.staging/` temp dirs.
2. **Purges**: for rows with `purge_requested_at` set — drop the module's owned tables
   (from the `app.module_installs` journal), drop its `jarvis_mod_<slug>_runtime` /
   `_install` roles, delete its `app.module_schema_migrations` ledger rows, its journal
   row, its module KV + credential rows, its `app.external_modules` row, and its files.
   Purges run before ensure-present so a purged module still listed in
   `JARVIS_MODULES_ENSURE` is reinstalled fresh in the same boot rather than re-downloaded
   and immediately destroyed.
3. **Ensure-present** (§7b): fetch any `JARVIS_MODULES_ENSURE` module that is missing or
   pinned to a different version, via the same verify/extract/stage pipeline
   (`staged_source = 'compose-ensure'`, `staged_by = NULL`). Registry unreachable → log
   warning, skip, continue boot. Never fatal.
4. **Scan** the modules dir with the #818 loader.
5. **Accept staged**: on-disk package hash equals `staged_package_hash` → write it (and the
   manifest hash) as the trusted baseline, set enabled, clear staged fields. The admin's
   download (or the operator's compose entry) was the explicit authorization; after restart
   the module is simply on. The one exception is a module an admin switched off
   (`disabled_by_admin`, #3560): acceptance still refreshes the baseline and clears the staged
   fields, but the module stays disabled with the admin's reason. Drift auto-disable and a
   failed database install do not set that mark, so accepting a fresh package can lift them.
6. **Install**: for accepted or already-enabled modules whose manifest declares
   `database.ownedTables`, run the #914 `installModule` (4-phase: roles → single-txn DDL +
   generated RLS → ledger → installer login disabled in `finally`). The per-module ledger
   makes updates apply only their new migrations. Failure → journal `failed`, write
   `last_install_error`, leave the module disabled, **continue with remaining modules and
   boot** — one bad module must not brick the instance.
7. **Drift**: on-disk hash matching neither pinned baseline nor staged hash follows the
   existing #818 drift auto-disable path, now persisted at boot rather than waiting for an
   admin read.

KV-only modules take steps 1–5 and 7 only. Dev boot (`scripts/dev.ts` path) runs the same
reconcile so behavior matches prod.

### 7b. Declarative compose modules

```yaml
JARVIS_MODULES_ENSURE: "job-search, recipes@0.2.0"
```

- Comma-separated; bare `id` = latest compatible version, `id@version` = exact pin.
- **Ensure-present only, one-way.** Removing an id never uninstalls — Remove is an explicit
  in-app action; editing an env var must never destroy data.
- Present-and-unpinned modules are left alone (the in-app update path owns upgrades);
  a differing explicit pin is downloaded and installed as an update.
- Compose declaration carries operator trust: auto-enable applies exactly as for admin
  downloads.
- Unknown ids, incompatible versions, and fetch failures log + surface in the admin UI
  ("declared but not installed") and never block boot.

This gives reproducible instances: a fresh machine with your compose file boots with all
your modules installed.

## 8. Settings UX

The admin Modules screen renders the merged `GET /api/admin/module-registry` list. Derived
lifecycle states and actions:

| State                  | Derivation                                        | Actions                                    |
| ---------------------- | ------------------------------------------------- | ------------------------------------------ |
| Not installed          | in index, not on disk                             | Download (capability review in confirm)    |
| Pending restart        | staged fields set, staged hash ≠ accepted on-disk | banner "Restart Jarvis to finish install"  |
| Installed, enabled     | baseline pinned + enabled                         | Disable, Remove, Remove & purge            |
| Installed, disabled    | on disk, disabled (admin or drift)                | Enable (existing #818 flow), Remove, purge |
| Update available       | index version > installed version                 | Update (same download path)                |
| Update pending restart | staged version set while installed                | banner as above                            |
| Install failed         | journal `failed` / `last_install_error`           | error detail + Retry (re-download/stage)   |
| Declared, not present  | in `JARVIS_MODULES_ENSURE`, missing, fetch failed | info row (boot retries next restart)       |
| Incompatible           | compat range excludes running core                | disabled row, "requires Jarvis ≥ X"        |

- The pre-download confirm dialog shows the index `capabilities` block: permissions, fetch
  hosts, tools with risk levels, and whether the module owns database tables.
- The restart hint uses the existing settings-footnote pattern (like the docker-attach
  footnote); installing never requires any other command.
- Registry unavailable → the screen still renders local modules with a quiet notice.
- Visual design follows the authored `jds-*` system; no new primitives expected.

## 9. Uninstall & purge

- **Remove** (`purgeData: false`): disable the module (existing #818 disable), delete
  `JARVIS_MODULES_DIR/<id>`, clear staged fields. All data — tables, ledger, KV,
  credentials, journal — is preserved; reinstalling the module picks up where it left off
  (ledger prevents re-applying old migrations).
- **Remove and purge data** (`purgeData: true`): everything Remove does, plus set
  `purge_requested_at/by`. The actual destruction runs at the next boot in reconcile step 2
  (only the supervisor holds the privileges to drop tables and roles). The UI requires a
  strong confirmation (type the module id) and then shows "purge pending — takes effect on
  next restart". A pending purge can be cancelled in-app any time before the restart
  (clears the mark).
- Purge is idempotent and crash-safe: every drop/delete is `IF EXISTS`-guarded and the mark
  is cleared last, so a boot crash mid-purge re-runs it cleanly next boot.

## 10. Data model

No new tables. One new migration in `packages/settings/sql/` adds columns to
`app.external_modules`:

| Column                                     | Type          | Purpose                               |
| ------------------------------------------ | ------------- | ------------------------------------- |
| `staged_version`                           | `text`        | version awaiting restart              |
| `staged_package_hash`                      | `text`        | admin/operator-authorized content     |
| `staged_at`                                | `timestamptz` | audit                                 |
| `staged_by`                                | `uuid` NULL   | admin actor (NULL = compose-ensure)   |
| `staged_source`                            | `text`        | `'admin-download'`/`'compose-ensure'` |
| `purge_requested_at`, `purge_requested_by` | ts/uuid       | pending purge mark                    |
| `last_install_error`                       | `text`        | surfaced boot failure reason          |

`app.module_installs` and `app.module_schema_migrations` (#914) are unchanged — journal and
ledger stay install-plane; these columns are distribution-plane. RLS on
`app.external_modules` already restricts writes to admin context; the new columns inherit
it. The boot reconciler writes via the bootstrap/migration connections (not RLS-scoped),
matching how migrate.ts already operates.

**Known trap:** `foundation.test.ts` asserts the full migration list with `toEqual` — the
new migration's row must be added there and the **full** `test:integration` suite run.

## 11. Security invariants

1. **Privilege split:** the API/worker processes never hold bootstrap credentials. The web
   path writes verified files and metadata rows only; all DDL, role, and purge operations
   happen in the boot supervisor (or the explicit ops one-shot).
2. **Nothing executes on download.** Fetched code loads only after a restart, and only if
   enabled; enable/auto-enable requires the hash-pinning chain of custody
   (index sha256 → staged hash → boot acceptance → pinned baseline → #818 drift disable).
3. **Pinned egress:** index URL is a code constant; artifact filenames resolve against it;
   every fetch (including redirects) must land on the HTTPS host allowlist. The index is
   remote data — its contents can never redirect the server elsewhere (SSRF).
4. **Bounded parsing:** size caps on index, artifact, decompressed output, and entry count;
   streaming hash; extraction rejects absolute paths, `..`, and links.
5. **Admin-gated:** every new route authorizes first (`assertAdminUser` before any
   404/409/422 branch — non-admins cannot probe module state).
6. **Fail-closed activation, fail-open boot:** a module that can't verify or install stays
   disabled; but no registry outage or module failure may prevent Jarvis from booting.
7. **Hard invariants untouched:** no BYPASSRLS on runtime roles (module roles unchanged
   from #914); metadata-only writes (staged rows carry ids/hashes, never content); secrets
   never in payloads or logs; installer login disabled in `finally`.
8. **Never edit applied migrations:** the new columns arrive in a new migration file in the
   settings module's `sql/` directory.

## 12. Verification

**Unit** (`packages/*` + `scripts/`): index schema validation incl. unknown-field
tolerance and malformed entries; artifact URL/host allowlist incl. redirect handling;
sha256 verify + size-cap enforcement; safe-extract corpus (zip-slip, symlink, absolute
path, oversize, entry-bomb); staging state machine (download/update/retry/cancel-purge
transitions); `JARVIS_MODULES_ENSURE` parsing (`id`, `id@version`, junk).

**Integration** (against a **mock registry HTTP server** — no live GitHub in CI, using the
test-only URL override):

- download → files staged atomically + staged row recorded; non-admin → 403 on every route.
- boot reconcile: staged hash accepted → baseline pinned + auto-enabled; staged hash accepted
  on a module an admin switched off → baseline pinned, module stays off (#3560); hash matching
  neither → drift-disabled; `ownedTables` fixture module → 4-phase install runs (roles
  exist, RLS emitted, ledger rows recorded, installer login disabled after).
- update: staged new version over enabled module → old version serves until restart, boot
  applies only new migrations.
- compose-ensure: missing module fetched + installed at boot; registry down → boot
  completes with warning; version pin change → update installed.
- remove preserves data + reinstall resumes ledger; purge marks, boot drops
  tables/roles/rows/files, mark cleared; purge crash-safety (re-run idempotent).
- tamper: modify a staged file post-download → boot refuses (hash mismatch → drift path).
- response schemas: exercise via `app.inject` (fast-json-stringify field-drop trap).

**CI publish job:** dry-run mode in CI asserting the generated index validates against the
schema and hashes match the tarballs.

**Gate:** `pnpm verify:foundation` + full `pnpm test:integration` (foundation migration
list updated). Manual QA on the prod-shaped compose: fresh volume boot, download, restart,
verify module active; `JARVIS_MODULES_ENSURE` cold-start.

## 13. Build slices (indicative — writing-plans owns the real breakdown)

1. Registry publisher: packaging + index generation + CI job (+ dry-run test).
2. Fetch/verify/stage library (shared by route and boot) + unit corpus.
3. Data-model migration + staged-state repository methods (+ foundation list update).
4. Admin routes (`module-registry`, `download`, `remove`) + shared contracts.
5. Boot reconcile script + supervisor wiring + ensure-present + purge + ops-profile swap.
6. Settings UI states + capability review + restart banner.
7. Integration suite vs mock registry; compose changes; docs.

## 14. Resolved-during-design decisions (for the council)

- **Why not `packages/`:** image filesystem is discarded on every `docker compose pull`;
  downloaded modules need a persistent writable volume. `packages/*` = built-ins compiled
  into the image at build time.
- **Why restart-to-install instead of live install:** the supervisor already owns
  privileged boot work (migrate.ts); reusing that seam keeps bootstrap credentials out of
  the serving processes entirely and matches Ben's stated UX ("download, then restart").
- **Why auto-enable on staged-hash match:** the download itself is the explicit admin (or
  operator) authorization; requiring a second enable click after restart adds a step
  without adding trust.
- **Why no signing in v1:** HACS ships GitHub-over-HTTPS with zero signing at much larger
  scale; our chain of custody (GitHub repo ACL → CI → release asset → sha256 in index →
  staged hash → pinned baseline → drift disable) is strictly stronger, and the index
  reserves `signature` for the marketplace milestone.

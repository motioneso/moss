# External-Module Navigation ABI (fixes bug #1019)

**Status:** Draft for approval · **Tier: sensitive** (module ABI / cross-module contract /
isolation + supply chain). Review bar: Opus or Fable sign-off on the diff **plus** a live
dev-UAT that reaches the module by clicking its nav entry (Ben's rule, 2026-07-13). CI-green
alone does not close this.

**Author:** Fable (spec authority) · 2026-07-13 · Option B per Ben (full manifest-declared
navigation, not the minimal displayName-derived nav item).

## Problem

`serializeExternalModule` hardcodes `navigation: []` for every external module
(`apps/api/src/server.ts:899-912`, literal at `:905`), while built-ins map manifest
navigation through (`serializeModule`, `server.ts:869-894`). The shell builds nav **only**
from `module.navigation` (`apps/web/src/app-route-metadata.ts:106-140`), so an installed
external module (job-search) is reachable only by typing `/m/job-search`. Compounding:
`navigation` is in the validator's `FORBIDDEN_FIELDS`
(`packages/module-registry/src/external/validate.ts:44-60`, rejected at `:260-264`) — the
manifest ABI never grew the capability.

## Non-goals

- `settings` surfaces for external modules stay `[]` (still forbidden; separate slice).
- No per-module topbar subtitle/eyebrow, no nested nav, no badge counts.
- No change to the module web-bundle contract (`web.contractVersion` untouched).
- Live-path gate hardening beyond this module's UAT → #1000 harness spec.

## Decisions

### D1. Schema versioning — optional field, NO schemaVersion bump

`navigation` becomes an **optional** manifest field under `schemaVersion: 1`. Rationale:
the validator pins the literal `1` and fails closed on anything else (`validate.ts:222`);
bumping to 2 would invalidate every deployed v1 manifest for zero benefit — adding an
optional field is shape-compatible. Old cores reject new manifests that declare
`navigation` (it is in their `FORBIDDEN_FIELDS`) — correct fail-closed behavior; module
authors gate on the core instead via `compatibility.jarv1s: ">=<core version shipping
this>"` (enforced at `validate.ts:245-256`). Remove `"navigation"` from
`FORBIDDEN_FIELDS` and validate it positively (D6), exactly the precedent set when
`web`/`auth`/`storage` (#918) and `database` (#964) were promoted out of that list.

### D2. Nav entry shape — reuse the shared DTO contract

Wire shape on `/api/modules` is the existing `ModuleNavigationEntryDto`
(`packages/shared/src/platform-api.ts:34-40`): `{ id, label, path, icon: string|null,
order: number|null }` — already declared in `moduleNavigationEntrySchema`
(`platform-api.ts:127-139`) and in `moduleSchema.navigation` (`platform-api.ts:176`), so
**fast-json-stringify will not strip it** (recurring trap; no shared-schema change needed).
Manifest shape is the restricted subset:

```jsonc
"navigation": [
  { "id": "job-search", "label": "Job Search", "path": "/", "icon": "briefcase", "order": 900 }
]
```

`id`, `label`, `path` required; `icon`, `order` optional. The built-in
`ModuleNavigationEntryManifest` extras `permissionId` / `featureFlagId`
(`packages/module-sdk/src/index.ts:389-397`) are **rejected** for external modules
(unknown-key rejection, D6) — external modules cannot reference core permission or flag
ids. Add `readonly navigation?: readonly ExternalModuleNavigationEntry[]` (new 5-field
interface) to `JsonJarvisModuleManifest` (`module-sdk/src/index.ts:638`).

### D3. Path namespacing — module-relative, host-prefixed (isolation invariant)

Manifest `path` is **relative to the module base**: `"/"` (module root) or
`"/sub/route"`. The API prefixes at serialize time — the manifest can never place an entry
outside `/m/<moduleId>`:

```ts
path: entry.path === "/" ? `/m/${m.id}` : `/m/${m.id}${entry.path}`;
```

Prefixing lives in `serializeExternalModule` only (single choke point); reconcile stores
the relative path so drift/hash logic sees exactly what the manifest said. The emitted
absolute path lands on the host's lazy `/m/:moduleId/*` mount
(`apps/web/src/app.tsx:103`), and job-search's own router already parses under
`MODULE_BASE = "/m/job-search"` (`external-modules/job-search/src/web/router.ts:8-14`).
The shell renders `NavLink to={entry.path}` unchanged (`apps/web/src/shell/app-shell.tsx:361-376`).

**Traversal guard (validator, per entry):** `path` must start with `/`; reject `\\`, `?`,
`#`, `//` (empty segment), and any segment equal to `.` or `..`; each segment must match
`/^[a-z0-9][a-z0-9-]*$/`; total length ≤ 128. Same posture as the `web.entrypoint` clean-path
check (`validate.ts:328-341`). A module therefore cannot declare `/settings`, `../admin`,
or any absolute host route — only suffixes under its own base.

### D4. Icon — validated slug, host lookup-only rendering (no allowlist table)

`icon` is an optional slug, `/^[a-z][a-z0-9-]{0,31}$/`. Safe without a shared allowlist
because the shell treats icon strings as a **pure map lookup with a fallback** — unknown
names render `Layers3` (`app-shell.tsx:365`, map at `:54-66`); an icon string can never
become markup or code. A duplicated allowlist in the validator would drift from `iconMap`
and buy nothing. Host change: add `briefcase: Briefcase` (lucide) to `iconMap` so
job-search gets a real icon. Document in the manifest reference that only `iconMap` names
render; anything else falls back.

### D5. Ordering + placement — dedicated "Modules" section after built-ins

External entries must not interleave with (or spoof) built-in sections. In
`buildShellNavigation` (`app-route-metadata.ts:106`), carry module context through the
flatMap and route entries from `module.external === true` into a new labeled section
`"Modules"`, appended after `SECTION_ORDER` (`__top`, `Plan`, `You` — `:7`) via the
existing not-in-SECTION_ORDER tail (`:131-132`). Never consult `SECTION_OF` for external
entries. Within the section, the existing comparator applies (`order` asc, nulls last,
then label — `:115-119`). **Id namespacing (spoof guard):** entry `id` must be
`<moduleId>` or `<moduleId>.<slug>` — same rule as storage namespaces
(`validate.ts:303-310`) — so an external entry can never collide with built-in nav ids and
ride `HIDDEN_NAV_IDS` (`:15`) or `SECTION_OF` (`:8`).

### D6. Validation caps (mirror #964 posture; all fail-closed in `validateExternalModuleManifest`)

- `navigation` optional; if present: array, **1–4 entries** (nav real estate; job-search
  needs 1). Reject empty array (declare nothing instead).
- Per entry: object with only known keys — unknown keys (incl. `permissionId`,
  `featureFlagId`) are an error, matching the `database` unknown-key rule
  (`validate.ts:425-429`).
- `id`: `<moduleId>` or `<moduleId>.<slug>`, slug `/^[a-z0-9][a-z0-9-]*$/`, total ≤ 64;
  unique within the manifest.
- `label`: non-empty trimmed string, ≤ 40 chars (fits the rail).
- `path`: per D3 (leading `/`, clean segments, charset `[a-z0-9-]`, ≤ 128, no
  `.`/`..`/`//`/`\\`/`?`/`#`).
- `icon`: optional, `/^[a-z][a-z0-9-]{0,31}$/`.
- `order`: optional integer, |order| ≤ 10 000.
- On success, re-shape into the validated manifest exactly like other fields
  (`validate.ts:463-489`) so unknown keys are defensively dropped from the trusted object.

### D7. job-search manifest

Single entry in `external-modules/job-search/jarvis.module.json`:

```jsonc
"navigation": [
  { "id": "job-search", "label": "Job Search", "path": "/", "icon": "briefcase" }
]
```

Root path — the module's own pushState router owns everything below `/m/job-search`.
Bump `compatibility.jarv1s` to the core version that ships this ABI. **Note:** changing
the manifest changes `packageHash` → an already-enabled install drifts and auto-disables
on update (`reconcile.ts` drift branch, `DRIFT_DISABLED_REASON`); the admin re-enables in
Settings. Expected #917 behavior — the UAT must exercise it (D10).

### D8. API change

- `ReconciledExternalModule` (`packages/module-registry/src/external/types.ts:36-47`)
  gains `readonly navigation: readonly ExternalModuleNavigationEntry[]` (empty array when
  the manifest declares none); populate in reconcile's `base`
  (`packages/module-registry/src/external/reconcile.ts:24-30`) as
  `manifest.navigation ?? []`.
- `serializeExternalModule` (`server.ts:899-912`): drop the `[]`; map validated entries to
  `ModuleNavigationEntryDto` with D3 prefixing, `icon: entry.icon ?? null`,
  `order: entry.order ?? null` — mirroring `serializeModule` (`server.ts:875-881`).
  Update the stale "#917 metadata only" comment (`server.ts:896-898`).
- `settings` remains hardcoded `[]`.

### D9. Tests — no migration needed

**No DB migration**: the manifest lives on disk; `app.external_modules`
(`packages/settings/sql/0152_external_modules.sql`) stores only id/status/hash, and the
DTO fields are already in the shared response schema — `foundation.test.ts`'s migration
list is untouched.

- **Validator unit** (module-registry): accepts a v1 manifest without `navigation`
  (regression); accepts a valid single entry; rejects — 5 entries, empty array, 41-char
  label, unprefixed id (`"settings"`), path without leading `/`, `"/../x"`, `"/a//b"`,
  `"/a?x=1"`, backslash, unknown key `permissionId`, non-integer order, bad icon slug.
- **Reconcile unit**: `navigation` carried through for active modules; defaults to `[]`.
- **API** (`app.inject` on `/api/modules`, per the fast-json-stringify trap): external
  module's entry arrives prefixed `/m/job-search`, icon/order normalized to null; module
  with no navigation still returns `navigation: []`.
- **Web unit** (`buildShellNavigation`): external entry lands in the `"Modules"` section
  after `You`, cannot be routed into `Plan`/`You` or hidden via `HIDDEN_NAV_IDS`.

### D10. Dev-UAT exit criterion (HARD)

Playwright against a real dev instance (per Ben's 2026-07-13 rule and the #1019 gate-gap
finding): enable job-search in Settings → Instance modules (covering the D7 drift
re-enable), reload the shell, then **assert a nav link with accessible name "Job Search"
exists in the nav rail, click it, and assert the URL is `/m/job-search` with the module
root rendered. `page.goto('/m/job-search')` is forbidden anywhere in this UAT** — the
prior dev-proof passed on `goto` while the nav path was broken. Manual dev proof is
acceptable until the #1000 harness ships, recorded with live DOM assertions and run output.

## Rollout

Single PR: module-sdk type + validator + reconcile + server serialize + iconMap +
`buildShellNavigation` sectioning + job-search manifest + tests. User-facing summary:
"Downloaded modules now appear in the navigation menu after install — previously an
installed module could only be reached by typing its URL."

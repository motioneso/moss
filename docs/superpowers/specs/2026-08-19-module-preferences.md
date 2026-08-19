# Settings for installed modules

**Status:** APPROVED by Ben 2026-08-19 (option chosen same day)
**Issue:** #1725
**Primary verification seam:** install Food, open Settings, turn its AI estimate switch off, and see
the module behave differently on the next chat turn

## Problem statement

Every module that is compiled into Moss has a settings page. Email has one, Tasks has one; each
declares a label and a path in its manifest and ships a component that the app renders there
(`packages/email/src/manifest.ts:53-64`).

A module that a user installs after the fact cannot have one. The validator that checks an
installed module's manifest keeps a list of fields it refuses outright, and `settings` is on that
list (`packages/module-registry/src/external/validate.ts:60-75`). Declaring one is not ignored — the
install is rejected.

That gap has now produced a concrete defect. Food's ruling from Ben on 2026-08-19 is that installing
a module is itself the permission for what the module normally does, so Food's AI estimates must be
on from install with an off switch in settings. Food has nowhere to put the switch, and the
workaround it shipped instead — asking permission in chat the first time — is exactly the design the
ruling rejects.

This is the same shape as navigation. Installed modules were barred from declaring a navigation
entry until issue #1019 took `navigation` off that same reject list and validated it properly. Food
has a nav entry today because of that work. Settings is the same move.

## The ruling this implements

From Ben, 2026-08-19, recorded in full on issue #926:

> Installing a module is the consent for everything that module normally does. Only destructive
> actions ask at the time.

and, on where the off switch goes:

> Default to on, but they can turn it off in settings.

## What this builds

The host owns the settings page. A module declares what preferences it has; it does not ship a
settings component, and it does not get a write path from its own page.

This is deliberately the narrower of the two options considered. The alternative — let an installed
module render its own settings page out of its web bundle, the way built-ins do — is a closer match
to how built-in modules work, but it requires opening a write path from a module's page, which today
may only call read-only tools. Ben chose the narrower option on 2026-08-19. Everything below assumes
it.

### 1. Modules declare preferences, not pages

A new optional `preferences` array in an installed module's manifest. `settings` stays on the reject
list — this is a different, smaller field, and keeping the old name rejected means an author who
copies a built-in module's manifest still gets a clear error rather than a silently ignored page.

Each entry declares one user-facing switch:

```
{
  "key": "aiEstimates",
  "label": "AI nutrition estimates",
  "description": "Let Moss estimate calories and nutrients for meals you log.",
  "type": "boolean",
  "default": true
}
```

Constraints, all enforced by the validator and each one a rejection:

- at most 8 preferences per module
- `key` matches `^[a-z][a-zA-Z0-9]{0,39}$` and is unique within the module
- `type` is `"boolean"` only in this version
- `label` 1-60 characters, `description` 0-160 characters
- `default` is present and matches `type`

Only booleans for now. A module that wants a number or a choice list is a later version; shipping
one type keeps the rendering and the storage honest, and the validator can widen without breaking
anything already installed.

### 2. Storage reuses the existing preferences table

No migration. `app.preferences` already stores per-user JSON values keyed by string, owner-only,
with row-level security enforcing that a user reads and writes only their own
(`packages/structured-state/sql/0031_structured_state.sql:127-150`). `PreferencesRepository` already
has get, upsert, list and delete against a scoped connection
(`packages/structured-state/src/preferences-repository.ts:15-78`).

Preference keys are namespaced `module:<moduleId>:<key>`, for example `module:food:aiEstimates`.
Namespacing is what keeps two modules from colliding, and what makes a module's rows findable when
it is uninstalled.

Reading a preference that has never been written returns the manifest's declared default. Nothing is
written at install time — an unwritten row and "the user left it at the default" are the same state,
and keeping them the same avoids a backfill whenever a module changes its default.

Uninstalling a module should delete its `module:<moduleId>:` rows — a module's preferences are its
data. **Not implemented, because there is nothing to attach it to:** the platform has no uninstall
path. Grepping `apps/` and `packages/` for "uninstall" finds only unrelated comments,
`packages/module-registry/src/external/reconcile.ts` has no delete logic, and the only
module-related DELETE routes are the credential ones in
`packages/settings/src/routes-module-credentials.ts`. A module is removed by deleting its staged
directory. Left-behind preference rows are inert — nothing reads a key whose module is not active —
and re-installing restores the user's earlier choice. Building an uninstall path belongs to whoever
does, and this rule goes in it then.

### 3. The host renders the page

Settings gains one route per installed module that declares preferences, listed alongside the
existing module settings entries so an installed module looks no different from a built-in one to
the user. The page renders one labelled switch per declared preference and writes through a new pair
of endpoints:

```
GET   /api/modules/:moduleId/preferences  -> { preferences: Record<string, boolean> }
PATCH /api/modules/:moduleId/preferences     body { key: string, value: boolean } -> 204
```

Both resolve the actor the usual way and run under the actor's scoped connection, so row-level
security is what enforces ownership rather than a check in the handler. `PATCH` rejects a key the
module did not declare, and rejects a value whose type does not match the declaration — an installed
module's manifest is the only source of what keys exist.

The switches are ordinary host components using the authored design system. No new primitives.

### 4. Modules read their preferences at invocation

A module's handler receives its own resolved preferences on the context it already gets, defaults
already applied, as a plain object. The module does not query for them and cannot write them — a
preference is something the user sets and the module obeys.

This is the seam that makes the whole thing worth building: it is how Food's estimator learns it
should not run, without Food needing a write path or a permission prompt.

## Determinism boundary

Every switch renders from the stored value, or from the manifest default when nothing is stored.
Nothing on this page is model-authored or model-mediated. A module cannot change the position of its
own switch.

## What this does not do

- No preference types other than boolean.
- No instance-wide or admin-scoped preferences. Per-user only, which is what the existing table
  enforces anyway.
- No settings page shipped by the module itself. That stays barred, and stays the thing to revisit
  if per-module pages ever need to be richer than a list of switches.
- No change to the permission tiers. Destructive actions still confirm at use time.

## Open questions

1. Where does an installed module's preferences page sit relative to the built-in module settings
   entries — same list, or a separate section? Design call, not a blocker.
2. Should a module be able to react to a preference changing, rather than only reading it on the
   next invocation? Nothing needs it yet; leaving it out.

## Verification

Each item is an executable assertion. No screenshots.

1. **Validator, unit.** A manifest declaring 9 preferences is rejected; one declaring a duplicate
   key is rejected; one declaring `"type": "number"` is rejected; a well-formed one is accepted. Each
   would pass against a validator that skipped the check, so each names the specific rejection.
2. **Storage, integration.** Reading an unwritten preference returns the manifest default. Writing
   then reading returns the written value. A second user reading the same key gets their own value,
   not the first user's — this fails against any implementation that forgot to scope the connection.
3. **Endpoints, integration.** `PATCH` with an undeclared key returns 400. `PATCH` with a string
   value for a boolean preference returns 400. `PATCH` as a different user does not change the
   first user's row.
4. ~~**Uninstall, integration.**~~ Dropped: there is no uninstall path to test. See the storage
   section above.
5. **Live path, end to end on a real instance.** Install Food, open Settings, confirm the AI
   estimate switch reads on without anything having been written. Turn it off. Log a meal through
   chat and assert the stored meal carries no estimate. Turn it back on, log another, assert the
   estimate is there. This is the assertion that proves the preference reaches the handler, which
   every unit test above can pass without.

## Follow-on: the Food change this unblocks

Separate issue, separate PR, after this lands:

- Remove Food's `food.consent.grant` tool and the permission prompt it raises.
- Declare `aiEstimates`, default on.
- Estimator reads the preference instead of the consent record.
- Deleting a meal still confirms at use time; that is unaffected and stays.

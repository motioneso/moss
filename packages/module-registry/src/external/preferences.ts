// packages/module-registry/src/external/preferences.ts
//
// #1725: resolving an installed module's declared on/off switches against what the user
// has actually stored. Lives here rather than in apps/api because both entry points need
// it — the settings routes (apps/api/src/module-preferences.ts) and every module
// invocation (apps/worker/src/external-module-invoke.ts, which puts the resolved values
// on ctx.preferences).
//
// Storage is app.preferences under `module:<moduleId>:<key>`. Nothing is written at
// install, so an absent row is not "off" — it is "never touched", which resolves to the
// manifest default. Every read runs inside the ACTOR's data context, so RLS (owner-only)
// is what stops one user seeing another's switches.
import type { AccessContext, DataContextRunner } from "@moss/db";
import type {
  ExternalModulePreferenceDeclaration,
  ExternalModulePreferenceValue
} from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";

export function modulePreferenceKey(moduleId: string, key: string): string {
  return `module:${moduleId}:${key}`;
}

/**
 * Write a batch of switches for one user in a single data context, so a multi-switch save
 * from the settings pane is all-or-nothing rather than half-applied on an error.
 * Callers validate that every key is manifest-declared BEFORE calling — this writes what
 * it is given.
 */
export async function writeModulePreferences(
  runner: DataContextRunner,
  access: AccessContext,
  moduleId: string,
  updates: ReadonlyArray<readonly [string, ExternalModulePreferenceValue]>
): Promise<void> {
  const repository = new PreferencesRepository();
  await runner.withDataContext(access, async (scopedDb) => {
    for (const [key, value] of updates) {
      await repository.upsert(scopedDb, modulePreferenceKey(moduleId, key), value);
    }
  });
}

export async function resolveModulePreferences(
  runner: DataContextRunner,
  access: AccessContext,
  module: {
    readonly id: string;
    readonly preferences: readonly ExternalModulePreferenceDeclaration[];
  }
): Promise<Record<string, ExternalModulePreferenceValue>> {
  if (module.preferences.length === 0) return {};
  const repository = new PreferencesRepository();
  const stored = await runner.withDataContext(access, (scopedDb) => repository.list(scopedDb));
  const resolved: Record<string, ExternalModulePreferenceValue> = {};
  for (const declaration of module.preferences) {
    const value = stored[modulePreferenceKey(module.id, declaration.key)];
    // A stored value of the wrong type falls back to the default rather than throwing: a
    // module update that changes a key's meaning must not lock the user out of the page.
    if (declaration.type === "boolean") {
      resolved[declaration.key] = typeof value === "boolean" ? value : declaration.default;
      continue;
    }
    // #1757: null is a value here, not an absence — the user cleared the field, and that is
    // a different statement from never having touched it only in that both mean "no number".
    // Reading either as the declared default would silently re-impose a target the user removed,
    // so a stored null wins over the default.
    resolved[declaration.key] =
      value === null || Number.isSafeInteger(value)
        ? (value as number | null)
        : declaration.default;
  }
  return resolved;
}

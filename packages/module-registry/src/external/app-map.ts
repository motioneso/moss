import type {
  ExternalModuleAppMapDeclaration,
  ExternalModuleAppMapFeature,
  ExternalModuleAppMapScreen,
  ExternalModuleAppMapSetting
} from "@moss/module-sdk";
import type { AppMapItem } from "@moss/shared";

const MAX_ENTRIES = 16;
const PATH_RE = /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/;

function checkId(id: unknown, moduleId: string, seen: Set<string>, errors: string[]): boolean {
  if (
    typeof id !== "string" ||
    id.length > 64 ||
    !id.startsWith(`${moduleId}.`) ||
    id.length === moduleId.length + 1
  ) {
    errors.push(`appMap entry id must be "${moduleId}.<slug>" (max 64 chars): ${String(id)}`);
    return false;
  }
  if (seen.has(id)) {
    errors.push(`appMap entry id must be unique: ${id}`);
    return false;
  }
  seen.add(id);
  return true;
}

function checkText(value: unknown, max: number, field: string, errors: string[]): boolean {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    errors.push(`appMap entry ${field} must be a non-empty string (max ${max} chars)`);
    return false;
  }
  return true;
}

function checkSurface(entry: Record<string, unknown>, errors: string[]): boolean {
  const labelOk = checkText(entry.label, 80, "label", errors);
  const pathOk =
    typeof entry.path === "string" && entry.path.length <= 128 && PATH_RE.test(entry.path);
  if (!pathOk) {
    errors.push(`appMap entry path must be a clean module-relative path: ${String(entry.path)}`);
  }
  return labelOk && pathOk;
}

function readList(
  block: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
  moduleId: string,
  seen: Set<string>,
  errors: string[],
  extra: (entry: Record<string, unknown>) => boolean
): Record<string, unknown>[] | undefined {
  const raw = block[key];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ENTRIES) {
    errors.push(`appMap.${key} must be an array of 1 to ${MAX_ENTRIES} entries`);
    return undefined;
  }
  const out: Record<string, unknown>[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      errors.push(`appMap.${key} entries must be objects`);
      continue;
    }
    const entry = item as Record<string, unknown>;
    const unknownKeys = Object.keys(entry).filter((k) => !allowed.includes(k));
    if (unknownKeys.length > 0) {
      errors.push(`appMap.${key} entry contains unknown fields: ${unknownKeys.join(", ")}`);
      continue;
    }
    let ok = checkId(entry.id, moduleId, seen, errors);
    ok = checkText(entry.description, 1000, "description", errors) && ok;
    ok = extra(entry) && ok;
    if (ok) out.push(entry);
  }
  return out;
}

/**
 * Positive validation of the optional `appMap` block (#3168). Entries use the built-in shapes;
 * paths are module-relative and ids carry the module's own prefix so a manifest cannot shadow
 * a core or built-in entry. Appends to `errors`; returns the block only when it is clean.
 */
export function validateModuleAppMap(
  obj: Record<string, unknown>,
  moduleId: string,
  errors: string[]
): ExternalModuleAppMapDeclaration | undefined {
  if (obj.appMap === undefined) return undefined;
  if (typeof obj.appMap !== "object" || obj.appMap === null || Array.isArray(obj.appMap)) {
    errors.push("appMap must be an object");
    return undefined;
  }
  const block = obj.appMap as Record<string, unknown>;
  const unknownKeys = Object.keys(block).filter(
    (k) => !["screens", "settings", "features"].includes(k)
  );
  if (unknownKeys.length > 0) {
    errors.push(`appMap contains unknown fields: ${unknownKeys.join(", ")}`);
    return undefined;
  }
  const before = errors.length;
  const seen = new Set<string>();
  const screens = readList(
    block,
    "screens",
    ["id", "label", "description", "path"],
    moduleId,
    seen,
    errors,
    (entry) => checkSurface(entry, errors)
  );
  const settings = readList(
    block,
    "settings",
    ["id", "label", "description", "path", "scope"],
    moduleId,
    seen,
    errors,
    (entry) => {
      const scopeOk = entry.scope === "user" || entry.scope === "admin";
      if (!scopeOk) errors.push('appMap setting scope must be "user" or "admin"');
      return checkSurface(entry, errors) && scopeOk;
    }
  );
  const features = readList(
    block,
    "features",
    ["id", "description"],
    moduleId,
    seen,
    errors,
    () => true
  );
  if (errors.length > before) return undefined;
  return {
    ...(screens ? { screens: screens as unknown as ExternalModuleAppMapScreen[] } : {}),
    ...(settings ? { settings: settings as unknown as ExternalModuleAppMapSetting[] } : {}),
    ...(features ? { features: features as unknown as ExternalModuleAppMapFeature[] } : {})
  };
}

export interface ExternalAppMapItems {
  readonly screens: readonly AppMapItem[];
  readonly settings: readonly AppMapItem[];
  readonly features: readonly AppMapItem[];
}

const underModule = (moduleId: string, path: string) =>
  path === "/" ? `/m/${moduleId}` : `/m/${moduleId}${path}`;

/** Turns installed modules' app-map blocks into app-map items, with paths under `/m/<id>`. */
export function externalAppMapItems(
  modules: readonly { readonly id: string; readonly appMap?: ExternalModuleAppMapDeclaration }[]
): ExternalAppMapItems {
  return {
    screens: modules.flatMap((m) =>
      (m.appMap?.screens ?? []).map((s) => ({
        moduleId: m.id,
        ...s,
        path: underModule(m.id, s.path),
        scope: "user" as const
      }))
    ),
    settings: modules.flatMap((m) =>
      (m.appMap?.settings ?? []).map((s) => ({
        moduleId: m.id,
        ...s,
        path: underModule(m.id, s.path)
      }))
    ),
    features: modules.flatMap((m) =>
      (m.appMap?.features ?? []).map((f) => ({ moduleId: m.id, ...f }))
    )
  };
}

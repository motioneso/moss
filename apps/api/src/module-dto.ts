// apps/api/src/module-dto.ts
//
// serializeModule/serializeExternalModule, extracted verbatim out of server.ts (#1328) to
// bring server.ts back under the file-size cap — same extraction pattern as
// apps/worker/src/external-module-job-handler.ts. Pure DTO mappers, unexported from server.ts
// before this move, so no import site anywhere in the repo changes: /api/modules
// (registerPlatformRoutes) is server.ts's only caller, and it now imports both from here.
import {
  type getBuiltInModuleManifests,
  type ReconciledExternalModule
} from "@moss/module-registry";
import { type ModuleDto } from "@moss/shared";

export function serializeModule(
  module: ReturnType<typeof getBuiltInModuleManifests>[number]
): ModuleDto {
  return {
    id: module.id,
    name: module.name,
    version: module.version,
    lifecycle: module.lifecycle,
    navigation: (module.navigation ?? []).map((entry) => ({
      id: entry.id,
      label: entry.label,
      path: entry.path,
      icon: entry.icon ?? null,
      order: entry.order ?? null
    })),
    settings: (module.settings ?? []).map((surface) => ({
      id: surface.id,
      label: surface.label,
      path: surface.path,
      scope: surface.scope,
      order: surface.order ?? null
    })),
    // #917: built-ins are never external. Emitted explicitly so the field survives the
    // fast-json-stringify schema (undeclared/absent fields are dropped) and the shell can
    // rely on it being present for built-ins.
    external: false
  };
}

// #1019: an ACTIVE external module surfaces on /api/modules with its manifest-declared
// navigation (validated + capped by validateExternalModuleManifest) — settings surfaces
// still stay [] (Slice 1 declares none). This is the ONLY place a manifest-relative nav
// path becomes a real app route: prefixing with /m/<moduleId> is what stops an external
// module from ever declaring an absolute or host route. external:true lets the shell tag
// it without loading any of its code.
export function serializeExternalModule(m: ReconciledExternalModule): ModuleDto {
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    lifecycle: "optional",
    navigation: m.navigation.map((entry) => ({
      id: entry.id,
      label: entry.label,
      path: entry.path === "/" ? `/m/${m.id}` : `/m/${m.id}${entry.path}`,
      icon: entry.icon ?? null,
      order: entry.order ?? null,
      // #1285: badge lives only on ExternalModuleNavigationEntry (built-ins never
      // declare one, see serializeModule above), so this mapper is the only one that
      // re-emits it. Omit rather than emit undefined — same reason `web` is
      // conditionally spread below, and the response schema declares `badge` optional.
      ...(entry.badge ? { badge: entry.badge } : {})
    })),
    settings: [],
    external: true,
    // #918: ModuleDto.web is optional — omit rather than emit null when the module
    // declares no web surface (ReconciledExternalModule.web itself IS nullable).
    ...(m.web ? { web: m.web } : {}),
    // #1756: the caller's own module list only ever contains someone else's draft never —
    // apps/api/src/external-module-tools.ts's active-module resolver already drops any draft
    // that isn't owned by the caller — so a "draft" status reaching this mapper always means
    // "this is the caller's own, still-running draft".
    ...(m.status === "draft" ? { draft: true } : {})
  };
}

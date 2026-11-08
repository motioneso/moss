import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMossEnv } from "@moss/db";
import type { MossModuleManifest } from "@moss/module-sdk";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import {
  CORE_APP_ERRORS,
  CORE_APP_REMEDIATIONS,
  CORE_APP_SCREENS,
  CORE_APP_SETTINGS,
  type CoreAppErrorDeclaration,
  type CoreAppRemediationDeclaration,
  type CoreAppSurfaceDeclaration
} from "@moss/shared";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface BuildAppMapInput {
  readonly runtime?: "typescript" | "rust";
  readonly manifests: readonly MossModuleManifest[];
  readonly coreScreens: readonly CoreAppSurfaceDeclaration[];
  readonly coreSettings: readonly CoreAppSurfaceDeclaration[];
  readonly coreErrors?: readonly CoreAppErrorDeclaration[];
  readonly coreRemediations?: readonly CoreAppRemediationDeclaration[];
  readonly version: string;
  readonly buildId: string;
  readonly narrative: string;
}

export function buildAppMap(input: BuildAppMapInput) {
  // Core declarations are the authority for shared surfaces. A module that declares its own
  // setting or screen pointing at the same page (by id or path) is dropped, so the built map
  // never lists the same page twice under two owners; duplicates read as two different things
  // to Moss.
  // Runtime-specific declarations must never advertise routes from a different app.
  const runtime = input.runtime ?? "typescript";
  const belongs = (entry: { readonly runtime?: "rust" }) =>
    (entry.runtime ?? "typescript") === runtime;
  const coreScreens = input.coreScreens.filter(belongs);
  const coreSettings = input.coreSettings.filter(belongs);
  const coreScreenIds = new Set(coreScreens.map((surface) => surface.id));
  const coreScreenPaths = new Set(coreScreens.map((surface) => surface.path));
  const coreSettingIds = new Set(coreSettings.map((surface) => surface.id));
  const coreSettingPaths = new Set(coreSettings.map((surface) => surface.path));

  const screens = input.manifests.flatMap((manifest) =>
    (manifest.navigation ?? [])
      .filter((surface) => !coreScreenIds.has(surface.id) && !coreScreenPaths.has(surface.path))
      .map((surface) => ({
        moduleId: manifest.id,
        ...surface,
        scope: "user" as const
      }))
  );
  const settings = input.manifests.flatMap((manifest) =>
    (manifest.settings ?? [])
      .filter((surface) => !coreSettingIds.has(surface.id) && !coreSettingPaths.has(surface.path))
      .map((surface) => ({
        moduleId: manifest.id,
        ...surface
      }))
  );
  const features = input.manifests.flatMap((manifest) =>
    (manifest.features ?? []).map((feature) => ({
      moduleId: manifest.id,
      ...feature
    }))
  );
  return {
    schemaVersion: 1 as const,
    build: { version: input.version, buildId: input.buildId },
    screens: [...coreScreens.map((surface) => ({ moduleId: "core", ...surface })), ...screens],
    settings: [...coreSettings.map((surface) => ({ moduleId: "core", ...surface })), ...settings],
    features,
    errors: [
      ...(input.coreErrors ?? []).filter(belongs).map((error) => ({ moduleId: "core", ...error })),
      ...features.flatMap((feature) =>
        (feature.errors ?? []).map((error) => ({
          moduleId: feature.moduleId,
          featureId: feature.id,
          ...error
        }))
      )
    ],
    remediations: [
      ...(input.coreRemediations ?? []).filter(belongs).map((remediation) => ({
        moduleId: "core",
        ...remediation
      })),
      ...features.flatMap((feature) =>
        (feature.remediations ?? []).map((remediation) => ({
          moduleId: feature.moduleId,
          featureId: feature.id,
          ...remediation
        }))
      )
    ],
    narrative: { authoritative: false as const, markdown: input.narrative }
  };
}

export function writeAppMap(path: string, input: BuildAppMapInput): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(buildAppMap(input), null, 2)}\n`, "utf8");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const runtime = process.argv.includes("--rust") ? "rust" : "typescript";
  writeAppMap(resolve(root, runtime === "rust" ? "dist/rust-app-map.json" : "dist/app-map.json"), {
    runtime,
    manifests: runtime === "rust" ? [] : getBuiltInModuleManifests(),
    coreScreens: CORE_APP_SCREENS,
    coreSettings: CORE_APP_SETTINGS,
    coreErrors: CORE_APP_ERRORS,
    coreRemediations: CORE_APP_REMEDIATIONS,
    version: resolveMossEnv(process.env, "JARVIS_APP_VERSION")?.trim() || "development",
    buildId: resolveMossEnv(process.env, "JARVIS_GIT_COMMIT")?.trim().slice(0, 12) || "development",
    narrative: readFileSync(resolve(root, "docs/WHATS_NEW.md"), "utf8")
  });
}

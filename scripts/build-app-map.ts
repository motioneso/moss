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
  const screens = input.manifests.flatMap((manifest) =>
    (manifest.navigation ?? []).map((surface) => ({
      moduleId: manifest.id,
      ...surface,
      scope: "user" as const
    }))
  );
  const settings = input.manifests.flatMap((manifest) =>
    (manifest.settings ?? []).map((surface) => ({
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
    screens: [
      ...input.coreScreens.map((surface) => ({ moduleId: "core", ...surface })),
      ...screens
    ],
    settings: [
      ...input.coreSettings.map((surface) => ({ moduleId: "core", ...surface })),
      ...settings
    ],
    features,
    errors: [
      ...(input.coreErrors ?? []).map((error) => ({ moduleId: "core", ...error })),
      ...features.flatMap((feature) =>
        (feature.errors ?? []).map((error) => ({
          moduleId: feature.moduleId,
          featureId: feature.id,
          ...error
        }))
      )
    ],
    remediations: [
      ...(input.coreRemediations ?? []).map((remediation) => ({
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
  writeAppMap(resolve(root, "dist/app-map.json"), {
    manifests: getBuiltInModuleManifests(),
    coreScreens: CORE_APP_SCREENS,
    coreSettings: CORE_APP_SETTINGS,
    coreErrors: CORE_APP_ERRORS,
    coreRemediations: CORE_APP_REMEDIATIONS,
    version: resolveMossEnv(process.env, "JARVIS_APP_VERSION")?.trim() || "development",
    buildId: resolveMossEnv(process.env, "JARVIS_GIT_COMMIT")?.trim().slice(0, 12) || "development",
    narrative: readFileSync(resolve(root, "docs/WHATS_NEW.md"), "utf8")
  });
}

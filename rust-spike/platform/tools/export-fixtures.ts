import { writeFileSync } from "node:fs";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import {
  CORE_APP_SCREENS,
  CORE_APP_SETTINGS,
  CORE_APP_ERRORS,
  CORE_APP_REMEDIATIONS
} from "@moss/shared";

writeFileSync(
  process.argv[2] ?? "/tmp/js39-manifests.json",
  JSON.stringify(
    {
      manifests: getBuiltInModuleManifests(),
      core: {
        screens: CORE_APP_SCREENS,
        settings: CORE_APP_SETTINGS,
        errors: CORE_APP_ERRORS,
        remediations: CORE_APP_REMEDIATIONS
      }
    },
    (_key, value: unknown) => (typeof value === "function" ? undefined : value),
    2
  ) + "\n"
);

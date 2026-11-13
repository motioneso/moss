// Prints the legacy Briefings settings, features and flags as JSON for the package manifest.
import { briefingsModuleManifest } from "../../../packages/briefings/src/manifest.js";

const { settings, features, featureFlags } = briefingsModuleManifest as unknown as Record<
  string,
  unknown
>;
process.stdout.write(JSON.stringify({ settings, features, featureFlags }));

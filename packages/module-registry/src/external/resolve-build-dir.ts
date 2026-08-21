import { join } from "node:path";
import { resolveModulesDir } from "../resolve-modules-dir.js";
import { MODULE_ID_RE } from "./validate.js";

export function resolveModuleBuildsDir(env: NodeJS.ProcessEnv): string {
  if (env.JARVIS_MODULE_BUILDS_DIR) return env.JARVIS_MODULE_BUILDS_DIR;
  const modulesDir = resolveModulesDir(env);
  return join(modulesDir, "..", "module-builds");
}

export function resolveBuildSourceDir(buildsDir: string, buildId: string): string {
  if (!MODULE_ID_RE.test(buildId)) {
    throw new Error(`invalid build id: ${buildId}`);
  }
  return join(buildsDir, buildId);
}

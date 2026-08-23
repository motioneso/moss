import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";

import { resolveMossEnv } from "@moss/db";
import {
  downloadAndStageModule,
  fetchRegistryIndex,
  ModuleDownloadError,
  parseModulesEnsure,
  resolveBuildSourceDir,
  resolveModuleBuildsDir
} from "@moss/module-registry/node";
import type {
  ModuleDistributionDependencies,
  RegistryEntriesSnapshot
} from "@moss/settings";

import type { ApiServerConfig, CreateApiServerOptions } from "./server.js";

/**
 * #964/#996 — module-distribution port for the settings registry routes, extracted from
 * server.ts (Task 6 pushed server.ts over the 1000-line file-size cap; #9.5 restores
 * it). Network + filesystem composition only; DB writes stay in @moss/settings, so
 * this file never needs a database handle (module-isolation invariant). The index
 * cache is per-process (10 min, spec §6); a failed refetch returns null (degrade) and
 * leaves any previous cache untouched so the next request can retry. Always-on since
 * #996 removed the JARVIS_ENABLE_EXTERNAL_MODULES gate — externalModulesDir is never
 * null (resolveModulesDir always resolves a path), so this always constructs the port.
 */
export function createModuleDistributionPort(
  server: Pick<FastifyInstance, "log">,
  apiServerConfig: ApiServerConfig,
  options: Pick<CreateApiServerOptions, "fetchFn">
): ModuleDistributionDependencies {
  const externalModulesDir = apiServerConfig.externalModulesDir;
  const fetchFn = options.fetchFn;

  const REGISTRY_CACHE_TTL_MS = 10 * 60 * 1000;
  let registryCache: { at: number; snapshot: RegistryEntriesSnapshot } | null = null;

  return {
    fetchRegistryEntries: async ({ refresh }) => {
      if (!refresh && registryCache && Date.now() - registryCache.at < REGISTRY_CACHE_TTL_MS) {
        return registryCache.snapshot;
      }
      const result = await fetchRegistryIndex({ env: process.env, fetchFn });
      if (!result.index) {
        server.log.warn({ errors: result.errors }, "module registry index unavailable (#964)");
        // "unavailable" is never cached — a failed refetch leaves any previous
        // cached snapshot untouched so the next request can retry.
        return { entries: null, catalogVerification: "unavailable", catalogDigestSha256: null };
      }
      // Atomic: entries + verification + digest all come from this one fetchRegistryIndex call.
      const snapshot: RegistryEntriesSnapshot = {
        entries: result.index.modules,
        catalogVerification: result.verification,
        catalogDigestSha256: result.digestSha256
      };
      registryCache = { at: Date.now(), snapshot };
      return snapshot;
    },
    download: async (input) => {
      try {
        const result = await downloadAndStageModule({
          moduleId: input.moduleId,
          version: input.version,
          modulesDir: externalModulesDir,
          env: process.env,
          fetchFn
        });
        return { ok: true as const, version: result.version, packageHash: result.packageHash };
      } catch (error) {
        if (error instanceof ModuleDownloadError) {
          return { ok: false as const, code: error.code, message: error.message };
        }
        server.log.error(
          { moduleId: input.moduleId, errorName: (error as Error).name },
          "module download failed (#964)"
        );
        return { ok: false as const, code: "download-failed", message: "Download failed" };
      }
    },
    removeModuleFiles: async (moduleId: string) => {
      // Path-safety: moduleId came from a URL param. This makes traversal
      // structurally impossible regardless of route-layer validation.
      if (!/^[a-z][a-z0-9-]*$/.test(moduleId) || moduleId.includes("..")) {
        return;
      }
      await rm(join(externalModulesDir, moduleId), { recursive: true, force: true });
    },
    removeModuleBuildFiles: async (buildId: string) => {
      // #1890: resolveBuildSourceDir THROWS on any id that is not a plain safe name, so a
      // crafted build id cannot walk out of the builds dir. Swallowed rather than rethrown:
      // this runs after the row is already deleted, and a leftover build directory is inert
      // (nothing scans the builds dir), so failing here must not turn a completed throw-away
      // into an error the user sees.
      try {
        await rm(resolveBuildSourceDir(resolveModuleBuildsDir(process.env), buildId), {
          recursive: true,
          force: true
        });
      } catch (error) {
        server.log.warn(
          { errorName: (error as Error).name },
          "module build directory cleanup failed (#1890)"
        );
      }
    },
    listOnDiskModuleIds: async () => {
      const dirents = await readdir(externalModulesDir, { withFileTypes: true }).catch(() => []);
      return dirents.filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name);
    },
    ensureIds: parseModulesEnsure(resolveMossEnv(process.env, "JARVIS_MODULES_ENSURE")).entries.map(
      (e) => e.id
    )
  };
}

// Server-only entry for @moss/module-registry (#917). Everything reachable from
// here may use node:* (fs, crypto). The browser-safe surface stays in ./index.ts.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

import {
  ExternalPackageEscapeError,
  hashCanonicalManifest,
  hashExternalPackage
} from "./external/hash.js";
import { MODULE_ID_RE, validateExternalModuleManifest } from "./external/validate.js";
import type {
  ExternalModuleDiscovery,
  ExternalModuleLoadResult,
  ExternalModuleRejection
} from "./external/types.js";

export * from "./external/hash.js";
export * from "./external/validate.js";
export * from "./external/web-assets.js";
export * from "./external/worker-runtime.js";
export * from "./external/worker-rpc-host.js";
export * from "./external/tool-manifests.js";
export * from "./external/job-reconciler.js";
export * from "./external/install-draft.js";
export * from "./distribution/index-schema.js";
export * from "./distribution/ensure-list.js";
export * from "./distribution/catalog-signing.js";
export * from "./distribution/registry-source.js";
export * from "./distribution/extract.js";
export * from "./distribution/stage.js";
export * from "./distribution/pipeline.js";
export * from "./resolve-modules-dir.js";
export * from "./external/resolve-build-dir.js";

/**
 * Discover external modules under `modulesDir` (#917). Server-only. Read-only: never
 * writes into the mount. Fail-closed per directory — any error (bad slug, symlink
 * escape, missing/invalid manifest, validation failure) rejects THAT module with a
 * reason and never throws, so one bad module can't blank the whole set. Callers gate
 * the call behind JARVIS_ENABLE_EXTERNAL_MODULES; the loader itself just reads a dir.
 */
export function getExternalModuleRegistrations(options: {
  readonly modulesDir: string;
  readonly coreVersion?: string;
  readonly reservedQueueNames?: ReadonlySet<string>;
}): ExternalModuleLoadResult {
  const { modulesDir, coreVersion, reservedQueueNames } = options;
  const discoveries: ExternalModuleDiscovery[] = [];
  const rejected: ExternalModuleRejection[] = [];

  if (!existsSync(modulesDir)) {
    return { discoveries, rejected };
  }

  // Resolve the root through symlinks once so we can prove each module dir is contained.
  const rootReal = realpathSync(modulesDir);

  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    // A module directory's name IS the module id — reject non-slug names outright
    // (also blocks any "." / ".." style trickery the fs might surface).
    const id = entry.name;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    // #1222: dot-prefixed dirs (.prev-*/.staging-* backups, and dotfiles generally) are
    // distribution-internal (#964) — skip them outright, never surface in rejected[] either.
    if (id.startsWith(".")) continue;
    if (!MODULE_ID_RE.test(id)) {
      rejected.push({ id, reason: `directory name "${id}" is not a valid module id slug` });
      continue;
    }

    // #917 C1: the whole per-directory body is wrapped so ANY throw rejects only THIS
    // module — this is what makes discovery fail-closed. realpathSync throws ENOENT on a
    // dangling symlink (and EACCES on an unreadable one), and hashExternalPackage's
    // readFileSync can throw on a TOCTOU race (a file vanishing mid-scan); without this
    // backstop any one of those would escape the loop and blank the entire discovery set.
    try {
      const dir = join(modulesDir, id);
      // Symlink-escape guard: the real path must stay inside the real modules root.
      const dirReal = realpathSync(dir);
      if (dirReal !== rootReal && !dirReal.startsWith(rootReal + sep)) {
        rejected.push({ id, reason: `symlink target escapes the modules root: ${id}` });
        continue;
      }

      const manifestPath = join(dir, "jarvis.module.json");
      if (!existsSync(manifestPath)) {
        rejected.push({ id, reason: `missing jarvis.module.json in ${id}` });
        continue;
      }

      // #917 SECURITY (Codex re-QA): the manifest file itself must not be a symlink that
      // escapes the module dir — spec "reject symlinks escaping the module directory". The
      // readFileSync below FOLLOWS a symlink, so without this a symlinked jarvis.module.json
      // could resolve to any on-disk file. realpathSync resolves the final link (guarded by the
      // existsSync above); an out-of-dir target is an escape — the same containment test already
      // applied to the module directory, now applied to the manifest file.
      const manifestReal = realpathSync(manifestPath);
      if (manifestReal !== dirReal && !manifestReal.startsWith(dirReal + sep)) {
        rejected.push({ id, reason: `jarvis.module.json escapes the module directory: ${id}` });
        continue;
      }

      // #917 SECURITY (Codex re-QA): read and parse in SEPARATE try blocks. A readFileSync
      // failure (EACCES/EISDIR/TOCTOU) embeds the ABSOLUTE on-disk path in error.message — the
      // same leak vector the outer catch guards against — so it must NEVER be interpolated raw.
      // Emit only the error CODE/NAME so no path reaches the admin GET `rejected[]` or
      // server.ts `log.warn({ reason })`. The parse path keeps the nicer "invalid JSON" reason.
      let contents: string;
      try {
        contents = readFileSync(manifestPath, "utf8");
      } catch (error) {
        const token =
          error instanceof Error
            ? ((error as NodeJS.ErrnoException).code ?? error.name)
            : "unknown error";
        rejected.push({ id, reason: `failed to read ${id}/jarvis.module.json: ${token}` });
        continue;
      }

      let raw: unknown;
      try {
        raw = JSON.parse(contents);
      } catch (error) {
        // A JSON SyntaxError can echo file CONTENT but never a filesystem path; still emit only
        // the error NAME (e.g. "SyntaxError") for defense-in-depth and parity with the read path.
        const token = error instanceof Error ? error.name : "unknown error";
        rejected.push({ id, reason: `invalid JSON in ${id}/jarvis.module.json: ${token}` });
        continue;
      }

      const validation = validateExternalModuleManifest(raw, id, coreVersion, reservedQueueNames);
      if (!validation.ok) {
        rejected.push({ id, reason: validation.errors.join("; ") });
        continue;
      }

      discoveries.push({
        id,
        dir,
        manifest: validation.manifest,
        manifestHash: hashCanonicalManifest(validation.manifest),
        packageHash: hashExternalPackage(dir)
      });
    } catch (error) {
      // #917 SECURITY (Codex re-QA, finding 2): a package path (jarvis.module.json /
      // dist/worker.js / dist/web) that symlinks OUT of the module dir surfaces here as an
      // ExternalPackageEscapeError. Its `relPath` is a FIXED module-relative token (never an
      // absolute path), so it is safe to surface and gives the operator an actionable reason.
      if (error instanceof ExternalPackageEscapeError) {
        rejected.push({
          id,
          reason: `package path escapes the module directory (${error.relPath}): ${id}`
        });
        continue;
      }
      // #917 SECURITY: NEVER interpolate the raw error message here. fs errors from
      // realpathSync (ENOENT/EACCES on a dangling/unreadable symlink) and from
      // hashExternalPackage's readFileSync (TOCTOU race) embed the ABSOLUTE on-disk
      // path in their message (e.g. `ENOENT ... '/abs/modules/dir/...'`). This reason
      // flows to the admin GET response `rejected[]` (packages/settings routes) and to
      // server.ts `log.warn({ reason })`, so leaking the message would violate the hard
      // invariant "on-disk paths never in responses or logs." Emit only the error CODE
      // or NAME — a fixed token that cannot contain a path.
      const reasonToken =
        error instanceof Error
          ? ((error as NodeJS.ErrnoException).code ?? error.name)
          : "unknown error";
      rejected.push({ id, reason: `failed to load module "${id}": ${reasonToken}` });
      continue;
    }
  }

  // Deterministic order so downstream lists/hashes are stable.
  discoveries.sort((a, b) => a.id.localeCompare(b.id));
  rejected.sort((a, b) => a.id.localeCompare(b.id));
  return { discoveries, rejected };
}

/** A live cell over the latest `getExternalModuleRegistrations` result (#1752). Both the API
 *  and worker processes hold one of these so a module dropped onto the mount after boot is
 *  visible once `rescan()` runs, without a process restart. */
export interface ExternalModuleDiscoveryHolder {
  getDiscoveries(): readonly ExternalModuleDiscovery[];
  getRejected(): readonly ExternalModuleRejection[];
  rescan(): Promise<ExternalModuleLoadResult>;
}

export function createExternalModuleDiscoveryHolder(options: {
  readonly modulesDir: string;
  readonly coreVersion?: string;
  readonly reservedQueueNames?: ReadonlySet<string>;
  readonly log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}): ExternalModuleDiscoveryHolder {
  const scan = (): ExternalModuleLoadResult => {
    const snapshot = getExternalModuleRegistrations(options);
    options.log?.info(
      { discovered: snapshot.discoveries.length, rejected: snapshot.rejected.length },
      "external modules discovered (#996 always-on)"
    );
    for (const rejection of snapshot.rejected) {
      options.log?.warn(
        { moduleId: rejection.id, reason: rejection.reason },
        "external module rejected (#917)"
      );
    }
    return snapshot;
  };

  let current = scan();

  return {
    getDiscoveries: () => current.discoveries,
    getRejected: () => current.rejected,
    rescan: async () => {
      current = scan();
      return current;
    }
  };
}

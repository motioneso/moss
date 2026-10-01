import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runCliToolsRefresh,
  type CliToolVersionReader,
  type CliToolsRefreshOutcome
} from "@moss/ai";
import type { RpcConnection } from "@moss/chat";

import { MODULE_CATALOG_PUBLIC_KEYS } from "./distribution/catalog-signing.js";
import { compareVersions } from "./distribution/cli-tools-manifest.js";
import { fetchVerifiedCliToolsManifest } from "./distribution/cli-tools-fetch.js";

/** Walks up from this file to the workspace root package.json (named "moss"). */
export function readMossVersion(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (pkg.name === "moss" && typeof pkg.version === "string") return pkg.version;
    } catch {
      // keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Build the refresh pass over the one runner connection. The keyring is the one shipped in the
 * image; no key is named here.
 */
export function buildCliToolsRefresh(deps: {
  readonly getConnection: () => RpcConnection | undefined;
  readonly versionReader: CliToolVersionReader | undefined;
  readonly fetchFn?: typeof fetch;
  readonly mossVersion?: () => string | undefined;
}): () => Promise<CliToolsRefreshOutcome> {
  return () =>
    runCliToolsRefresh({
      getState: async () => (await deps.getConnection()?.getCliToolsState()) ?? null,
      listVersions: async () => deps.versionReader?.().catch(() => undefined),
      fetchManifest: (lastSequence) =>
        fetchVerifiedCliToolsManifest({
          trustedKeys: MODULE_CATALOG_PUBLIC_KEYS,
          lastSequence,
          ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {})
        }),
      stage: async (params) => {
        const conn = deps.getConnection();
        if (!conn) return { state: "error", message: "runner unavailable" };
        return conn.stageCliCandidate(params);
      },
      compareVersions,
      mossVersion: deps.mossVersion ?? readMossVersion
    });
}

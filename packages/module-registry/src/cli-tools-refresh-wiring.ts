import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { randomUUID } from "node:crypto";

import {
  runCliToolsRefresh,
  runCliVersionCheck,
  runLiveCheckSteps,
  STRUCTURED_CHECK_PROMPT,
  TOOL_CHECK_PROMPT,
  type CheckTurnOutcome,
  type CliToolVersionReader,
  type CliToolsRefreshOutcome,
  type VersionCheckOutcome,
  type CliVersionCheckPorts,
  type LiveCheckResult,
  type ProviderKind
} from "@moss/ai";
import {
  createCandidateCheckEngine,
  runCheckTurn,
  type CheckTokenMinter,
  type RpcConnection
} from "@moss/chat";

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

const CHECK_TURN_TIMEOUT_MS = 90_000;
const MAX_CHECK_USERS = 3;

/**
 * Build the version check over the one runner connection. The check runs as an active instance
 * admin who holds a sign-in for the provider, because the program cannot answer without one. An
 * admin whose check cannot run (no sign-in) is skipped and the next one is tried.
 */
export function buildCliVersionCheck(deps: {
  readonly getConnection: () => RpcConnection | undefined;
  readonly getMinter: () => CheckTokenMinter | undefined;
  readonly versionReader: CliToolVersionReader | undefined;
  readonly listAdminIds: () => Promise<readonly string[]>;
  readonly raiseFailure?: CliVersionCheckPorts["raiseFailure"];
}): (provider: ProviderKind, opts?: { force?: boolean }) => Promise<VersionCheckOutcome> {
  const runTurn = async (
    provider: ProviderKind,
    userId: string,
    prompt: string,
    toolName?: string
  ): Promise<CheckTurnOutcome> => {
    const connection = deps.getConnection();
    const minter = deps.getMinter();
    if (!connection || (toolName && !minter)) return { ok: false, reason: "check_unavailable" };
    const key = `cli-check-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    let tokenSession: string | undefined;
    try {
      const toolServer =
        toolName && minter
          ? (() => {
              tokenSession = key;
              const minted = minter.mint(userId, key, [toolName]);
              return {
                url: minted.mcpServerUrl,
                bearer: minted.token,
                onClose: () => minter.revoke(key)
              };
            })()
          : undefined;
      const engine = createCandidateCheckEngine({
        connection,
        provider,
        userId,
        sessionKey: key,
        ...(toolServer ? { toolServer } : {})
      });
      return await runCheckTurn({
        engine,
        launch: { neutralDir: "", personaPath: "", model: "default" },
        prompt,
        ...(toolName ? { toolName } : {}),
        timeoutMs: CHECK_TURN_TIMEOUT_MS
      });
    } catch {
      return { ok: false, reason: "check_unavailable" };
    } finally {
      if (tokenSession) minter?.revoke(tokenSession);
    }
  };

  const runLiveCheck: CliVersionCheckPorts["runLiveCheck"] = async (provider) => {
    const admins = (await deps.listAdminIds()).slice(0, MAX_CHECK_USERS);
    let last: LiveCheckResult = { passed: false, reason: "check_unavailable" };
    for (const userId of admins) {
      last = await runLiveCheckSteps({
        toolTurn: () => runTurn(provider, userId, TOOL_CHECK_PROMPT, "app.getMapSlice"),
        structuredTurn: () => runTurn(provider, userId, STRUCTURED_CHECK_PROMPT)
      });
      if (last.reason !== "check_unavailable") return last;
    }
    return last;
  };

  return (provider, opts) =>
    runCliVersionCheck(
      provider,
      {
        getState: async (p) => {
          const conn = deps.getConnection();
          const state = await conn?.getCliToolsState();
          if (!state) return null;
          const versions = await deps.versionReader?.().catch(() => undefined);
          return {
            candidate: state.candidates[p] ?? [],
            lastCheck: state.lastCheck[p] ?? null,
            liveVersion: versions?.providers[p] ?? null
          };
        },
        runLiveCheck,
        promote: async (p) => {
          const conn = deps.getConnection();
          if (!conn) return { state: "error", message: "runner unavailable" };
          return conn.promoteCliCandidate({ provider: p });
        },
        recordCheck: async (p, check) => {
          await deps.getConnection()?.recordCliCheck({ provider: p, ...check });
        },
        ...(deps.raiseFailure ? { raiseFailure: deps.raiseFailure } : {})
      },
      opts
    );
}

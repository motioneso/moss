import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { recordModelActivity } from "@moss/ai";
import type { ModuleBuildStep, Multiplexer, ProviderKind, TmuxIo } from "@moss/ai";
import {
  buildLaunchCommand,
  isComposerEmpty,
  type EngineLaunchOpts,
  type LaunchCommandContext
} from "@moss/chat/live";

export interface ModuleBuildLiveAgentDeps {
  readonly io: TmuxIo;
  readonly mux: Multiplexer;
  readonly provider: ProviderKind;
  readonly ensureProviderLaunchReady: (provider: ProviderKind, workingDir: string) => Promise<void>;
  readonly mcpToken?: string;
  readonly mcpServerUrl?: string;
  /**
   * Plan 3.6b (#2890): one model activity row per build step turn. The composition root supplies
   * the resolved model name so no provider or model is hardcoded here. Defaults to recording
   * against the process-wide recorder using the provider kind as the honest label.
   */
  readonly recordTurn?: (outcome: "ok" | "error" | "aborted") => void;
}

const STEP_TIMEOUT_MS = 30 * 60 * 1000;
const STEP_POLL_MS = 1000;
const READY_TIMEOUT_MS = 30 * 1000;
const BUILD_SCRIPT = join("scripts", "build-external-module.ts");

/**
 * Walks up from `startDir` to the directory holding the module build script. The worker runs from
 * `apps/worker/src` in source mode and from `<root>/dist` in the production bundle.
 */
export function resolveWorkspaceRoot(
  startDir: string,
  exists: (path: string) => boolean = existsSync
): string {
  for (let dir = startDir; ; dir = dirname(dir)) {
    if (exists(join(dir, BUILD_SCRIPT))) return dir;
    if (dirname(dir) === dir) throw new Error(`Cannot find the workspace root from ${startDir}`);
  }
}

const CLAUDE_SESSION_FILES = [
  ".jarvis-claude-permission-hook.mjs",
  ".jarvis-claude-settings.json",
  ".jarvis-claude-permission-token",
  ".jarvis-claude-mcp.json"
];

export function createModuleBuildLiveAgent(deps: ModuleBuildLiveAgentDeps) {
  return async (input: {
    readonly workingDir: string;
    readonly step: ModuleBuildStep;
    readonly plan: Record<string, unknown> | null;
  }) => {
    await deps.io.run("mkdir", ["-p", input.workingDir]);
    await deps.ensureProviderLaunchReady(deps.provider, input.workingDir);

    const sessionId = randomUUID();
    const personaPath = join(input.workingDir, ".module-build-persona.md");
    const completionMarker = `.jarvis-module-build-complete-${sessionId}`;
    const completionMarkerPath = join(input.workingDir, completionMarker);
    await deps.io.writeFile(
      personaPath,
      [
        "Build a downloaded Moss module and work only in the current build directory.",
        "You may read the host repository for examples, but never modify anything outside the current build directory.",
        "The finished module must include jarvis.module.json, src/worker/index.ts, and a useful src/web/index.ts UI.",
        "Follow the downloaded-module ABI in docs/module-developer-guide.md and the smallest relevant external-modules example.",
        "Do not use Bash or shell commands; use Read, Glob, Grep, Write, and Edit. The worker runs the module build after writing_code.",
        "Do not install, enable, publish, or run the host's database commands.",
        'Every assistantTools entry\'s name and permissionId must start with "<your module id>." (for example "acme-widgets.lookup"), or the build fails validation.',
        "If you declare an external data source, its fetchHosts must be a non-empty array of lowercase hostnames (no ports, no IPs), or the build fails validation.",
        'An assistantTools entry may set executionPolicy "auto" only if it also sets actionFamilyId to a family declared in assistantActionFamilies whose allowedTiers includes "trusted_auto"; otherwise omit executionPolicy or use "confirm", and never set executionPolicy on a read-only tool.',
        "Any actionFamilyId you set on a tool must match the id of a family you declared in assistantActionFamilies."
      ].join("\n") + "\n"
    );

    const launchOptions: EngineLaunchOpts = {
      neutralDir: input.workingDir,
      personaPath,
      workspaceWrite: true,
      ...(deps.mcpToken ? { mcpToken: deps.mcpToken } : {}),
      ...(deps.mcpServerUrl ? { mcpServerUrl: deps.mcpServerUrl } : {})
    };

    const commandContext: LaunchCommandContext = {
      provider: deps.provider,
      io: deps.io,
      executionMode: "interactive",
      codexTokenEnvPath: null
    };
    let handle: string | undefined;
    try {
      const launchLine = await buildLaunchCommand(
        commandContext,
        launchOptions,
        sessionId,
        personaPath
      );
      handle = await deps.mux.open({
        name: `jarvis-module-build-${sessionId}`,
        cols: 220,
        rows: 50,
        launchLine
      });

      const readyDeadline = Date.now() + READY_TIMEOUT_MS;
      while (!isComposerEmpty(deps.provider, await deps.mux.capturePane(handle))) {
        if (!(await deps.mux.isAlive(handle)) || Date.now() >= readyDeadline) {
          throw new Error("module build agent did not become ready");
        }
        await deps.io.sleep(250);
      }
      const prompt = [
        `Implement the ${input.step} step for this module build.`,
        "Keep all changes inside the current build directory.",
        `When and only when the step is completely finished, create the completion marker ${completionMarker} in the current directory.`,
        input.plan ? `Build plan:\n${JSON.stringify(input.plan)}` : ""
      ]
        .filter(Boolean)
        .join("\n\n");
      await deps.mux.submit(handle, prompt);

      const deadline = Date.now() + STEP_TIMEOUT_MS;
      while ((await deps.io.run("test", ["-f", completionMarkerPath])).code !== 0) {
        if (!(await deps.mux.isAlive(handle))) {
          throw new Error(`module build agent exited before completing ${input.step}`);
        }
        if (Date.now() >= deadline) {
          throw new Error(`module build agent timed out while completing ${input.step}`);
        }
        await deps.io.sleep(STEP_POLL_MS);
      }

      if (input.step === "writing_code") {
        const built = await deps.io.run(
          "pnpm",
          ["exec", "tsx", "scripts/build-external-module.ts", input.workingDir],
          { cwd: resolveWorkspaceRoot(import.meta.dirname) }
        );
        if (built.code !== 0) {
          throw new Error(`generated module did not build: ${built.stderr ?? "unknown error"}`);
        }
      }

      const listed = await deps.io.run("find", [".", "-type", "f", "-print"], {
        cwd: input.workingDir
      });
      if (listed.code !== 0) throw new Error("module build agent files could not be listed");
      const internalFiles = new Set([
        completionMarker,
        ".module-build-persona.md",
        ...CLAUDE_SESSION_FILES
      ]);
      const wroteFiles = listed.stdout
        .split("\n")
        .map((path) => path.replace(/^\.\//, ""))
        .filter((path) => path.length > 0 && !internalFiles.has(path));
      recordBuildTurn(deps, input.step, "ok");
      return { wroteFiles };
    } catch (error) {
      recordBuildTurn(deps, input.step, "error");
      throw error;
    } finally {
      try {
        if (handle !== undefined) await deps.mux.kill(handle);
      } finally {
        // finishBuild stages the whole directory. Never return it with a live session token.
        if (deps.provider === "anthropic" && deps.mcpToken && deps.mcpServerUrl) {
          await removeClaudeSessionFiles(deps.io, input.workingDir);
        }
      }
    }
  };
}

async function removeClaudeSessionFiles(io: TmuxIo, workingDir: string): Promise<void> {
  const cleanup = await io.run("rm", [
    "-f",
    ...CLAUDE_SESSION_FILES.map((file) => join(workingDir, file))
  ]);
  if (cleanup.code !== 0) throw new Error("module build session files could not be removed");
}

/**
 * Plan 3.6b (#2890): one model activity row per module-build step turn. The step's model program
 * runs a whole session the adapter seam never sees, so the row is per turn rather than per call.
 * Only transport facts are recorded; no prompt, plan or source text enters the row.
 */
function recordBuildTurn(
  deps: ModuleBuildLiveAgentDeps,
  step: ModuleBuildStep,
  outcome: "ok" | "error" | "aborted"
): void {
  const record = deps.recordTurn;
  if (record) {
    record(outcome);
    return;
  }
  // #2956: no composition root claimed this turn, so the line is a System
  // line — but it still carries its code.
  recordModelActivity({
    kind: "structured",
    action: `module-build:${step}`,
    actionCode: "module.build",
    outcome,
    modelName: deps.provider,
    result: outcome === "ok" ? "completed" : outcome === "aborted" ? "stopped" : "failed"
  });
}

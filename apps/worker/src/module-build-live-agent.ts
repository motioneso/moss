import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { ModuleBuildStep, Multiplexer, ProviderKind, TmuxIo } from "@moss/ai";
import {
  buildLaunchCommand,
  composerHasExactEcho,
  isComposerEmpty,
  type EngineLaunchOpts,
  type LaunchCommandContext
} from "@moss/chat/live";

export interface ModuleBuildLiveAgentDeps {
  readonly io: TmuxIo;
  readonly mux: Multiplexer;
  readonly provider: ProviderKind;
  readonly mcpToken?: string;
  readonly mcpServerUrl?: string;
}

const STEP_TIMEOUT_MS = 30 * 60 * 1000;
const STEP_POLL_MS = 1000;
const READY_TIMEOUT_MS = 30 * 1000;
const WORKSPACE_ROOT = join(import.meta.dirname, "../../..");

export function createModuleBuildLiveAgent(deps: ModuleBuildLiveAgentDeps) {
  return async (input: {
    readonly workingDir: string;
    readonly step: ModuleBuildStep;
    readonly plan: Record<string, unknown> | null;
  }) => {
    await deps.io.run("mkdir", ["-p", input.workingDir]);

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
        "Do not install, enable, publish, or run the host's database commands."
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
    const launchLine = await buildLaunchCommand(
      commandContext,
      launchOptions,
      sessionId,
      personaPath
    );
    const handle = await deps.mux.open({
      name: `jarvis-module-build-${sessionId}`,
      cols: 220,
      rows: 50,
      launchLine
    });

    try {
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
      await deps.io.sleep(250);
      if (composerHasExactEcho(deps.provider, await deps.mux.capturePane(handle), prompt)) {
        await deps.mux.pressEnter(handle);
      }

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
          { cwd: WORKSPACE_ROOT }
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
        ".jarvis-claude-permission-hook.mjs",
        ".jarvis-claude-settings.json"
      ]);
      return {
        wroteFiles: listed.stdout
          .split("\n")
          .map((path) => path.replace(/^\.\//, ""))
          .filter((path) => path.length > 0 && !internalFiles.has(path))
      };
    } finally {
      await deps.mux.kill(handle);
    }
  };
}

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { ModuleBuildStep, Multiplexer, ProviderKind, TmuxIo } from "@moss/ai";
import {
  buildLaunchCommand,
  writeClaudePermissionHook,
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

export function createModuleBuildLiveAgent(deps: ModuleBuildLiveAgentDeps) {
  return async (input: {
    readonly workingDir: string;
    readonly step: ModuleBuildStep;
    readonly plan: Record<string, unknown> | null;
  }) => {
    await deps.io.run("mkdir", ["-p", input.workingDir]);

    const sessionId = randomUUID();
    const personaPath = join(input.workingDir, ".module-build-persona.md");
    await deps.io.writeFile(
      personaPath,
      "Work only in the current build directory. Do not install, enable, or publish the module.\n"
    );

    const launchOptions: EngineLaunchOpts = {
      neutralDir: input.workingDir,
      personaPath,
      ...(deps.mcpToken ? { mcpToken: deps.mcpToken } : {}),
      ...(deps.mcpServerUrl ? { mcpServerUrl: deps.mcpServerUrl } : {})
    };

    if (deps.provider === "anthropic" && deps.mcpToken && deps.mcpServerUrl) {
      await writeClaudePermissionHook(deps.io, {
        neutralDir: input.workingDir,
        mcpToken: deps.mcpToken,
        mcpServerUrl: deps.mcpServerUrl
      });
    }

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

    await deps.mux.submit(
      handle,
      [
        `Implement the ${input.step} step for this module build.`,
        "Keep all changes inside the current build directory.",
        input.plan ? `Build plan:\n${JSON.stringify(input.plan)}` : ""
      ]
        .filter(Boolean)
        .join("\n\n")
    );

    return { wroteFiles: [] as readonly string[] };
  };
}

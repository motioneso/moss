import { describe, expect, it } from "vitest";

import { workshopModuleManifest } from "../packages/workshop/src/manifest.js";
import { WORKSHOP_RUN_COMMAND_SANDBOX_NOTE } from "../packages/workshop/src/run-command.js";

function runCommandSummarize(input: unknown): string {
  const tool = workshopModuleManifest.assistantTools?.find(
    (candidate) => candidate.name === "workshop.runCommand"
  );
  if (!tool || typeof tool.summarize !== "function") throw new Error("runCommand tool missing");
  return tool.summarize(input as never);
}

describe("runCommand approval card", () => {
  it("shows the whole command plus the sandbox sentence", () => {
    const command = "pnpm build && pnpm test";
    const summary = runCommandSummarize({ command });
    expect(summary).toContain(command);
    expect(summary).toContain(WORKSHOP_RUN_COMMAND_SANDBOX_NOTE);
  });

  it("states plainly that builds are not sandboxed", () => {
    expect(WORKSHOP_RUN_COMMAND_SANDBOX_NOTE).toMatch(/not sandboxed/);
    expect(WORKSHOP_RUN_COMMAND_SANDBOX_NOTE).toMatch(/approve only commands you understand/);
  });

  it("appends the build-agent behavior with the not-approved error and remedy", () => {
    const features = workshopModuleManifest.features ?? [];
    const last = features[features.length - 1];
    expect(last?.id).toBe("workshop.acp_builds");
    expect(last?.description ?? "").toContain(WORKSHOP_RUN_COMMAND_SANDBOX_NOTE);
    expect(last?.description.trim().length).toBeLessThanOrEqual(240);
    const codes = (last?.errors ?? []).map((error) => error.code);
    expect(codes).toContain("workshop.acp_builds.not_approved");
    const remedies = (last?.remediations ?? []).map((remediation) => remediation.id);
    expect(remedies).toContain("workshop.acp_builds.retry_command");
  });
});

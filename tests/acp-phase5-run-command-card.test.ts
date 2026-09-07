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
});

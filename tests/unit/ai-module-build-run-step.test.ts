import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  runModuleBuildStep,
  type LaunchLiveAgentResult,
  type ModuleBuildRow
} from "../../packages/ai/src/module-build/run-build-step.js";

function makeBuildRow(overrides: Partial<ModuleBuildRow> = {}): ModuleBuildRow {
  return { id: "b1", step: null, plan: {}, ...overrides };
}

describe("runModuleBuildStep", () => {
  it("advances through spec, failing test, then code across successive calls, deferring each time", async () => {
    const fakeLaunchLiveAgent = vi
      .fn<() => Promise<LaunchLiveAgentResult>>()
      .mockResolvedValueOnce({ wroteFiles: ["SPEC.md"] })
      .mockResolvedValueOnce({ wroteFiles: ["module.test.ts"] })
      .mockResolvedValueOnce({ wroteFiles: ["module.ts"], testsPassing: true });
    const deps = {
      launchLiveAgent: fakeLaunchLiveAgent,
      resolveWorkingDir: (buildId: string) => `/data/module-builds/${buildId}`,
      recordFetchedUrl: vi.fn(async () => {}),
      recordWrittenFile: vi.fn(async () => {})
    };

    const build = makeBuildRow();
    const step1 = await runModuleBuildStep(deps, build);
    expect(step1.continuation?.step).toBe("writing_tests");

    const step2 = await runModuleBuildStep(deps, { ...build, step: "writing_tests" });
    expect(step2.continuation?.step).toBe("writing_code");

    const step3 = await runModuleBuildStep(deps, { ...build, step: "writing_code" });
    expect(step3.deferred).toBe(false);
  });

  it("skips spec and tests when the plan says to", async () => {
    const fakeLaunchLiveAgent = vi.fn(
      async (): Promise<LaunchLiveAgentResult> => ({
        wroteFiles: ["module.ts"],
        testsPassing: true
      })
    );
    const deps = {
      launchLiveAgent: fakeLaunchLiveAgent,
      resolveWorkingDir: (buildId: string) => `/data/module-builds/${buildId}`,
      recordFetchedUrl: vi.fn(async () => {}),
      recordWrittenFile: vi.fn(async () => {})
    };

    const result = await runModuleBuildStep(
      deps,
      makeBuildRow({ step: null, plan: { skipSpecAndTests: true } })
    );

    expect(fakeLaunchLiveAgent).toHaveBeenCalledWith(
      expect.objectContaining({ step: "writing_code" })
    );
    expect(result.deferred).toBe(false);
  });

  it("records every URL the build session fetched", async () => {
    const fakeLaunchLiveAgent = vi.fn(
      async (): Promise<LaunchLiveAgentResult> => ({
        wroteFiles: [],
        fetchedUrls: ["https://example.com/widgets"]
      })
    );
    const recordFetchedUrl = vi.fn(async () => {});
    const deps = {
      launchLiveAgent: fakeLaunchLiveAgent,
      resolveWorkingDir: (buildId: string) => `/data/module-builds/${buildId}`,
      recordFetchedUrl,
      recordWrittenFile: vi.fn(async () => {})
    };

    await runModuleBuildStep(deps, makeBuildRow());

    expect(recordFetchedUrl).toHaveBeenCalledWith("b1", "https://example.com/widgets");
  });

  it("records every file the build session wrote", async () => {
    const fakeLaunchLiveAgent = vi.fn(
      async (): Promise<LaunchLiveAgentResult> => ({
        wroteFiles: ["module.ts", "module.test.ts"]
      })
    );
    const recordWrittenFile = vi.fn(async () => {});
    const deps = {
      launchLiveAgent: fakeLaunchLiveAgent,
      resolveWorkingDir: (buildId: string) => `/data/module-builds/${buildId}`,
      recordFetchedUrl: vi.fn(async () => {}),
      recordWrittenFile
    };

    await runModuleBuildStep(deps, makeBuildRow());

    expect(recordWrittenFile).toHaveBeenNthCalledWith(1, "b1", "module.ts");
    expect(recordWrittenFile).toHaveBeenNthCalledWith(2, "b1", "module.test.ts");
  });

  it("never reads a credential value directly — only code it emits may do that later", () => {
    const source = readFileSync(
      new URL("../../packages/ai/src/module-build/run-build-step.ts", import.meta.url),
      "utf8"
    );
    expect(source).not.toMatch(/module_credentials|decryptJson|AiSecretCipher/);
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  runModuleBuildStep,
  type RunModuleBuildStepDeps
} from "../../packages/ai/src/module-build/run-build-step.js";

const source = { files: [{ path: "SPEC.md", content: "A private word list." }] };
function dependencies() {
  return {
    assertExecutionAvailable: vi.fn(() => {}),
    generateSource: vi.fn(async () => source),
    acceptSource: vi.fn(async () => ({ moduleId: "words" }))
  } satisfies RunModuleBuildStepDeps;
}

const build = { id: "b1", step: null, plan: {} };

describe("source-only module build steps", () => {
  it("requires host acceptance before advancing spec, tests and code", async () => {
    const deps = dependencies();
    for (const [step, next] of [
      ["writing_spec", "writing_tests"],
      ["writing_tests", "writing_code"],
      ["writing_code", null]
    ] as const) {
      const result = await runModuleBuildStep(deps, { ...build, step });
      expect(deps.acceptSource).toHaveBeenLastCalledWith({
        buildId: "b1",
        step,
        source,
        signal: undefined
      });
      expect(result).toEqual(
        next
          ? { deferred: true, continuation: { buildId: "b1", step: next } }
          : { deferred: false, moduleId: "words" }
      );
    }
  });

  it("does not spend a provider call while the runtime is unavailable", async () => {
    const deps = dependencies();
    deps.assertExecutionAvailable.mockImplementation(() => {
      throw new Error("unavailable");
    });
    await expect(runModuleBuildStep(deps, build)).rejects.toThrow("unavailable");
    expect(deps.generateSource).not.toHaveBeenCalled();
    expect(deps.acceptSource).not.toHaveBeenCalled();
  });

  it("preserves the explicit skip-spec choice", async () => {
    const deps = dependencies();
    await runModuleBuildStep(deps, { ...build, plan: { skipSpecAndTests: true } });
    expect(deps.generateSource).toHaveBeenCalledWith(
      expect.objectContaining({ step: "writing_code" })
    );
  });

  it("discards late source after cancellation before host acceptance", async () => {
    const deps = dependencies();
    const abort = new AbortController();
    deps.generateSource.mockImplementation(async () => {
      abort.abort();
      return source;
    });
    await expect(runModuleBuildStep(deps, build, abort.signal)).rejects.toThrow();
    expect(deps.acceptSource).not.toHaveBeenCalled();
  });

  it("does not report a generated proposal as a verified finished module", async () => {
    const deps: RunModuleBuildStepDeps = { ...dependencies(), acceptSource: async () => ({}) };
    await expect(runModuleBuildStep(deps, { ...build, step: "writing_code" })).rejects.toThrow(
      "acceptance did not return a module"
    );
  });
});

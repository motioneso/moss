import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SerializedError, TestModule } from "vitest/node";
import MeetingProofRuntimeReporter from "../../scripts/meeting-proof-runtime-reporter.js";

const folders: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const privateError: SerializedError = { message: "private fixture detail" };
function fixture(moduleErrors: SerializedError[] = [], suiteErrors: SerializedError[] = []) {
  const folder = mkdtempSync(join(tmpdir(), "meeting-proof-reporter-"));
  folders.push(folder);
  const path = join(folder, "runtime.json");
  vi.stubEnv("MOSS_PROOF_RUNTIME_REPORT", path);
  const module = {
    errors: () => moduleErrors,
    children: {
      *allSuites() {
        yield { errors: () => suiteErrors };
      }
    }
  } as unknown as TestModule;
  return { module, path, reporter: new MeetingProofRuntimeReporter() };
}

describe("meeting proof runtime reporter", () => {
  it.each(["passed", "failed"] as const)(
    "records a clean %s run without counting test assertions",
    (reason) => {
      const f = fixture();
      f.reporter.onTestRunEnd([f.module], [], reason);
      expect(JSON.parse(readFileSync(f.path, "utf8"))).toEqual({
        schemaVersion: 1,
        reason,
        moduleCount: 1,
        unhandledErrors: 0,
        collectionErrors: 0
      });
    }
  );
  it("counts unhandled, module and nested suite errors without persisting their contents", () => {
    const f = fixture([privateError], [privateError, privateError]);
    f.reporter.onTestRunEnd([f.module], [privateError], "failed");
    const text = readFileSync(f.path, "utf8");
    expect(JSON.parse(text)).toMatchObject({ unhandledErrors: 1, collectionErrors: 3 });
    expect(text).not.toContain(privateError.message);
  });
  it("records interrupted or empty runs distinctly", () => {
    const f = fixture();
    f.reporter.onTestRunEnd([], [], "interrupted");
    expect(JSON.parse(readFileSync(f.path, "utf8"))).toMatchObject({
      reason: "interrupted",
      moduleCount: 0
    });
  });
  it("refuses to silently omit its runtime receipt", () => {
    vi.stubEnv("MOSS_PROOF_RUNTIME_REPORT", undefined);
    expect(() => new MeetingProofRuntimeReporter().onTestRunEnd([], [], "passed")).toThrow(
      "Missing proof runtime report destination"
    );
  });
});

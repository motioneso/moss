import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  provisionForUat: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  spawn: vi.fn()
}));

vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile, readdir: mocks.readdir }));
vi.mock("./provisioner.js", () => ({ provisionForUat: mocks.provisionForUat }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

const originalArgv = process.argv;

describe("run-uat CLI (#1027/#1047)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.readdir.mockResolvedValue(["future-advisory.uat.spec.ts"]);
    mocks.readFile.mockResolvedValue(
      `export const uatLevel = {
        level: "solo-admin",
        without: []
      } as const;`
    );
    mocks.provisionForUat.mockResolvedValue({
      baseURL: "http://127.0.0.1:4321",
      projectName: "uat-test",
      teardown: vi.fn().mockResolvedValue(undefined)
    });
    mocks.spawn.mockReturnValue({
      on: (event: string, listener: (code: number) => void) => {
        if (event === "exit") listener(0);
      }
    });
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it("derives provisioning from the selected spec and forwards only that spec", async () => {
    process.argv = ["node", "tests/uat/run-uat.ts", "future-advisory"];

    await import("./run-uat.js");

    expect(mocks.provisionForUat).toHaveBeenCalledWith("solo-admin", {
      excludeChunks: [],
      withoutNewsJsonBinding: false,
      withJobSearchFixture: false,
      withSportsPublicSourceFixtures: false,
      chatScript: undefined
    });
    const [command, args] = mocks.spawn.mock.calls[0] ?? [];
    expect(command).toBe("npx");
    expect(args).toEqual([
      "playwright",
      "test",
      "--config=tests/uat/playwright.uat.config.ts",
      "tests/uat/specs/future-advisory.uat.spec.ts"
    ]);
  });

  it("fails clearly when the selected spec has no valid uatLevel export", async () => {
    mocks.readFile.mockResolvedValue('export const notUatLevel = { level: "bare" } as const;');
    process.argv = ["node", "tests/uat/run-uat.ts", "future-advisory"];

    await expect(import("./run-uat.js")).rejects.toThrow(
      "tests/uat/specs/future-advisory.uat.spec.ts must export uatLevel per harness spec §5"
    );
    expect(mocks.provisionForUat).not.toHaveBeenCalled();
  });

  it("#1121 Task 4: threads a valid uatLevel.chatScript id through to provisioning", async () => {
    mocks.readFile.mockResolvedValue(
      `export const uatLevel = {
        level: "solo-admin",
        without: [],
        chatScript: "phase1-smoke"
      } as const;`
    );
    process.argv = ["node", "tests/uat/run-uat.ts", "future-advisory"];

    await import("./run-uat.js");

    expect(mocks.provisionForUat).toHaveBeenCalledWith("solo-admin", {
      excludeChunks: [],
      withoutNewsJsonBinding: false,
      withJobSearchFixture: false,
      withSportsPublicSourceFixtures: false,
      chatScript: "phase1-smoke"
    });
  });

  it("#2164: runs multiple specs in the caller's filter order, not readdir order", async () => {
    // readdir returns filesystem/alphabetical order: "a" before "z".
    mocks.readdir.mockResolvedValue(["a-spec.uat.spec.ts", "z-spec.uat.spec.ts"]);
    process.argv = ["node", "tests/uat/run-uat.ts", "z-spec", "a-spec"];

    await import("./run-uat.js");

    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    const [, firstArgs] = mocks.spawn.mock.calls[0] ?? [];
    const [, secondArgs] = mocks.spawn.mock.calls[1] ?? [];
    expect(firstArgs).toEqual([
      "playwright",
      "test",
      "--config=tests/uat/playwright.uat.config.ts",
      "tests/uat/specs/z-spec.uat.spec.ts"
    ]);
    expect(secondArgs).toEqual([
      "playwright",
      "test",
      "--config=tests/uat/playwright.uat.config.ts",
      "tests/uat/specs/a-spec.uat.spec.ts"
    ]);
  });

  it("threads the opt-in #1909 public-source fixture flag", async () => {
    mocks.readFile.mockResolvedValue(
      `export const uatLevel = {
        level: "admin+data",
        without: ["sports"],
        withoutNewsJsonBinding: true,
        withSportsPublicSourceFixtures: true
      } as const;`
    );
    process.argv = ["node", "tests/uat/run-uat.ts", "future-advisory"];

    await import("./run-uat.js");

    expect(mocks.provisionForUat).toHaveBeenCalledWith("admin+data", {
      excludeChunks: ["sports"],
      withoutNewsJsonBinding: true,
      withJobSearchFixture: false,
      withSportsPublicSourceFixtures: true,
      chatScript: undefined
    });
  });

  it("#1121 Task 4: fails clearly on an unknown uatLevel.chatScript id", async () => {
    mocks.readFile.mockResolvedValue(
      `export const uatLevel = {
        level: "solo-admin",
        without: [],
        chatScript: "not-a-real-script"
      } as const;`
    );
    process.argv = ["node", "tests/uat/run-uat.ts", "future-advisory"];

    await expect(import("./run-uat.js")).rejects.toThrow(
      "tests/uat/specs/future-advisory.uat.spec.ts has invalid uatLevel.chatScript: not-a-real-script"
    );
    expect(mocks.provisionForUat).not.toHaveBeenCalled();
  });
});

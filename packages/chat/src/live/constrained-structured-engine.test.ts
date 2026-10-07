import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ProcessModule from "./constrained-structured-process.js";
import type { TmuxIo } from "@moss/ai";
import type { StructuredChildIdentity } from "./structured-claude-engine.js";
import { ConstrainedStructuredEngine } from "./constrained-structured-engine.js";
import {
  ConstrainedProcessError,
  runConstrainedStructuredProcess
} from "./constrained-structured-process.js";
import { prepareConstrainedClaudeProfile } from "./constrained-claude-profile.js";
vi.mock("node:fs/promises", () => ({
  access: vi.fn(async () => {}),
  realpath: vi.fn(async (path: string) => path)
}));
vi.mock("./constrained-structured-process.js", async (original) => ({
  ...(await original<typeof ProcessModule>()),
  runConstrainedStructuredProcess: vi.fn()
}));
vi.mock("./constrained-claude-profile.js", () => ({
  prepareConstrainedClaudeProfile: vi.fn(),
  parseConstrainedClaudeOutput: (value: string) => JSON.parse(value).result
}));
const opts = {
  neutralDir: "/neutral/fresh",
  personaPath: "/neutral/fresh/persona",
  model: "exact-model",
  schema: { type: "object" }
};
function fixture(kind: "anthropic" | "openai-compatible") {
  const identity: StructuredChildIdentity = {
    wrap: (command, args) => ({ command, args: [...args] }),
    signalGroup: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: "synthetic-only",
      BASH_ENV: "/evil",
      OPENAI_BASE_URL: "https://evil.invalid"
    }
  };
  const io = { run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) } as unknown as TmuxIo;
  vi.mocked(prepareConstrainedClaudeProfile).mockResolvedValue({
    command: "/managed/claude",
    args: ["--print"],
    env: { HOME: "/fresh", CLAUDE_CODE_OAUTH_TOKEN: "synthetic-only" }
  });
  vi.mocked(runConstrainedStructuredProcess).mockResolvedValue({
    stdout: kind === "anthropic" ? '{"result":"{}"}' : '{"text":"{}"}',
    exitCode: 0,
    signal: null
  });
  return {
    identity,
    io,
    engine: new ConstrainedStructuredEngine(kind, io, "/owner-home", identity)
  };
}
afterEach(() => vi.clearAllMocks());
describe("constrained runner engine", () => {
  it.each(["anthropic"] as const)(
    "prepares %s before accepting a transcript, then starts one bounded process",
    async (kind) => {
      const { engine } = fixture(kind);
      await engine.launchStructured(opts);
      expect(runConstrainedStructuredProcess).not.toHaveBeenCalled();
      await engine.submitStructured("private untrusted transcript");
      await vi.waitFor(async () => expect((await engine.readStructured(0)).complete).toBe(true));
      expect((await engine.readStructured(0)).text).toBe("{}");
      const call = vi.mocked(runConstrainedStructuredProcess).mock.calls[0]![0];
      expect(JSON.stringify(call.args)).not.toContain("private untrusted transcript");
      expect(call.input).toContain("private untrusted transcript");
      expect(call.identity?.env).toBeUndefined();
      expect(call.env).not.toHaveProperty("BASH_ENV");
      expect(call.env).not.toHaveProperty("OPENAI_BASE_URL");
      expect(call.timeoutMs).toBe(100_000);
      await expect(engine.submitStructured("again")).rejects.toThrow();
    }
  );
  it.each([
    { nativeSearch: true },
    { mcpToken: "forged" },
    { mcpServerUrl: "https://tools.invalid" },
    { replayBatch: "prior transcript" }
  ])("rejects a tool/replay launch (%j)", async (extra) => {
    const { engine } = fixture("anthropic");
    await expect(engine.launchStructured({ ...opts, ...extra })).rejects.toThrow();
    expect(prepareConstrainedClaudeProfile).not.toHaveBeenCalled();
    expect(runConstrainedStructuredProcess).not.toHaveBeenCalled();
  });
  it("never reports a successful stop when process termination is unconfirmed", async () => {
    const { engine, identity } = fixture("anthropic");
    vi.mocked(runConstrainedStructuredProcess).mockRejectedValue(
      new ConstrainedProcessError("termination")
    );
    await engine.launchStructured(opts);
    await engine.submitStructured("synthetic transcript");
    await expect(engine.kill()).rejects.toMatchObject({ code: "termination" });
    expect(identity.release).not.toHaveBeenCalled();
    await expect(engine.kill()).rejects.toMatchObject({ code: "termination" });
  });
  it("retains and retries the cleanup handle before acknowledging a later stop", async () => {
    const { engine } = fixture("anthropic");
    const retry = vi.fn(async () => {});
    const error = new ConstrainedProcessError("termination", retry);
    vi.mocked(runConstrainedStructuredProcess).mockRejectedValue(error);
    await engine.launchStructured(opts);
    await engine.submitStructured("synthetic transcript");
    await engine.kill();
    expect(retry).toHaveBeenCalledTimes(1);
    await engine.kill();
    expect(retry).toHaveBeenCalledTimes(1);
  });
  it("rejects a direct Codex profile before any launch preparation or transcript dispatch", async () => {
    const { engine } = fixture("openai-compatible");
    await expect(engine.launchStructured(opts)).rejects.toThrow();
    expect(prepareConstrainedClaudeProfile).not.toHaveBeenCalled();
    expect(runConstrainedStructuredProcess).not.toHaveBeenCalled();
  });
  it("refuses execution without the runner's owner identity", async () => {
    const { io } = fixture("anthropic");
    await expect(
      new ConstrainedStructuredEngine("anthropic", io, "/home", undefined).launchStructured(opts)
    ).rejects.toThrow();
    expect(runConstrainedStructuredProcess).not.toHaveBeenCalled();
  });
});

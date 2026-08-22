import { describe, expect, it, vi } from "vitest";

import { createModuleBuildLiveAgent } from "../../apps/worker/src/module-build-live-agent.js";

describe("module build live-agent composition", () => {
  it("uses the real launch command and permission hook in the build directory", async () => {
    const writes = new Map<string, string>();
    const io = {
      run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      writeFile: vi.fn(async (path: string, content: string) => {
        writes.set(path, content);
      })
    };
    const mux = {
      open: vi.fn(async (opts: { launchLine: string }) => {
        expect(opts.launchLine).toContain("cd '/build/b1' && claude");
        return "module-build-session";
      }),
      submit: vi.fn(async (_handle: string, prompt: string) => {
        expect(prompt).toContain("writing_code");
      })
    };

    const launch = createModuleBuildLiveAgent({
      io: io as never,
      mux: mux as never,
      provider: "anthropic",
      mcpToken: "jst_test-token",
      mcpServerUrl: "http://api:3000/api/mcp"
    });

    await launch({ workingDir: "/build/b1", step: "writing_code", plan: { id: "videos" } });

    expect(writes.has("/build/b1/.jarvis-claude-permission-hook.mjs")).toBe(true);
    expect(writes.has("/build/b1/.jarvis-claude-settings.json")).toBe(true);
    expect(mux.open).toHaveBeenCalledOnce();
    expect(mux.submit).toHaveBeenCalledOnce();
  });
});

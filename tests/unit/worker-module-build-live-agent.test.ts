import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createModuleBuildLiveAgent } from "../../apps/worker/src/module-build-live-agent.js";

describe("module build live-agent composition", () => {
  it("does not press Enter twice when the multiplexer submit already sends it", async () => {
    let enterPresses = 0;
    let submittedPrompt = "";
    const io = {
      run: vi.fn(async (command: string) => ({
        code: 0,
        stdout: command === "find" ? "./jarvis.module.json\n" : "",
        stderr: ""
      })),
      writeFile: vi.fn(async () => {}),
      sleep: vi.fn(async () => {})
    };
    const mux = {
      open: vi.fn(async () => "module-build-session"),
      submit: vi.fn(async (_handle: string, prompt: string) => {
        submittedPrompt = prompt;
        enterPresses += 1;
      }),
      capturePane: vi.fn(async () => (submittedPrompt ? `❯ ${submittedPrompt}\n` : "❯\n")),
      pressEnter: vi.fn(async () => {
        enterPresses += 1;
      }),
      kill: vi.fn(async () => {})
    };

    await createModuleBuildLiveAgent({
      io: io as never,
      mux: mux as never,
      provider: "anthropic",
      ensureProviderLaunchReady: vi.fn(async () => {})
    })({ workingDir: "/build/b1", step: "writing_spec", plan: null });

    expect(enterPresses).toBe(1);
  });

  it("uses the real launch command and permission hook in the build directory", async () => {
    const writes = new Map<string, string>();
    let submittedPrompt = "";
    const io = {
      run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      writeFile: vi.fn(async (path: string, content: string) => {
        writes.set(path, content);
      }),
      sleep: vi.fn(async () => {})
    };
    const mux = {
      open: vi.fn(async (opts: { launchLine: string }) => {
        expect(opts.launchLine).toContain("cd '/build/b1' && claude");
        expect(opts.launchLine).toContain("--permission-mode acceptEdits");
        expect(opts.launchLine).toContain("--disallowedTools Bash");
        expect(opts.launchLine).not.toContain("--tools");
        expect(opts.launchLine).not.toContain("--settings");
        return "module-build-session";
      }),
      submit: vi.fn(async (_handle: string, prompt: string) => {
        expect(prompt).toContain("writing_code");
        submittedPrompt = prompt;
      }),
      capturePane: vi.fn(async () =>
        submittedPrompt
          ? `❯ ${submittedPrompt.slice(0, 48)}…\n────────────────────────────────\n`
          : "❯\n"
      ),
      pressEnter: vi.fn(async () => {}),
      kill: vi.fn(async () => {})
    };
    const ensureProviderLaunchReady = vi.fn(async () => {});

    const launch = createModuleBuildLiveAgent({
      io: io as never,
      mux: mux as never,
      provider: "anthropic",
      ensureProviderLaunchReady,
      mcpToken: "jst_test-token",
      mcpServerUrl: "http://api:3000/api/mcp"
    });

    await launch({ workingDir: "/build/b1", step: "writing_code", plan: { id: "videos" } });

    expect(writes.get("/build/b1/.module-build-persona.md")).toContain(
      "Do not use Bash or shell commands"
    );
    expect(writes.has("/build/b1/.jarvis-claude-permission-hook.mjs")).toBe(false);
    expect(ensureProviderLaunchReady).toHaveBeenCalledWith("anthropic", "/build/b1");
    expect(ensureProviderLaunchReady.mock.invocationCallOrder[0]).toBeLessThan(
      mux.open.mock.invocationCallOrder[0] ?? 0
    );
    expect(mux.open).toHaveBeenCalledOnce();
    expect(mux.submit).toHaveBeenCalledOnce();
  });

  it("waits for the builder's completion marker and returns the files it actually wrote", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/repo/apps/worker");
    let markerExists = false;
    let settled = false;
    const io = {
      run: vi.fn(async (command: string) => {
        if (command === "test") return { code: markerExists ? 0 : 1, stdout: "", stderr: "" };
        if (command === "find") {
          return {
            code: 0,
            stdout: "./jarvis.module.json\n./src/index.ts\n./.module-build-persona.md\n",
            stderr: ""
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      }),
      readFile: vi.fn(async () => ""),
      writeFile: vi.fn(async () => {}),
      sleep: vi.fn(async () => {
        expect(settled).toBe(false);
        markerExists = true;
      })
    };
    const mux = {
      open: vi.fn(async () => "module-build-session"),
      submit: vi.fn(async (_handle: string, prompt: string) => {
        expect(prompt).toContain("completion marker");
      }),
      capturePane: vi.fn(async () => "❯\n"),
      isAlive: vi.fn(async () => true),
      kill: vi.fn(async () => {})
    };
    const launch = createModuleBuildLiveAgent({
      io: io as never,
      mux: mux as never,
      provider: "anthropic",
      ensureProviderLaunchReady: vi.fn(async () => {})
    });

    const resultPromise = launch({
      workingDir: "/build/b1",
      step: "writing_code",
      plan: { id: "videos" }
    }).then((result) => {
      settled = true;
      return result;
    });

    await expect(resultPromise).resolves.toEqual({
      wroteFiles: ["jarvis.module.json", "src/index.ts"]
    });
    expect(io.sleep).toHaveBeenCalled();
    expect(mux.kill).toHaveBeenCalledWith("module-build-session");
    expect(io.run).toHaveBeenCalledWith(
      "pnpm",
      ["exec", "tsx", "scripts/build-external-module.ts", "/build/b1"],
      { cwd: join(import.meta.dirname, "../..") }
    );
    cwd.mockRestore();
  });

  // #2028 — google's flag is the real Gemini CLI's `--approval-mode auto_edit`, not the old
  // Antigravity `--mode accept-edits`. Same property under test: the builder may write inside its
  // own workspace unattended and nowhere else.
  it.each([
    ["openai-compatible", "--sandbox workspace-write"],
    ["google", "--approval-mode auto_edit"]
  ] as const)(
    "gives the %s builder unattended write access only in its workspace",
    async (provider, flag) => {
      const io = {
        run: vi.fn(async (command: string) => ({
          code: command === "find" ? 0 : 0,
          stdout: "",
          stderr: ""
        })),
        readFile: vi.fn(async () => ""),
        writeFile: vi.fn(async () => {}),
        sleep: vi.fn(async () => {})
      };
      const mux = {
        open: vi.fn(async (opts: { launchLine: string }) => {
          expect(opts.launchLine).toContain(flag);
          return "module-build-session";
        }),
        submit: vi.fn(async () => {}),
        capturePane: vi.fn(async () => (provider === "openai-compatible" ? "›\n" : ">\n")),
        kill: vi.fn(async () => {})
      };
      const launch = createModuleBuildLiveAgent({
        io: io as never,
        mux: mux as never,
        provider,
        ensureProviderLaunchReady: vi.fn(async () => {})
      });
      await launch({ workingDir: "/build/b1", step: "writing_spec", plan: {} });
    }
  );
});

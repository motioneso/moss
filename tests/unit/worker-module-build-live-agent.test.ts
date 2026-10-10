import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createModuleBuildLiveAgent,
  resolveWorkspaceRoot
} from "../../apps/worker/src/module-build-live-agent.js";

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
        expect(opts.launchLine).toContain("--settings '/build/b1/.jarvis-claude-settings.json'");
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
    expect(writes.has("/build/b1/.jarvis-claude-permission-hook.mjs")).toBe(true);
    expect(writes.get("/build/b1/.jarvis-claude-settings.json")).toContain(
      "/internal/vault-read-report"
    );
    expect(writes.get("/build/b1/.jarvis-claude-permission-token")).toBe("jst_test-token\n");
    expect(ensureProviderLaunchReady).toHaveBeenCalledWith("anthropic", "/build/b1");
    expect(ensureProviderLaunchReady.mock.invocationCallOrder[0]).toBeLessThan(
      mux.open.mock.invocationCallOrder[0] ?? 0
    );
    expect(mux.open).toHaveBeenCalledOnce();
    expect(mux.submit).toHaveBeenCalledOnce();
    expect(io.run).toHaveBeenCalledWith("rm", [
      "-f",
      "/build/b1/.jarvis-claude-permission-hook.mjs",
      "/build/b1/.jarvis-claude-settings.json",
      "/build/b1/.jarvis-claude-permission-token",
      "/build/b1/.jarvis-claude-mcp.json"
    ]);
    expect(io.run.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      mux.kill.mock.invocationCallOrder[0] ?? 0
    );
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
            stdout:
              "./jarvis.module.json\n./src/index.ts\n./.module-build-persona.md\n./.jarvis-claude-permission-hook.mjs\n./.jarvis-claude-settings.json\n./.jarvis-claude-permission-token\n./.jarvis-claude-mcp.json\n",
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

  it.each(["launch", "cleanup"])(
    "fails closed and removes only session files on %s failure",
    async (failure) => {
      const io = {
        run: vi.fn(async (command: string) => ({
          code: failure === "cleanup" && command === "rm" ? 1 : 0,
          stdout: "",
          stderr: "private failure detail"
        })),
        writeFile: vi.fn(async () => {}),
        sleep: vi.fn(async () => {})
      };
      const mux = {
        open: vi.fn(async () => {
          if (failure === "launch") throw new Error("launch failed");
          return "session";
        }),
        submit: vi.fn(async () => {}),
        capturePane: vi.fn(async () => "❯\n"),
        kill: vi.fn(async () => {})
      };
      const launch = createModuleBuildLiveAgent({
        io: io as never,
        mux: mux as never,
        provider: "anthropic",
        ensureProviderLaunchReady: vi.fn(async () => {}),
        mcpToken: "jst_synthetic",
        mcpServerUrl: "http://api:3000/api/mcp"
      });
      await expect(
        launch({ workingDir: "/build/b1", step: "writing_spec", plan: null })
      ).rejects.toThrow(
        failure === "launch" ? "launch failed" : "module build session files could not be removed"
      );
      expect(io.run).toHaveBeenCalledWith("rm", [
        "-f",
        "/build/b1/.jarvis-claude-permission-hook.mjs",
        "/build/b1/.jarvis-claude-settings.json",
        "/build/b1/.jarvis-claude-permission-token",
        "/build/b1/.jarvis-claude-mcp.json"
      ]);
    }
  );

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

  it("records one build turn row on completion and one on failure, never the prompt", async () => {
    const outcomes: string[] = [];
    const io = {
      run: vi.fn(async (command: string) => ({
        code: command === "find" ? 0 : 0,
        stdout: "",
        stderr: ""
      })),
      writeFile: vi.fn(async () => {}),
      sleep: vi.fn(async () => {})
    };
    const mux = {
      open: vi.fn(async () => "module-build-session"),
      submit: vi.fn(async () => {}),
      capturePane: vi.fn(async () => "❯\n"),
      isAlive: vi.fn(async () => true),
      kill: vi.fn(async () => {})
    };
    const launch = createModuleBuildLiveAgent({
      io: io as never,
      mux: mux as never,
      provider: "anthropic",
      ensureProviderLaunchReady: vi.fn(async () => {}),
      recordTurn: (outcome) => outcomes.push(outcome)
    });

    await launch({ workingDir: "/build/b1", step: "writing_spec", plan: null });
    expect(outcomes).toEqual(["ok"]);

    // Now drive a failure: the completion marker never appears and the agent is dead.
    const failingIo = {
      run: vi.fn(async (command: string) => ({
        code: command === "test" ? 1 : 0,
        stdout: "",
        stderr: ""
      })),
      writeFile: vi.fn(async () => {}),
      sleep: vi.fn(async () => {})
    };
    const deadMux = {
      ...mux,
      isAlive: vi.fn(async () => false)
    };
    const failLaunch = createModuleBuildLiveAgent({
      io: failingIo as never,
      mux: deadMux as never,
      provider: "anthropic",
      ensureProviderLaunchReady: vi.fn(async () => {}),
      recordTurn: (outcome) => outcomes.push(outcome)
    });
    await expect(
      failLaunch({ workingDir: "/build/b1", step: "writing_spec", plan: null })
    ).rejects.toThrow();
    expect(outcomes).toEqual(["ok", "error"]);
  });
});

describe("module build workspace root", () => {
  const marker = join("scripts", "build-external-module.ts");

  it("finds the repo root from the bundled dist directory", () => {
    const root = resolveWorkspaceRoot("/app/dist", (path) => path === join("/app", marker));
    expect(root).toBe("/app");
  });

  it("finds the repo root from the source directory", () => {
    const root = resolveWorkspaceRoot(
      "/repo/apps/worker/src",
      (path) => path === join("/repo", marker)
    );
    expect(root).toBe("/repo");
  });

  it("throws instead of falling back to the filesystem root", () => {
    expect(() => resolveWorkspaceRoot("/app/dist", () => false)).toThrow(/workspace root/);
  });
});

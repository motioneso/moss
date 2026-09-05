import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { cliAvailable, tmuxAvailable } from "../../packages/ai/src/cli-availability.js";

describe("cliAvailable", () => {
  it("finds a newly installed managed CLI even when the API PATH omits its bin directory", async () => {
    const prefix = await mkdtemp(join(tmpdir(), "cli-availability-"));
    try {
      vi.stubEnv("MOSS_HOST_CLIS", "");
      vi.stubEnv("JARVIS_HOST_CLIS", "");
      vi.stubEnv("JARVIS_CLI_TOOLS_PREFIX", prefix);
      vi.stubEnv("PATH", "/nonexistent");
      await mkdir(join(prefix, "bin"));
      const binary = join(prefix, "bin", "gemini");
      expect(await cliAvailable("google")).toBe(false);
      await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
      expect(await cliAvailable("google")).toBe(false);
      await chmod(binary, 0o700);
      expect(await cliAvailable("google")).toBe(true);
      expect(await cliAvailable("anthropic")).toBe(false);
      vi.stubEnv("MOSS_HOST_CLIS", "claude");
      expect(await cliAvailable("google")).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await rm(prefix, { recursive: true, force: true });
    }
  });
  it("maps anthropic to claude binary and returns true when found", async () => {
    const deps = { which: async (bin: string) => (bin === "claude" ? "/usr/bin/claude" : null) };
    expect(await cliAvailable("anthropic", deps)).toBe(true);
  });

  it("maps openai-compatible to codex binary and returns true when found", async () => {
    const deps = {
      which: async (bin: string) => (bin === "codex" ? "/usr/local/bin/codex" : null)
    };
    expect(await cliAvailable("openai-compatible", deps)).toBe(true);
  });

  it("maps google to the gemini binary and returns true when found", async () => {
    const deps = { which: async (bin: string) => (bin === "gemini" ? "/usr/bin/gemini" : null) };
    expect(await cliAvailable("google", deps)).toBe(true);
  });

  // #2026/#2028: the pinned @google/gemini-cli package only ever installs a command called
  // `gemini`, so that is the name the provider maps to now. The old Antigravity name survives as
  // an alias so a host that already declared it keeps resolving.
  it("still counts the old Antigravity name on PATH as the google provider", async () => {
    const deps = { which: async (bin: string) => (bin === "agy" ? "/usr/bin/agy" : null) };
    expect(await cliAvailable("google", deps)).toBe(true);
  });

  it("probes the primary name before any alias", async () => {
    const probed: string[] = [];
    const deps = {
      which: async (bin: string) => {
        probed.push(bin);
        return bin === "gemini" ? "/usr/bin/gemini" : null;
      }
    };
    expect(await cliAvailable("google", deps)).toBe(true);
    expect(probed).toEqual(["gemini"]);
  });

  it("does not let another kind's binary satisfy a kind with no aliases", async () => {
    const deps = { which: async (bin: string) => (bin === "gemini" ? "/usr/bin/gemini" : null) };
    expect(await cliAvailable("anthropic", deps)).toBe(false);
    expect(await cliAvailable("openai-compatible", deps)).toBe(false);
  });

  it("returns false when which returns null", async () => {
    const deps = { which: async (_bin: string) => null };
    expect(await cliAvailable("anthropic", deps)).toBe(false);
    expect(await cliAvailable("openai-compatible", deps)).toBe(false);
    expect(await cliAvailable("google", deps)).toBe(false);
  });

  it("returns false when wrong binary is found for provider", async () => {
    // Only "codex" is available, not "claude"
    const deps = {
      which: async (bin: string) => (bin === "codex" ? "/usr/local/bin/codex" : null)
    };
    expect(await cliAvailable("anthropic", deps)).toBe(false);
    expect(await cliAvailable("google", deps)).toBe(false);
  });
});

describe("cliAvailable — JARVIS_HOST_CLIS operator-declared contract (#341)", () => {
  // The container cannot see host CLIs (only their auth dirs are mounted, ADR 0008), so
  // install.sh declares the detected host CLIs via JARVIS_HOST_CLIS. When set, cliAvailable
  // must answer from membership alone — it must NOT shell out to `command -v` (which would
  // false-negative inside the container).
  const noPathProbe = {
    which: async (_bin: string): Promise<string | null> => {
      throw new Error("PATH probe must not run when JARVIS_HOST_CLIS is set");
    }
  };

  it("returns true when the kind's binary is declared (claude)", async () => {
    expect(
      await cliAvailable("anthropic", { ...noPathProbe, env: { JARVIS_HOST_CLIS: "claude,codex" } })
    ).toBe(true);
  });

  it("returns true for the google kind via the agy/google mapping", async () => {
    expect(
      await cliAvailable("google", { ...noPathProbe, env: { JARVIS_HOST_CLIS: "claude,agy" } })
    ).toBe(true);
  });

  it("returns true for the google kind when the upstream 'gemini' name is declared", async () => {
    expect(
      await cliAvailable("google", { ...noPathProbe, env: { JARVIS_HOST_CLIS: "gemini" } })
    ).toBe(true);
  });

  it("returns false when a different binary is declared", async () => {
    expect(
      await cliAvailable("anthropic", { ...noPathProbe, env: { JARVIS_HOST_CLIS: "codex,agy" } })
    ).toBe(false);
    expect(
      await cliAvailable("openai-compatible", {
        ...noPathProbe,
        env: { JARVIS_HOST_CLIS: "claude,agy" }
      })
    ).toBe(false);
    expect(
      await cliAvailable("google", { ...noPathProbe, env: { JARVIS_HOST_CLIS: "claude,codex" } })
    ).toBe(false);
  });

  it("is case-insensitive and trims whitespace/empty entries", async () => {
    expect(
      await cliAvailable("anthropic", {
        ...noPathProbe,
        env: { JARVIS_HOST_CLIS: "  Claude ,  , CODEX " }
      })
    ).toBe(true);
  });

  it("falls back to the PATH probe when JARVIS_HOST_CLIS is unset (host install / tests)", async () => {
    const which = async (bin: string) => (bin === "claude" ? "/usr/bin/claude" : null);
    expect(await cliAvailable("anthropic", { which, env: {} })).toBe(true);
    expect(await cliAvailable("google", { which, env: {} })).toBe(false);
  });

  it("falls back to the PATH probe when JARVIS_HOST_CLIS is empty/whitespace", async () => {
    const which = async (bin: string) => (bin === "codex" ? "/usr/bin/codex" : null);
    expect(await cliAvailable("openai-compatible", { which, env: { JARVIS_HOST_CLIS: "" } })).toBe(
      true
    );
    expect(
      await cliAvailable("openai-compatible", { which, env: { JARVIS_HOST_CLIS: "   " } })
    ).toBe(true);
  });
});

describe("tmuxAvailable", () => {
  it("returns true when tmux binary is found", async () => {
    const deps = { which: async (bin: string) => (bin === "tmux" ? "/usr/bin/tmux" : null) };
    expect(await tmuxAvailable(deps)).toBe(true);
  });

  it("returns false when tmux binary is not found", async () => {
    const deps = { which: async (_bin: string) => null };
    expect(await tmuxAvailable(deps)).toBe(false);
  });
});

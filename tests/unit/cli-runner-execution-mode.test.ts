/**
 * #1350 — the cli-runner MUST honour `execution_mode` at the RPC seam.
 *
 * Engine selection used to be written twice: once in the in-process factory
 * (`createRealEngineFactory`, which honoured the mode) and once inline in
 * `EngineHost.launchOnce` (which did not, and always built the tmux REPL engine). Every
 * containerized deploy takes the RPC fork, so a provider configured `non_interactive`
 * still got an interactive multiplexer launch — which is exactly how prod chat went down
 * on 2026-07-28 while every provider row in the prod DB read `non_interactive`.
 *
 * These tests assert the behaviour at the RUNNER, not at the in-process factory: a
 * `non_interactive` launch must build a one-shot engine and must create NO multiplexer
 * session. A test that only exercised `createRealEngineFactory` was green throughout the
 * outage and could never have caught this.
 */
import { describe, expect, it, vi } from "vitest";

import type { TmuxIo } from "../../packages/ai/src/adapters/tmux-bridge.js";
import { CliChatEngineHost } from "../../packages/cli-runner/src/engine-host.js";
import {
  createChatEngine,
  isBoundedFallbackEngine
} from "../../packages/chat/src/live/engine-selection.js";
import { ClaudePrintChatEngine } from "../../packages/chat/src/live/claude-print-chat-engine.js";
import { CliSourceEngine } from "../../packages/chat/src/live/cli-source-engine.js";
import { GeminiPrintChatEngine } from "../../packages/chat/src/live/gemini-print-chat-engine.js";
import { CliChatEngineImpl } from "../../packages/chat/src/live/cli-chat-engine.js";

const NEUTRAL_BASE = "/tmp/jarvis-1350-neutral";

/**
 * A fake TmuxIo that RECORDS every `tmux` verb it is asked to run. The assertion that
 * matters is the absence of `new-session`: a one-shot launch must never create a pane.
 */
function makeRecordingIo(): { io: TmuxIo; tmuxVerbs: string[] } {
  const tmuxVerbs: string[] = [];
  const run = vi.fn(async (cmd: string, args: string[] = []) => {
    if (cmd === "tmux") {
      // Skip the leading `-S <socket>` pair so the recorded token is the verb itself.
      const verb = args.find((a, i) => i > 0 && args[i - 1] !== "-S" && !a.startsWith("-"));
      tmuxVerbs.push(verb ?? args.join(" "));
      if (args.includes("list-sessions")) return { code: 1, stdout: "", stderr: "" };
    }
    if (cmd === "ls") return { code: 1, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });

  return {
    io: {
      run: run as unknown as TmuxIo["run"],
      readFile: vi.fn().mockResolvedValue(""),
      writeFile: vi.fn().mockResolvedValue(undefined),
      sleep: vi.fn().mockResolvedValue(undefined)
    },
    tmuxVerbs
  };
}

function makeHost(io: TmuxIo): CliChatEngineHost {
  return new CliChatEngineHost({
    io,
    neutralBase: NEUTRAL_BASE,
    homeBase: "/tmp/workshop-synthetic-credential-home",
    // The single-active-user gate is OFF in prod; keep it off here so nothing but the
    // engine choice can influence the outcome.
    singleUser: false,
    cliPresent: async () => true,
    launchTimeoutMs: 2_000
  });
}

describe("#1350 the shared engine selector", () => {
  it("returns the one-shot engines for non_interactive anthropic and google", () => {
    const { io } = makeRecordingIo();
    expect(
      createChatEngine("anthropic", "alice", io, { executionMode: "non_interactive" })
    ).toBeInstanceOf(ClaudePrintChatEngine);
    expect(
      createChatEngine("google", "alice", io, { executionMode: "non_interactive" })
    ).toBeInstanceOf(GeminiPrintChatEngine);
  });

  it("returns the interactive engine when the mode is interactive or absent", () => {
    const { io } = makeRecordingIo();
    expect(
      createChatEngine("anthropic", "alice", io, { executionMode: "interactive" })
    ).toBeInstanceOf(CliChatEngineImpl);
    expect(createChatEngine("anthropic", "alice", io, {})).toBeInstanceOf(CliChatEngineImpl);
  });

  it("keeps every other provider on the interactive engine even when non_interactive", () => {
    const { io } = makeRecordingIo();
    // openai-compatible has its own in-engine non-interactive handling; it must NOT be
    // silently rerouted to a print engine that cannot speak its transcript schema.
    expect(
      createChatEngine("openai-compatible", "alice", io, { executionMode: "non_interactive" })
    ).toBeInstanceOf(CliChatEngineImpl);
    expect(isBoundedFallbackEngine("openai-compatible", "non_interactive")).toBe(false);
  });
});

describe("#1350 EngineHost.launchOnce honours execution_mode at the RPC seam", () => {
  it("builds a one-shot engine and creates NO mux session for a non_interactive launch", async () => {
    const { io, tmuxVerbs } = makeRecordingIo();
    const host = makeHost(io);

    await host.launch("alice", {
      provider: "anthropic",
      personaText: "You are Jarvis.",
      executionMode: "non_interactive"
    });

    // The regression: before #1350 this launch went through tmux `new-session`.
    expect(tmuxVerbs).not.toContain("new-session");
    expect(host.liveEngineCount()).toBe(1);
  });

  it("still creates a mux session for an interactive launch", async () => {
    const { io, tmuxVerbs } = makeRecordingIo();
    const host = makeHost(io);

    await host.launch("alice", {
      provider: "anthropic",
      personaText: "You are Jarvis.",
      executionMode: "interactive"
    });

    expect(tmuxVerbs).toContain("new-session");
  });

  it("does not let a source launch replace an active ordinary session", async () => {
    const { io, tmuxVerbs } = makeRecordingIo();
    const host = makeHost(io);

    await host.launch("alice", {
      provider: "anthropic",
      personaText: "You are Jarvis.",
      executionMode: "interactive"
    });

    await expect(
      host.launchSourceGeneration("alice", {
        scope: { actorUserId: "user-1", providerConfigId: "provider-1" },
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        personaText: "source only",
        schema: { type: "object", properties: {} }
      })
    ).rejects.toThrow("launch is already active");
    expect(tmuxVerbs.filter((verb) => verb === "new-session")).toHaveLength(1);
  });

  it("rejects unsupported source providers before creating an engine", async () => {
    const { io } = makeRecordingIo();
    const host = makeHost(io);

    await expect(
      host.launchSourceGeneration("alice", {
        scope: { actorUserId: "user-1", providerConfigId: "provider-1" },
        provider: "google",
        model: "gemini-2.5-pro",
        personaText: "source only",
        schema: { type: "object", properties: {} }
      })
    ).rejects.toThrow("source generation is unavailable");
    expect(host.liveEngineCount()).toBe(0);
  });

  it("kills a timed-out source engine again if its launch later succeeds", async () => {
    const { io } = makeRecordingIo();
    const host = new CliChatEngineHost({
      io,
      neutralBase: NEUTRAL_BASE,
      homeBase: "/tmp/workshop-synthetic-credential-home",
      singleUser: false,
      cliPresent: async () => true,
      launchTimeoutMs: 5
    });
    let finish!: (value: { offset: number }) => void;
    const launch = vi.spyOn(CliSourceEngine.prototype, "launchStructured").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const kill = vi.spyOn(CliSourceEngine.prototype, "kill").mockResolvedValue();
    try {
      await expect(
        host.launchSourceGeneration("source-delayed", {
          scope: { actorUserId: "user-1", providerConfigId: "provider-1" },
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          personaText: "source only",
          schema: {}
        })
      ).rejects.toThrow();
      expect(kill).toHaveBeenCalledTimes(1);
      finish({ offset: 0 });
      await vi.waitFor(() => expect(kill).toHaveBeenCalledTimes(2));
      expect(host.liveEngineCount()).toBe(0);
    } finally {
      launch.mockRestore();
      kill.mockRestore();
    }
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  ChatSessionManager,
  type ChatSessionManagerDeps,
  ChatStreamLimitError,
  ChatTurnInFlightError
} from "../../packages/chat/src/live/chat-session-manager.js";
import type {
  CliChatEngine,
  EngineLaunchOpts,
  TranscriptRecord
} from "../../packages/chat/src/live/types.js";
import {
  normalizeChatSurface,
  parseSurfaceSessionKey,
  surfaceSessionKey
} from "../../packages/chat/src/live/chat-surface.js";

describe("surface session keys", () => {
  it("round-trips actor ids containing the key delimiter", () => {
    const key = surfaceSessionKey("actor:with:delimiters", "demo-module");

    expect(parseSurfaceSessionKey(key)).toEqual({
      actorUserId: "actor:with:delimiters",
      surface: "demo-module"
    });
  });

  it("defaults absent surfaces to drawer and rejects invalid slugs", () => {
    expect(normalizeChatSurface()).toBe("drawer");
    expect(() => normalizeChatSurface("Bad Surface")).toThrow("Invalid chat surface");
  });
});

function makeDeps(engineFactory: ChatSessionManagerDeps["engineFactory"]) {
  return {
    engineFactory,
    conversationProvenance: { recordAdmission: vi.fn().mockResolvedValue(undefined) },
    persistence: {
      getCurrentThreadState: vi.fn().mockResolvedValue({ id: "thread-a", incognito: false }),
      resolveActiveProvider: vi
        .fn()
        .mockResolvedValue({ provider: "anthropic" as const, model: "sonnet" }),
      listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
      recordTurn: vi.fn().mockResolvedValue(undefined),
      openNewConversation: vi.fn().mockResolvedValue(undefined),
      getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
      touchExistingThread: vi.fn().mockResolvedValue(true)
    },
    personaFs: {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined)
    },
    clock: { now: () => Date.now() },
    idleMs: 60_000,
    neutralBase: "/tmp",
    persona: "You are Jarvis.",
    pollMs: 0
  };
}

type SurfaceEngine = CliChatEngine & { readonly provider: "anthropic" };

class SeedEngine implements SurfaceEngine {
  readonly provider = "anthropic" as const;
  readonly submitted: string[] = [];

  async launch(_opts: EngineLaunchOpts): Promise<{ offset: number }> {
    return { offset: 0 };
  }

  async submit(text: string): Promise<void> {
    this.submitted.push(text);
  }

  async readNew(afterOffset: number): Promise<{
    records: TranscriptRecord[];
    offset: number;
    complete: boolean;
  }> {
    return { records: [], offset: afterOffset, complete: true };
  }

  async isAlive(): Promise<boolean> {
    return true;
  }

  async kill(): Promise<void> {}

  async interrupt(): Promise<void> {}
}

class BlockingEngine extends SeedEngine {
  private readonly readGate: Promise<void>;
  private releaseRead: () => void = () => {};

  constructor(private readonly answer: string) {
    super();
    this.readGate = new Promise((resolve) => {
      this.releaseRead = resolve;
    });
  }

  release(): void {
    this.releaseRead();
  }

  override async readNew(afterOffset: number): Promise<{
    records: TranscriptRecord[];
    offset: number;
    complete: boolean;
  }> {
    await this.readGate;
    return {
      records: [{ kind: "reply" as const, text: this.answer }],
      offset: afterOffset + 1,
      complete: true
    };
  }
}

describe("surface-scoped ChatSessionManager state", () => {
  it("reports a warm private session without a durable thread id as private", async () => {
    const manager = new ChatSessionManager(makeDeps(() => new SeedEngine()));
    const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
    sessions.set("u1:drawer", { threadId: null, incognito: true });

    await expect(manager.getPrivacyState("u1")).resolves.toEqual({ incognito: true });
  });

  it("keeps seed idempotency independent per surface", async () => {
    const engines = new Map<string, SeedEngine>();
    const manager = new ChatSessionManager(
      makeDeps((_provider, sessionKey) => {
        const engine = new SeedEngine();
        engines.set(sessionKey, engine);
        return engine;
      })
    );

    await manager.seedContext("u1", "Ben", "seed", "demo-module-onboarding");
    await manager.seedContext("u1", "Ben", "seed", "demo-module-onboarding");
    await manager.seedContext("u1", "Ben", "seed", "demo-module-onboarding", "demo-module");

    expect(engines.get("u1:drawer")?.submitted).toEqual(["seed"]);
    expect(engines.get("u1:demo-module")?.submitted).toEqual(["seed"]);
  });

  it("locks turns per surface while allowing the other surface to proceed", async () => {
    const engines = new Map<string, BlockingEngine>();
    const manager = new ChatSessionManager(
      makeDeps((_provider, sessionKey) => {
        const engine = new BlockingEngine(sessionKey.endsWith(":demo-module") ? "job" : "drawer");
        engines.set(sessionKey, engine);
        return engine;
      })
    );

    const drawerTurn = manager.submitTurn("u1", "Ben", "drawer question");
    await vi.waitFor(() => expect(engines.get("u1:drawer")).toBeDefined());
    await expect(manager.submitTurn("u1", "Ben", "drawer again")).rejects.toBeInstanceOf(
      ChatTurnInFlightError
    );

    const surfaceTurn = manager.submitTurn(
      "u1",
      "Ben",
      "surface question",
      undefined,
      "demo-module"
    );
    await vi.waitFor(() => expect(engines.get("u1:demo-module")).toBeDefined());

    engines.get("u1:drawer")?.release();
    engines.get("u1:demo-module")?.release();
    await expect(drawerTurn).resolves.toMatchObject({ reply: "drawer" });
    await expect(surfaceTurn).resolves.toMatchObject({ reply: "job" });
  });

  it("enforces subscriber caps per surface and across the actor", () => {
    const manager = new ChatSessionManager(makeDeps(() => new SeedEngine()));
    const subscribe = (surface: string) => manager.subscribe("u1", () => {}, surface);

    for (let i = 0; i < 5; i += 1) subscribe("drawer");
    expect(() => subscribe("drawer")).toThrow(ChatStreamLimitError);

    for (let i = 0; i < 5; i += 1) subscribe("demo-module");
    expect(() => subscribe("demo-module")).toThrow(ChatStreamLimitError);
  });
});

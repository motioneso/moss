import { describe, expect, it, vi } from "vitest";
import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import type { EngineLaunchOpts, TranscriptRecord } from "../../packages/chat/src/live/types.js";
import {
  CliChatDeliveryUnknownError,
  CliChatUnavailableError
} from "../../packages/chat/src/live/errors.js";
import { makeMinimalDeps } from "./chat-session-manager.test.js";
import { renderCurrentTimeContext } from "../../packages/chat/src/live/time-context.js";

// Fixed "now" for every manager in this file — getThreadContext here always resolves
// localTimezone: null, so every submitted turn carries this same UTC-only time block (#1869).
const NOW = new Date("2026-08-30T12:00:00.000Z");
function withTime(text: string): string {
  return `${renderCurrentTimeContext(NOW, null)}\n\n${text}`;
}

// #1157 turn-time self-heal: when the engine behind a session dies out-of-band (the daemon
// killed it after a VerifiedSubmitError, the cli-runner restarted, the tmux server died with
// the container), the next turn must evict + relaunch + resubmit ONCE instead of surfacing
// `chat input unavailable` forever until a manual POST /api/chat/clear.

/** A scriptable fake engine whose launch/submit can be told to fail. */
class ScriptedEngine {
  readonly provider = "anthropic" as const;
  launchOpts: EngineLaunchOpts | null = null;
  readonly submitted: string[] = [];
  killed = false;
  launchCount = 0;

  constructor(
    private readonly behavior: {
      readonly launchError?: Error;
      readonly submitError?: Error;
    } = {}
  ) {}

  async launch(opts: EngineLaunchOpts): Promise<{ offset: number }> {
    this.launchOpts = opts;
    this.launchCount += 1;
    if (this.behavior.launchError) throw this.behavior.launchError;
    return { offset: 0 };
  }
  async submit(text: string): Promise<void> {
    if (this.behavior.submitError) throw this.behavior.submitError;
    this.submitted.push(text);
  }
  async readNew(
    afterOffset: number
  ): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }> {
    return {
      records: [{ kind: "reply", text: "ok" }],
      offset: afterOffset + 1,
      complete: true
    };
  }
  async isAlive(): Promise<boolean> {
    return !this.killed;
  }
  async kill(): Promise<void> {
    this.killed = true;
  }
  async interrupt(): Promise<void> {}
}

function makeHarness(engines: ScriptedEngine[]) {
  const factoryCalls: string[] = [];
  const revoked: string[] = [];
  const listPriorTurns = vi.fn().mockResolvedValue({ recent: [], oldSummary: null });
  const deps = makeMinimalDeps({
    engineFactory: (provider: string) => {
      factoryCalls.push(provider);
      const engine = engines.shift();
      if (!engine) throw new Error("test ran out of scripted engines");
      return engine as never;
    },
    // Server-owned drain keeps `submitted` to exactly the real turn texts.
    serverOwnsDrain: true,
    pollMs: 0,
    now: () => NOW,
    revokeMcpToken: (id: string) => revoked.push(id),
    persistence: {
      resolveActiveProvider: vi.fn().mockResolvedValue({ provider: "anthropic", model: "sonnet" }),
      listPriorTurns,
      recordTurn: vi.fn().mockResolvedValue(undefined),
      openNewConversation: vi.fn().mockResolvedValue(undefined),
      getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
      touchExistingThread: vi.fn().mockResolvedValue(true)
    }
  });
  return { manager: new ChatSessionManager(deps as never), factoryCalls, revoked, listPriorTurns };
}

describe("ChatSessionManager self-heal (#1157)", () => {
  it("heals a dead engine: evicts, relaunches with forced replay, resubmits once", async () => {
    const engineA = new ScriptedEngine({
      submitError: new CliChatUnavailableError("no live session for this sessionKey")
    });
    const engineB = new ScriptedEngine();
    const { manager, factoryCalls, listPriorTurns } = makeHarness([engineA, engineB]);
    const statuses: string[] = [];
    manager.subscribe("u1", (record) => {
      if (record.kind === "status") statuses.push(record.text);
    });

    const result = await manager.submitTurn("u1", "Ben", "hello");

    expect(result.reply).toBe("ok");
    expect(factoryCalls).toHaveLength(2); // relaunched exactly once
    expect(engineA.killed).toBe(true); // stale handle torn down quietly
    expect(engineB.submitted).toEqual([withTime("hello")]); // the SAME turn text was resubmitted
    // The relaunch requested a forced conversation replay so the fresh engine has context.
    expect(listPriorTurns.mock.calls.at(-1)?.[1]).toMatchObject({ forceReplay: true });
    // The user sees why the turn took a relaunch.
    expect(statuses).toContain("Chat session was lost — reconnecting…");
  });

  it("surfaces the error when the healed engine also fails, without a second retry", async () => {
    const engineA = new ScriptedEngine({
      submitError: new CliChatUnavailableError("no live session for this sessionKey")
    });
    const engineB = new ScriptedEngine({
      submitError: new CliChatUnavailableError("still dead")
    });
    const { manager, factoryCalls } = makeHarness([engineA, engineB]);

    await expect(manager.submitTurn("u1", "Ben", "hello")).rejects.toBeInstanceOf(
      CliChatUnavailableError
    );
    expect(factoryCalls).toHaveLength(2); // exactly one heal attempt — no retry loop
  });

  it("keeps CliChatDeliveryUnknownError semantics: evict, revoke, rethrow, NO resubmit", async () => {
    // delivery_unknown means the text MAY have entered the engine — resubmitting risks a
    // duplicated turn, so the pre-#1157 evict-and-throw behavior must be preserved.
    const engineA = new ScriptedEngine({
      submitError: new CliChatDeliveryUnknownError("paste outcome unknown")
    });
    const { manager, factoryCalls, revoked } = makeHarness([engineA]);

    await expect(manager.submitTurn("u1", "Ben", "hello")).rejects.toBeInstanceOf(
      CliChatDeliveryUnknownError
    );
    expect(factoryCalls).toHaveLength(1); // never relaunched
    expect(revoked).toContain("u1:drawer");
  });

  it("heals a failed LAUNCH once", async () => {
    // Post-restart shape (#1157 original report): the tmux server died with the container,
    // the first launch attempt fails, the retry must succeed without manual intervention.
    const engineA = new ScriptedEngine({
      launchError: new CliChatUnavailableError("could not start the live chat session")
    });
    const engineB = new ScriptedEngine();
    const { manager, factoryCalls } = makeHarness([engineA, engineB]);

    const result = await manager.submitTurn("u1", "Ben", "hello");

    expect(result.reply).toBe("ok");
    expect(factoryCalls).toHaveLength(2);
    expect(engineB.submitted).toEqual([withTime("hello")]);
  });
});

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterAll } from "vitest";

import type { GenerateStructuredProviderInput } from "@moss/ai";

import { CliStructuredAdapter } from "./cli-structured-adapter.js";
import type { CliChatEngine, EngineLaunchOpts } from "./types.js";
import type { ChatEngineFactory } from "./runtime.js";

const ROOT = join(tmpdir(), "jarv1s-structured");

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

function baseInput(
  service: GenerateStructuredProviderInput["service"]
): GenerateStructuredProviderInput {
  return {
    service,
    model: { provider_kind: "anthropic", provider_model_id: "claude-sonnet-5" },
    messages: [{ role: "user", content: "score this" }],
    schema: { type: "object", properties: {} },
    maxOutputTokens: 100
  };
}

/** A CliChatEngine stub that records the neutralDir it was launched with and replies instantly. */
function fakeEngine(onLaunch: (opts: EngineLaunchOpts) => void): CliChatEngine {
  return {
    provider: "anthropic",
    async launch(opts) {
      onLaunch(opts);
      return { offset: 0 };
    },
    async submit() {},
    async interrupt() {},
    async readNew() {
      return { records: [{ kind: "reply", text: "{}" }], offset: 1, complete: true };
    },
    async isAlive() {
      return true;
    },
    async kill() {},
    async purgeTranscripts() {}
  };
}

function factoryCapturing(neutralDirs: string[]): ChatEngineFactory {
  return () => fakeEngine((opts) => neutralDirs.push(opts.neutralDir));
}

describe("CliStructuredAdapter one-shot cwd", () => {
  it("reuses the identical neutralDir across two calls for the same service", async () => {
    const neutralDirs: string[] = [];
    const adapter = new CliStructuredAdapter("anthropic", factoryCapturing(neutralDirs));

    await adapter.generateStructured(baseInput("module.job-fit"));
    await adapter.generateStructured(baseInput("module.job-fit"));

    expect(neutralDirs).toHaveLength(2);
    expect(neutralDirs[0]).toBe(neutralDirs[1]);
  });

  it("uses a different neutralDir for a different service", async () => {
    const neutralDirs: string[] = [];
    const adapter = new CliStructuredAdapter("anthropic", factoryCapturing(neutralDirs));

    await adapter.generateStructured(baseInput("module.job-fit"));
    await adapter.generateStructured(baseInput("module.other"));

    expect(neutralDirs).toHaveLength(2);
    expect(neutralDirs[0]).not.toBe(neutralDirs[1]);
  });

  it("removes the directory from disk after the call completes", async () => {
    const neutralDirs: string[] = [];
    const adapter = new CliStructuredAdapter("anthropic", factoryCapturing(neutralDirs));

    await adapter.generateStructured(baseInput("module.job-fit-cleanup"));

    expect(neutralDirs).toHaveLength(1);
    expect(existsSync(neutralDirs[0]!)).toBe(false);
  });

  it("rejects a service value that would escape the stable root", async () => {
    const neutralDirs: string[] = [];
    const adapter = new CliStructuredAdapter("anthropic", factoryCapturing(neutralDirs));

    await expect(
      adapter.generateStructured(
        baseInput("module.../../etc" as GenerateStructuredProviderInput["service"])
      )
    ).rejects.toThrow();
    expect(neutralDirs).toHaveLength(0);
  });
});

/** A CliChatEngine stub whose readNew hangs forever the first time (the run loop's own read),
 * then returns a real reply the second time (the rescue read after cancel/timeout). */
function fakeEngineHangThenReply(): CliChatEngine {
  let readNewCalls = 0;
  return {
    provider: "anthropic",
    async launch() {
      return { offset: 0 };
    },
    async submit() {},
    async interrupt() {},
    async readNew() {
      readNewCalls += 1;
      if (readNewCalls === 1) return new Promise(() => undefined);
      return { records: [{ kind: "reply", text: "late answer" }], offset: 1, complete: true };
    },
    async isAlive() {
      return true;
    },
    async kill() {},
    async purgeTranscripts() {}
  };
}

describe("CliStructuredAdapter cancellation (#2276)", () => {
  it("throws away a late answer when the caller cancels externally", async () => {
    const controller = new AbortController();
    let readNewCalls = 0;
    // Abort from inside submit(): by the time the run loop reaches submit(), the adapter has
    // already attached its "abort" listener, so this can't race the listener's own setup.
    const engine: CliChatEngine = {
      provider: "anthropic",
      async launch() {
        return { offset: 0 };
      },
      async submit() {
        controller.abort();
      },
      async interrupt() {},
      async readNew() {
        readNewCalls += 1;
        if (readNewCalls === 1) return new Promise(() => undefined);
        return { records: [{ kind: "reply", text: "late answer" }], offset: 1, complete: true };
      },
      async isAlive() {
        return true;
      },
      async kill() {},
      async purgeTranscripts() {}
    };
    const adapter = new CliStructuredAdapter("anthropic", () => engine);

    await expect(
      adapter.generateStructured({ ...baseInput("module.job-fit"), signal: controller.signal })
    ).rejects.toThrow();
  });

  it("throws away a late answer when the internal timeout fires first", async () => {
    const engine = fakeEngineHangThenReply();
    const adapter = new CliStructuredAdapter("anthropic", () => engine, 20);

    await expect(adapter.generateStructured(baseInput("module.job-fit"))).rejects.toThrow();
  });

  it("still rescues a reply after a real crash unrelated to cancellation", async () => {
    let readNewCalls = 0;
    const engine: CliChatEngine = {
      provider: "anthropic",
      async launch() {
        return { offset: 0 };
      },
      async submit() {},
      async interrupt() {},
      async readNew() {
        readNewCalls += 1;
        if (readNewCalls === 1) {
          return { records: [{ kind: "status", text: "thinking" }], offset: 1, complete: false };
        }
        return { records: [{ kind: "reply", text: "{}" }], offset: 2, complete: true };
      },
      async isAlive() {
        return readNewCalls < 1;
      },
      async kill() {},
      async purgeTranscripts() {}
    };
    const adapter = new CliStructuredAdapter("anthropic", () => engine);

    const result = await adapter.generateStructured(baseInput("module.job-fit"));

    expect(result).toMatchObject({ rawText: "{}" });
  });

  it("discards a late answer from the scoped path when it lands the same instant as a cancel (#2276)", async () => {
    // A real race against the internal timer would be flaky by nature (it depends on exact
    // event-loop timing), so this drives the same code path deterministically: the fake reply
    // triggers the cancel itself, then hands back a complete, valid answer in the same call,
    // before returning control. That reproduces "the answer lands the same instant the cancel
    // fires" without relying on chance. The guard under test reads the same aborted flag that
    // both the internal timeout and an external cancel set, so proving it here proves both.
    const controller = new AbortController();
    let readCalls = 0;
    const engine = {
      provider: "anthropic",
      async launch() {
        return { offset: 0 };
      },
      async submit() {},
      async interrupt() {},
      async readNew() {
        return { records: [], offset: 0, complete: false };
      },
      async isAlive() {
        return true;
      },
      async kill() {},
      async purgeTranscripts() {},
      async launchStructured() {
        return { offset: 0 };
      },
      async submitStructured() {},
      async readStructured() {
        readCalls += 1;
        if (readCalls === 1) {
          controller.abort();
          return { text: "late answer", offset: 1, complete: true };
        }
        return new Promise(() => undefined);
      }
    } as unknown as CliChatEngine;
    const adapter = new CliStructuredAdapter("anthropic", () => engine, 20);

    await expect(
      adapter.generateStructured({
        ...baseInput("module.job-fit"),
        signal: controller.signal,
        scope: { actorUserId: "user-1", connectorAccountId: "conn-1", lineageId: "lineage-1" }
      })
    ).rejects.toThrow();
  });
});

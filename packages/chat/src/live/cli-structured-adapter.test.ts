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

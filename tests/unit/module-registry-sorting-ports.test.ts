import { describe, expect, it, vi } from "vitest";

import type { DataContextDb } from "@moss/db";
import type * as AiModule from "@moss/ai";

const captured = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));

vi.mock("@moss/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof AiModule>();
  return {
    ...actual,
    createAiSecretCipher: () => ({ decryptJson: vi.fn() }),
    generateStructured: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
      captured.calls.push(input);
      return {
        ok: true,
        object: {},
        usage: { inputTokens: 0, outputTokens: 0 },
        servedBy: "sorting"
      };
    })
  };
});

import {
  buildNewsDiscoveryPorts,
  buildSportsDiscoveryPorts
} from "../../packages/module-registry/src/index.js";

const scopedDb = {} as DataContextDb;
const schema = { type: "object" };

describe("story matcher ports pass the sorting opt-in through (#2594)", () => {
  it.each([
    ["module.news", () => buildNewsDiscoveryPorts()],
    ["module.sports", () => buildSportsDiscoveryPorts()]
  ] as const)("%s forwards sorting, signal, schema and prompt", async (service, build) => {
    captured.calls.length = 0;
    const controller = new AbortController();
    const result = await build().ai.generateJson(scopedDb, {
      schema,
      prompt: "match these",
      maxOutputTokens: 4000,
      sorting: true,
      signal: controller.signal
    });
    expect(result).toMatchObject({ ok: true, servedBy: "sorting" });
    expect(captured.calls).toEqual([
      {
        service,
        schema,
        prompt: "match these",
        maxOutputTokens: 4000,
        sorting: true,
        signal: controller.signal
      }
    ]);
  });
});

describe("external module requests cannot opt in (#2594 slice 4 owns that)", () => {
  it("the worker RPC request allow-list does not admit sorting", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        new URL("../../packages/module-registry/src/external/worker-rpc-host.ts", import.meta.url),
        "utf8"
      )
    );
    // Anchor on the prompt/schema allow-list: it is the Set whose list contains "schema". A bare
    // /const allowed = new Set\(\[.../ matches the URL-fetch list first and never names "prompt".
    const allowList =
      /const allowed = new Set\(\[([^\]]*"schema"[^\]]*)\]\)/.exec(source)?.[1] ?? "";
    expect(allowList).toContain('"prompt"');
    expect(allowList).not.toContain("sorting");
  });
});

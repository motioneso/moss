import { describe, expect, it, vi } from "vitest";

import { dataContextBrand, type DataContextDb } from "@moss/db";
import { WEB_NATIVE_SEARCH_ENABLED_SETTING } from "@moss/settings";
import type * as MossAi from "@moss/ai";

const selectChatModelForUser = vi.fn();

vi.mock("@moss/ai", async () => {
  const actual = await vi.importActual<typeof MossAi>("@moss/ai");
  return {
    ...actual,
    AiRepository: vi.fn().mockImplementation(function (this: { selectChatModelForUser: unknown }) {
      this.selectChatModelForUser = selectChatModelForUser;
    })
  };
});

const { resolveNewsWebSearch } = await import("../../packages/module-registry/src/index.js");

function createMockDb(settings: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(settings));
  return {
    [dataContextBrand]: true,
    db: {
      selectFrom: (_table: string) => ({
        select: (_cols: unknown) => ({
          where: (_col: string, _op: string, val: string) => ({
            executeTakeFirst: async () => {
              if (store.has(val)) return { value: { value: store.get(val) } };
              return undefined;
            }
          })
        })
      })
    }
  } as unknown as DataContextDb;
}

describe("News web search availability (#2228)", () => {
  it("reports search available for an actor whose effective chat model has native web search", async () => {
    selectChatModelForUser.mockResolvedValueOnce({
      id: "model-1",
      capabilities: ["chat", "tool-use", "web-search"]
    });
    const scopedDb = createMockDb();

    const resolution = await resolveNewsWebSearch(scopedDb);

    expect(resolution).toEqual({
      engine: "model-native",
      model: { id: "model-1", capabilities: ["chat", "tool-use", "web-search"] }
    });
  });

  it("reports model-has-no-search when the actor's chat model has no web-search capability", async () => {
    selectChatModelForUser.mockResolvedValueOnce({
      id: "model-2",
      capabilities: ["chat", "tool-use"]
    });
    const scopedDb = createMockDb();

    const resolution = await resolveNewsWebSearch(scopedDb);

    expect(resolution).toEqual({ engine: "none", reason: "model-has-no-search" });
  });

  it("reports no-key-no-native-model when the actor has no effective chat model", async () => {
    selectChatModelForUser.mockResolvedValueOnce(null);
    const scopedDb = createMockDb();

    const resolution = await resolveNewsWebSearch(scopedDb);

    expect(resolution).toEqual({ engine: "none", reason: "no-key-no-native-model" });
  });

  it("reports native-disabled when the instance switch is off, even for a search-capable model", async () => {
    selectChatModelForUser.mockResolvedValueOnce({
      id: "model-1",
      capabilities: ["chat", "tool-use", "web-search"]
    });
    const scopedDb = createMockDb({ [WEB_NATIVE_SEARCH_ENABLED_SETTING]: false });

    const resolution = await resolveNewsWebSearch(scopedDb);

    expect(resolution).toEqual({ engine: "none", reason: "native-disabled" });
  });
});

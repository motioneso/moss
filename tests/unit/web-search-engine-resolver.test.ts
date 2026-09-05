import { describe, expect, it } from "vitest";
import { dataContextBrand, type DataContextDb } from "@moss/db";
import {
  readNativeSearchEnabled,
  resolveWebSearchEngine,
  setNativeSearchEnabled,
  WEB_NATIVE_SEARCH_ENABLED_SETTING,
  WEB_SEARCH_API_KEY_SETTING,
  type WebSearchActorChatModel
} from "@moss/settings";

function createMockDb(settings: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(settings));
  const scopedDb = {
    [dataContextBrand]: true,
    db: {
      selectFrom: (table: string) => ({
        select: (_cols: unknown) => ({
          where: (_col: string, _op: string, val: string) => ({
            executeTakeFirst: async () => {
              if (store.has(val)) {
                return { value: { value: store.get(val) } };
              }
              return undefined;
            }
          })
        })
      })
    }
  } as unknown as DataContextDb;
  return { scopedDb, store };
}

describe("resolveWebSearchEngine", () => {
  const searchCapableModel: WebSearchActorChatModel = {
    id: "model-1",
    providerModelId: "claude-3-5-sonnet-20241022",
    capabilities: ["chat", "tool-use", "web-search"]
  };

  const basicModel: WebSearchActorChatModel = {
    id: "model-2",
    providerModelId: "claude-3-opus-20240229",
    capabilities: ["chat", "tool-use"]
  };

  it("returns brave when instance Brave key is present, regardless of model capability", async () => {
    const { scopedDb } = createMockDb({
      [WEB_SEARCH_API_KEY_SETTING]: { ciphertext: "abc", iv: "def", tag: "ghi" }
    });

    const withCapable = await resolveWebSearchEngine(scopedDb, searchCapableModel, {});
    expect(withCapable).toEqual({ engine: "brave" });

    const withBasic = await resolveWebSearchEngine(scopedDb, basicModel, {});
    expect(withBasic).toEqual({ engine: "brave" });

    const withNull = await resolveWebSearchEngine(scopedDb, null, {});
    expect(withNull).toEqual({ engine: "brave" });
  });

  it("returns brave when Brave key is set via env variable", async () => {
    const { scopedDb } = createMockDb();
    const env = { JARVIS_BRAVE_SEARCH_API_KEY: "test-env-brave-key" };

    const result = await resolveWebSearchEngine(scopedDb, basicModel, env);
    expect(result).toEqual({ engine: "brave" });
  });

  it("returns native-disabled when switch is off and no Brave key is present", async () => {
    const { scopedDb } = createMockDb({
      [WEB_NATIVE_SEARCH_ENABLED_SETTING]: false
    });

    const result = await resolveWebSearchEngine(scopedDb, searchCapableModel, {});
    expect(result).toEqual({ engine: "none", reason: "native-disabled" });
  });

  it("returns model-native when switch is on (default) and model has web-search capability", async () => {
    const { scopedDb } = createMockDb();

    const result = await resolveWebSearchEngine(scopedDb, searchCapableModel, {});
    expect(result).toEqual({
      engine: "model-native",
      model: searchCapableModel
    });
  });

  it("returns model-has-no-search when switch is on and model lacks web-search capability", async () => {
    const { scopedDb } = createMockDb();

    const result = await resolveWebSearchEngine(scopedDb, basicModel, {});
    expect(result).toEqual({
      engine: "none",
      reason: "model-has-no-search"
    });
  });

  it("returns no-key-no-native-model when switch is on but no model is configured", async () => {
    const { scopedDb } = createMockDb();

    const result = await resolveWebSearchEngine(scopedDb, null, {});
    expect(result).toEqual({
      engine: "none",
      reason: "no-key-no-native-model"
    });
  });

  it("reads nativeSearchEnabled correctly with true default", async () => {
    const { scopedDb: defaultDb } = createMockDb();
    expect(await readNativeSearchEnabled(defaultDb)).toBe(true);

    const { scopedDb: disabledDb } = createMockDb({
      [WEB_NATIVE_SEARCH_ENABLED_SETTING]: false
    });
    expect(await readNativeSearchEnabled(disabledDb)).toBe(false);

    const { scopedDb: enabledDb } = createMockDb({
      [WEB_NATIVE_SEARCH_ENABLED_SETTING]: true
    });
    expect(await readNativeSearchEnabled(enabledDb)).toBe(true);
  });

  it("persists nativeSearchEnabled through repository", async () => {
    const { scopedDb } = createMockDb();
    let upserted: unknown = null;
    const fakeRepo = {
      upsertInstanceSetting: async (_db: unknown, input: unknown) => {
        upserted = input;
        return input;
      }
    };

    await setNativeSearchEnabled(scopedDb, fakeRepo as never, {
      enabled: false,
      actorUserId: "user-1",
      requestId: "req-1"
    });

    expect(upserted).toEqual({
      key: WEB_NATIVE_SEARCH_ENABLED_SETTING,
      value: { value: false },
      updatedByUserId: "user-1",
      requestId: "req-1",
      action: "instance_setting.native_search_enabled.set",
      metadata: { key: WEB_NATIVE_SEARCH_ENABLED_SETTING }
    });
  });
});

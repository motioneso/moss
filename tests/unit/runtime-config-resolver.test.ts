import { describe, expect, it } from "vitest";

import { dataContextBrand, type DataContextDb } from "../../packages/db/src/index.js";
import {
  BRAVE_API_KEY_CONFIG_KEY,
  CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY,
  CHAT_PERSISTENT_POOL_CAP_CONFIG_KEY,
  EMBED_MODEL_CONFIG_KEY,
  EMBED_PROVIDER_CONFIG_KEY
} from "../../packages/settings/src/runtime-config-keys.js";
import { RuntimeConfigResolver } from "../../packages/settings/src/runtime-config-resolver.js";

function scopedDbWithSetting(value: unknown): DataContextDb {
  const row = value === undefined ? undefined : { value };
  return {
    [dataContextBrand]: true,
    db: {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            executeTakeFirst: async () => row
          })
        })
      })
    }
  } as unknown as DataContextDb;
}

describe("RuntimeConfigResolver", () => {
  it("resolves instance values before env and defaults", async () => {
    const resolver = new RuntimeConfigResolver(scopedDbWithSetting({ value: "stub" }), {
      JARVIS_EMBED_PROVIDER: "local"
    });

    await expect(resolver.resolveEnum(EMBED_PROVIDER_CONFIG_KEY)).resolves.toBe("stub");
    await expect(resolver.getStatus(EMBED_PROVIDER_CONFIG_KEY)).resolves.toEqual({
      value: "stub",
      source: "instance"
    });
  });

  it("falls back to env and then declared default", async () => {
    const envResolver = new RuntimeConfigResolver(scopedDbWithSetting(undefined), {
      JARVIS_EMBED_MODEL: "bge-small"
    });
    const defaultResolver = new RuntimeConfigResolver(scopedDbWithSetting(undefined), {});

    await expect(envResolver.resolveString(EMBED_MODEL_CONFIG_KEY)).resolves.toBe("bge-small");
    await expect(envResolver.getStatus(EMBED_MODEL_CONFIG_KEY)).resolves.toEqual({
      value: "bge-small",
      source: "env"
    });
    await expect(defaultResolver.resolveString(EMBED_MODEL_CONFIG_KEY)).resolves.toBe("");
    await expect(defaultResolver.getStatus(EMBED_MODEL_CONFIG_KEY)).resolves.toEqual({
      value: "",
      source: "default"
    });
  });

  it("rejects invalid enum values at the resolver boundary", async () => {
    const resolver = new RuntimeConfigResolver(scopedDbWithSetting({ value: "stb" }), {});

    await expect(resolver.resolveEnum(EMBED_PROVIDER_CONFIG_KEY)).rejects.toThrow(
      'Invalid runtime config "ai.embed_provider" value "stb"'
    );
  });

  it("redacts secret values in getStatus response", async () => {
    const resolver = new RuntimeConfigResolver(
      scopedDbWithSetting({ value: "BSA-secret-key-123" }),
      {}
    );

    const status = await resolver.getStatus(BRAVE_API_KEY_CONFIG_KEY);
    expect(status.value).toBeNull();
    expect(status.source).toBe("instance");
  });

  it("resolveInt parses an int-typed instance value (#1554)", async () => {
    const resolver = new RuntimeConfigResolver(scopedDbWithSetting({ value: "8" }), {});

    await expect(resolver.resolveInt(CHAT_PERSISTENT_POOL_CAP_CONFIG_KEY)).resolves.toBe(8);
  });

  it("per-actor resolution returns the correct instance's config", async () => {
    const dbA = scopedDbWithSetting({ value: "stub" });
    const dbB = scopedDbWithSetting({ value: "local" });

    const resolverA = new RuntimeConfigResolver(dbA, {});
    const resolverB = new RuntimeConfigResolver(dbB, {});

    await expect(resolverA.resolveEnum(EMBED_PROVIDER_CONFIG_KEY)).resolves.toBe("stub");
    await expect(resolverB.resolveEnum(EMBED_PROVIDER_CONFIG_KEY)).resolves.toBe("local");
  });

  it("resolves the classifier gate to off when no value is stored (#2881)", async () => {
    const resolver = new RuntimeConfigResolver(scopedDbWithSetting(undefined), {});

    await expect(resolver.resolveEnum(CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY)).resolves.toBe("off");
    await expect(resolver.getStatus(CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY)).resolves.toEqual({
      value: "off",
      source: "default"
    });
  });

  it("resolves a stored shadow or on classifier gate value (#2881)", async () => {
    await expect(
      new RuntimeConfigResolver(scopedDbWithSetting({ value: "shadow" }), {}).resolveEnum(
        CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY
      )
    ).resolves.toBe("shadow");
    await expect(
      new RuntimeConfigResolver(scopedDbWithSetting({ value: "on" }), {}).resolveEnum(
        CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY
      )
    ).resolves.toBe("on");
  });

  it("rejects an invalid classifier gate value at the read boundary (#2881)", async () => {
    const resolver = new RuntimeConfigResolver(scopedDbWithSetting({ value: "enabled" }), {});

    await expect(resolver.resolveEnum(CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY)).rejects.toThrow(
      'Invalid runtime config "chat.classifier_gate_mode" value "enabled"'
    );
  });

  // #2881 blocker 2: the environment variable must not turn the gate on with no release record.
  // An env value of "on" fails closed to the off default; other env values still pass through.
  it("fails the classifier gate closed to off when the environment says on (#2881)", async () => {
    const resolver = new RuntimeConfigResolver(scopedDbWithSetting(undefined), {
      MOSS_CHAT_CLASSIFIER_GATE_MODE: "on"
    });

    await expect(resolver.resolveEnum(CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY)).resolves.toBe("off");
    await expect(resolver.getStatus(CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY)).resolves.toEqual({
      value: "off",
      source: "default"
    });
  });

  it("still accepts a shadow environment value for the classifier gate (#2881)", async () => {
    const resolver = new RuntimeConfigResolver(scopedDbWithSetting(undefined), {
      MOSS_CHAT_CLASSIFIER_GATE_MODE: "shadow"
    });

    await expect(resolver.resolveEnum(CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY)).resolves.toBe(
      "shadow"
    );
  });

  // A stored instance value is still authoritative over the environment (unchanged precedence).
  it("lets a stored off override a shadow environment value (#2881)", async () => {
    const resolver = new RuntimeConfigResolver(scopedDbWithSetting({ value: "off" }), {
      MOSS_CHAT_CLASSIFIER_GATE_MODE: "shadow"
    });

    await expect(resolver.resolveEnum(CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY)).resolves.toBe("off");
    await expect(resolver.getStatus(CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY)).resolves.toEqual({
      value: "off",
      source: "instance"
    });
  });
});

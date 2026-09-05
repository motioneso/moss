import { afterEach, describe, expect, it } from "vitest";

import {
  createModelNativeProvider,
  invalidateWebSearchProviderCache,
  resolveWebSearchProvider,
  setModelNativeSearchResolver,
  setWebSearchKeyResolver,
  setWebSearchProviderForTests,
  type ModelNativeSearchRunner,
  type ModelNativeSearchRunnerInput
} from "@moss/web-research";

afterEach(() => {
  setModelNativeSearchResolver(undefined);
  setWebSearchKeyResolver(undefined);
  setWebSearchProviderForTests(undefined);
  invalidateWebSearchProviderCache();
});

describe("createModelNativeProvider", () => {
  it("builds a structured search prompt naming the query, limit, and freshness", async () => {
    let seenInput: ModelNativeSearchRunnerInput | undefined;
    const runner: ModelNativeSearchRunner = async (input) => {
      seenInput = input;
      return { object: { results: [] } };
    };
    const provider = createModelNativeProvider(runner);

    await provider.search({ query: "release notes for widget 4", limit: 3, freshness: "week" });

    expect(seenInput?.prompt).toContain("release notes for widget 4");
    expect(seenInput?.prompt).toContain("up to 3 results");
    expect(seenInput?.prompt).toContain("last week");
    expect(seenInput?.schema).toMatchObject({ type: "object", required: ["results"] });
  });

  it("omits the freshness clause when freshness is absent or any", async () => {
    let seenPrompt = "";
    const runner: ModelNativeSearchRunner = async (input) => {
      seenPrompt = input.prompt;
      return { object: { results: [] } };
    };
    const provider = createModelNativeProvider(runner);

    await provider.search({ query: "widget specs", limit: 5, freshness: "any" });

    expect(seenPrompt).not.toContain("Prefer results published");
  });

  it("parses well-formed results out of the model's structured reply", async () => {
    const runner: ModelNativeSearchRunner = async () => ({
      object: {
        results: [
          {
            title: "Widget 4 release notes",
            url: "https://example.com/widget-4",
            snippet: "New in this release."
          }
        ]
      }
    });
    const provider = createModelNativeProvider(runner);

    const output = await provider.search({ query: "widget 4", limit: 5 });

    expect(output.results).toEqual([
      {
        title: "Widget 4 release notes",
        url: "https://example.com/widget-4",
        snippet: "New in this release."
      }
    ]);
    expect(output.trace).toMatchObject({ provider: "model-native", count: 1 });
  });

  it("drops malformed entries (missing or non-string url) instead of throwing", async () => {
    const runner: ModelNativeSearchRunner = async () => ({
      object: {
        results: [
          { title: "No URL" },
          { title: "Bad URL", url: 42 },
          { title: "Good", url: "https://example.com/good", snippet: "ok" }
        ]
      }
    });
    const provider = createModelNativeProvider(runner);

    const output = await provider.search({ query: "q", limit: 5 });

    expect(output.results).toEqual([
      { title: "Good", url: "https://example.com/good", snippet: "ok" }
    ]);
  });

  it("merges provider-attached citations that were not repeated in the parsed JSON body", async () => {
    const runner: ModelNativeSearchRunner = async () => ({
      object: {
        results: [{ title: "Parsed", url: "https://example.com/parsed", snippet: "from json" }]
      },
      sources: [
        { title: "Cited only", url: "https://example.com/cited" },
        { title: "Parsed", url: "https://example.com/parsed" }
      ]
    });
    const provider = createModelNativeProvider(runner);

    const output = await provider.search({ query: "q", limit: 5 });

    expect(output.results).toEqual([
      { title: "Parsed", url: "https://example.com/parsed", snippet: "from json" },
      { title: "Cited only", url: "https://example.com/cited", snippet: "" }
    ]);
  });

  it("caps merged results at the requested limit", async () => {
    const runner: ModelNativeSearchRunner = async () => ({
      object: {
        results: [
          { title: "A", url: "https://example.com/a", snippet: "" },
          { title: "B", url: "https://example.com/b", snippet: "" },
          { title: "C", url: "https://example.com/c", snippet: "" }
        ]
      }
    });
    const provider = createModelNativeProvider(runner);

    const output = await provider.search({ query: "q", limit: 2 });

    expect(output.results).toHaveLength(2);
  });

  it("returns an empty, unavailable result when the runner reports null", async () => {
    const runner: ModelNativeSearchRunner = async () => null;
    const provider = createModelNativeProvider(runner);

    const output = await provider.search({ query: "q", limit: 5 });

    expect(output.results).toEqual([]);
    expect(output.trace).toMatchObject({ provider: "model-native", unavailable: true });
  });
});

describe("resolveWebSearchProvider with model-native search", () => {
  it("prefers a configured Brave key over model-native search", async () => {
    setWebSearchKeyResolver(async () => "brave-key");
    setModelNativeSearchResolver(async () => ({
      modelId: "model-a",
      runner: async () => ({ object: { results: [] } })
    }));

    const provider = await resolveWebSearchProvider({});

    expect(provider.name).toBe("brave");
  });

  it("falls back to model-native search when no Brave key is configured", async () => {
    setWebSearchKeyResolver(async () => null);
    setModelNativeSearchResolver(async () => ({
      modelId: "model-a",
      runner: async () => ({ object: { results: [] } })
    }));

    const provider = await resolveWebSearchProvider({});

    expect(provider.name).toBe("model-native");
  });

  it("is unavailable when neither Brave nor model-native search is active", async () => {
    setWebSearchKeyResolver(async () => null);
    setModelNativeSearchResolver(async () => null);

    const provider = await resolveWebSearchProvider({});

    expect(provider.name).toBe("unavailable");
  });

  it("never reuses one actor's runner for another actor on the same model", async () => {
    setWebSearchKeyResolver(async () => null);
    const runnerCalls: string[] = [];
    // The composition root binds the runner to the request's scoped data context; here the
    // "scoped db" is just a label naming the actor so the test can see whose runner ran.
    setModelNativeSearchResolver(async (scopedDb) => ({
      modelId: "shared-model",
      runner: async () => {
        runnerCalls.push(String(scopedDb));
        return { object: { results: [] } };
      }
    }));

    const forUserA = await resolveWebSearchProvider("user-a");
    await forUserA.search({ query: "q", limit: 1 });
    const forUserB = await resolveWebSearchProvider("user-b");
    await forUserB.search({ query: "q", limit: 1 });

    expect(runnerCalls).toEqual(["user-a", "user-b"]);
  });
});

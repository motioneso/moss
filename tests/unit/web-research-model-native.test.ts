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
    expect(seenInput?.prompt).toContain("Copy each url exactly as your search tool returned it");
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

  // #2228 fix round 1, finding 6: the provider's citations are the ground truth for urls. A link
  // that appears only in the model's JSON body was never verified by a search hit, so it is
  // dropped; a cited link is kept even when the JSON body omits it.
  it("keeps cited results in citation order, enriched with the JSON body's title and snippet", async () => {
    const runner: ModelNativeSearchRunner = async () => ({
      object: {
        results: [
          {
            title: "Widget 4 release notes",
            url: "https://example.com/widget-4",
            snippet: "New in this release."
          },
          { title: "Widget 4 roadmap", url: "https://example.com/roadmap", snippet: "Next up." }
        ]
      },
      sources: [
        { title: "roadmap", url: "https://example.com/roadmap" },
        { title: "widget-4", url: "https://example.com/widget-4" }
      ]
    });
    const provider = createModelNativeProvider(runner);

    const output = await provider.search({ query: "widget 4", limit: 5 });

    expect(output.results).toEqual([
      { title: "Widget 4 roadmap", url: "https://example.com/roadmap", snippet: "Next up." },
      {
        title: "Widget 4 release notes",
        url: "https://example.com/widget-4",
        snippet: "New in this release."
      }
    ]);
    expect(output.trace).toMatchObject({ provider: "model-native", count: 2, cited: 2 });
  });

  it("drops links the model wrote into the JSON body without citing them", async () => {
    const runner: ModelNativeSearchRunner = async () => ({
      object: {
        results: [
          { title: "Invented", url: "https://example.com/invented", snippet: "not a hit" },
          { title: "Real", url: "https://example.com/real", snippet: "from json" }
        ]
      },
      sources: [{ title: "Real", url: "https://example.com/real" }]
    });
    const provider = createModelNativeProvider(runner);

    const output = await provider.search({ query: "q", limit: 5 });

    expect(output.results).toEqual([
      { title: "Real", url: "https://example.com/real", snippet: "from json" }
    ]);
  });

  it("returns nothing when the model returned links but the provider cited none", async () => {
    const runner: ModelNativeSearchRunner = async () => ({
      object: {
        results: [{ title: "Unverified", url: "https://example.com/unverified", snippet: "" }]
      }
    });
    const provider = createModelNativeProvider(runner);

    const output = await provider.search({ query: "q", limit: 5 });

    expect(output.results).toEqual([]);
    expect(output.trace).toMatchObject({ provider: "model-native", count: 0, cited: 0 });
  });

  it("keeps a cited link the JSON body omitted, with the citation title and an empty snippet", async () => {
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
      { title: "Cited only", url: "https://example.com/cited", snippet: "" },
      { title: "Parsed", url: "https://example.com/parsed", snippet: "from json" }
    ]);
  });

  it("ignores malformed JSON entries and duplicate citations without throwing", async () => {
    const runner: ModelNativeSearchRunner = async () => ({
      object: {
        results: [
          { title: "No URL" },
          { title: "Bad URL", url: 42 },
          { title: "Good", url: "https://example.com/good", snippet: "ok" }
        ]
      },
      sources: [
        { title: "Good", url: "https://example.com/good" },
        { title: "Good again", url: "https://example.com/good" },
        { title: "", url: "" }
      ]
    });
    const provider = createModelNativeProvider(runner);

    const output = await provider.search({ query: "q", limit: 5 });

    expect(output.results).toEqual([
      { title: "Good", url: "https://example.com/good", snippet: "ok" }
    ]);
  });

  // #2280 live proof: the model rewrote urls in its JSON body, so none matched a citation by
  // exact string and every result reached the chat model with an empty snippet. Matching now
  // ignores scheme, host case, trailing slash, fragment and utm params; the cited url is kept.
  it("matches a described url to its citation after normalising, keeping the cited url", async () => {
    const runner: ModelNativeSearchRunner = async () => ({
      object: {
        results: [
          { title: "BBC front page", url: "http://WWW.BBC.CO.UK/news#top", snippet: "Top story" },
          { title: "Example story", url: "https://example.com/story?id=7", snippet: "Details" }
        ]
      },
      sources: [
        { title: "BBC", url: "https://www.bbc.co.uk/news/" },
        { title: "Example", url: "http://Example.com/story?utm_source=x&id=7&utm_medium=y#frag" }
      ]
    });
    const provider = createModelNativeProvider(runner);

    const output = await provider.search({ query: "q", limit: 5 });

    expect(output.results).toEqual([
      { title: "BBC front page", url: "https://www.bbc.co.uk/news/", snippet: "Top story" },
      {
        title: "Example story",
        url: "http://Example.com/story?utm_source=x&id=7&utm_medium=y#frag",
        snippet: "Details"
      }
    ]);
    expect(output.trace).toMatchObject({ provider: "model-native", count: 2, undescribed: 0 });
  });

  it("keeps citations that differ only by trailing slash or scheme", async () => {
    const runner: ModelNativeSearchRunner = async () => ({
      object: { results: [] },
      sources: [
        { title: "One", url: "https://example.com/a/" },
        { title: "One again", url: "http://example.com/a" },
        { title: "One repeated", url: "https://example.com/a/" }
      ]
    });
    const provider = createModelNativeProvider(runner);

    const output = await provider.search({ query: "q", limit: 5 });

    expect(output.results.map((result) => result.url)).toEqual([
      "https://example.com/a/",
      "http://example.com/a"
    ]);
    expect(output.trace).toMatchObject({ count: 2, cited: 2, undescribed: 2 });
  });

  it.each([
    ["fragment routes", "https://example.com/#/one", "https://example.com/#/two"],
    ["scheme", "http://example.com/a", "https://example.com/a"],
    ["trailing slash", "https://example.com/a", "https://example.com/a/"],
    ["different hosts", "https://one.example.com/a", "https://two.example.com/a"],
    ["path case", "https://example.com/A", "https://example.com/a"],
    ["query values", "https://example.com/a?id=1", "https://example.com/a?id=2"],
    ["query case", "https://example.com/a?id=A", "https://example.com/a?id=a"]
  ])(
    "keeps separate pages with their own descriptions in citation order: %s",
    async (_name, first, second) => {
      const runner: ModelNativeSearchRunner = async () => ({
        object: {
          results: [
            { title: "First page", url: first, snippet: "First description" },
            { title: "Second page", url: second, snippet: "Second description" }
          ]
        },
        sources: [
          { title: "Second citation", url: second },
          { title: "First citation", url: first }
        ]
      });
      const provider = createModelNativeProvider(runner);

      const output = await provider.search({ query: "q", limit: 5 });

      expect(output.results).toEqual([
        { title: "Second page", url: second, snippet: "Second description" },
        { title: "First page", url: first, snippet: "First description" }
      ]);
      expect(output.trace).toMatchObject({ count: 2, cited: 2, undescribed: 0 });
    }
  );

  it("leaves a citation undescribed when several descriptions share its normalised url", async () => {
    const runner: ModelNativeSearchRunner = async () => ({
      object: {
        results: [
          { title: "Route one", url: "https://example.com/#/one", snippet: "One" },
          { title: "Route two", url: "https://example.com/#/two", snippet: "Two" }
        ]
      },
      sources: [{ title: "Example home", url: "https://example.com/" }]
    });
    const provider = createModelNativeProvider(runner);

    const output = await provider.search({ query: "q", limit: 5 });

    expect(output.results).toEqual([
      { title: "Example home", url: "https://example.com/", snippet: "" }
    ]);
    expect(output.trace).toMatchObject({ count: 1, cited: 1, undescribed: 1 });
  });

  it("does not lend a description that exactly matches one citation to another", async () => {
    const runner: ModelNativeSearchRunner = async () => ({
      object: {
        results: [{ title: "Route one", url: "https://example.com/#/one", snippet: "One" }]
      },
      sources: [
        { title: "Two", url: "https://example.com/#/two" },
        { title: "One", url: "https://example.com/#/one" }
      ]
    });
    const provider = createModelNativeProvider(runner);

    const output = await provider.search({ query: "q", limit: 5 });

    expect(output.results).toEqual([
      { title: "Two", url: "https://example.com/#/two", snippet: "" },
      { title: "Route one", url: "https://example.com/#/one", snippet: "One" }
    ]);
    expect(output.trace).toMatchObject({ count: 2, cited: 2, undescribed: 1 });
  });

  it("counts cited urls the JSON body never described in the trace", async () => {
    const runner: ModelNativeSearchRunner = async () => ({
      object: {
        results: [{ title: "Described", url: "https://example.com/one", snippet: "yes" }]
      },
      sources: [
        { title: "One", url: "https://example.com/one" },
        { title: "Two", url: "https://example.com/two" },
        { title: "Three", url: "https://example.com/three" }
      ]
    });
    const provider = createModelNativeProvider(runner);

    const output = await provider.search({ query: "q", limit: 5 });

    expect(output.results).toHaveLength(3);
    expect(output.results[1]?.snippet).toBe("");
    expect(output.trace).toMatchObject({ count: 3, cited: 3, undescribed: 2 });
  });

  it("caps cited results at the requested limit", async () => {
    const runner: ModelNativeSearchRunner = async () => ({
      object: { results: [] },
      sources: [
        { title: "A", url: "https://example.com/a" },
        { title: "B", url: "https://example.com/b" },
        { title: "C", url: "https://example.com/c" }
      ]
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

  it.each([false, true])(
    "does not guess between two cited fragment pages competing for one description, reversed=%s",
    async (reversed) => {
      const sources = [
        { title: "Route one", url: "https://example.com/#/one" },
        { title: "Route two", url: "https://example.com/#/two" }
      ];
      if (reversed) sources.reverse();
      const runner: ModelNativeSearchRunner = async () => ({
        object: {
          results: [
            {
              title: "Rewritten page",
              url: "https://example.com/",
              snippet: "Only one page was described"
            }
          ]
        },
        sources
      });
      const provider = createModelNativeProvider(runner);

      const output = await provider.search({ query: "q", limit: 5 });

      expect(output.results).toEqual(sources.map((source) => ({ ...source, snippet: "" })));
      expect(output.trace).toMatchObject({ count: 2, cited: 2, undescribed: 2 });
    }
  );
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

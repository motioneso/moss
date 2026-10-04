import { describe, expect, it } from "vitest";

import { withModelActivityRecording, type ModelActivityEntry } from "@moss/ai";

function collect() {
  const seen: ModelActivityEntry[] = [];
  return { seen, recorder: (entry: ModelActivityEntry) => seen.push(entry) };
}

describe("withModelActivityRecording usage", () => {
  it("attaches token usage reported by the result", async () => {
    const { seen, recorder } = collect();
    const value = await withModelActivityRecording(
      recorder,
      { kind: "structured", action: "sort", modelName: "test-model" },
      async () => ({ text: "{}", usage: { inputTokens: 10, outputTokens: 5 } }),
      { usageOf: (result) => result.usage }
    );
    expect(value.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ inputTokens: 10, outputTokens: 5, outcome: "ok" });
  });

  it("records without usage when no extractor is given", async () => {
    const { seen, recorder } = collect();
    await withModelActivityRecording(
      recorder,
      { kind: "chat", action: "chat", modelName: "test-model" },
      async () => "hello"
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty("inputTokens");
    expect(seen[0]).not.toHaveProperty("outputTokens");
  });

  it("records without usage when the extractor returns nothing", async () => {
    const { seen, recorder } = collect();
    await withModelActivityRecording(
      recorder,
      { kind: "structured", action: "sort", modelName: "test-model" },
      async () => ({ text: "{}" }),
      { usageOf: () => undefined }
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty("inputTokens");
  });

  it("still records duration and failure code on error", async () => {
    const { seen, recorder } = collect();
    await expect(
      withModelActivityRecording(
        recorder,
        { kind: "structured", action: "sort", modelName: "test-model" },
        async (): Promise<string> => {
          throw new Error("boom");
        },
        { usageOf: () => ({ inputTokens: 1, outputTokens: 1 }) }
      )
    ).rejects.toThrow("boom");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ outcome: "error", failureCode: "unknown" });
    expect(seen[0]).not.toHaveProperty("inputTokens");
    expect(typeof seen[0]?.durationMs).toBe("number");
  });
});

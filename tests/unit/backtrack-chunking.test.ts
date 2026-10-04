import { describe, expect, it } from "vitest";

import {
  CHUNK_TOKEN_BUDGET,
  estimateTokens,
  splitSegmentText
} from "../../packages/backtrack/src/chunking.js";

// The embedder reads 512 tokens and silently drops the rest, so a chunk that outgrows its budget
// is lost data (#2638 plan Q6). These pin the splitter, not the model.

describe("splitSegmentText", () => {
  it("keeps a short segment in one chunk, title and address first", () => {
    const chunks = splitSegmentText("A page", "https://example.test/a", "hello world");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe("A page\nhttps://example.test/a\nhello world");
  });

  it("returns nothing for an all-empty segment and skips an absent address", () => {
    expect(splitSegmentText("", null, "   ")).toEqual([]);
    expect(splitSegmentText("T", null, "b")[0]?.text).toBe("T\nb");
  });

  it("splits an 8 KB body so every chunk fits the budget and no word is lost", () => {
    const words = Array.from({ length: 1400 }, (_, i) => `word${i}`);
    const body = words.join(" ").slice(0, 8192);
    const chunks = splitSegmentText("Title", "https://example.test", body);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks)
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(CHUNK_TOKEN_BUDGET);
    const joined = chunks.map((chunk) => chunk.text).join(" ");
    for (const word of body.split(" ").slice(0, -1)) expect(joined).toContain(word);
  });

  it("cuts a single over-long line, with no break to split on, to fit", () => {
    const blob = "a1b2c3d4".repeat(1000);
    const chunks = splitSegmentText("", null, blob);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks)
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(CHUNK_TOKEN_BUDGET);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(blob);
  });

  it("budgets text that costs a token per character (CJK) far tighter than prose", () => {
    const cjk = "日本語のテキスト".repeat(500);
    const chunks = splitSegmentText("", null, cjk);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_TOKEN_BUDGET);
    }
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(cjk);
  });

  it("counts a one-letter word as a whole token (the tokenizer makes 621 of 615 of them)", () => {
    const body = "a ".repeat(615);
    expect(estimateTokens(body)).toBe(615);
    const chunks = splitSegmentText("", null, body);
    expect(chunks.length).toBe(2);
    for (const chunk of chunks)
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(CHUNK_TOKEN_BUDGET);
  });

  it("weighs a character by the code points it decomposes into", () => {
    expect(estimateTokens("한국어")).toBe(8); // jamo after NFD; the tokenizer makes 8 tokens
    expect(estimateTokens("İ")).toBe(2); // lowercases to i plus a combining dot
    expect(estimateTokens(" \n\t")).toBe(0);
  });

  it("never splits a surrogate pair", () => {
    const emoji = "😀".repeat(1200);
    const chunks = splitSegmentText("", null, emoji);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(emoji);
  });

  it("does not treat a leading --- or ## as structure", () => {
    const chunks = splitSegmentText("", null, "---\nnot: frontmatter\n---\n## not a heading");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text.startsWith("---")).toBe(true);
  });
});

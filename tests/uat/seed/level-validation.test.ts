import { describe, expect, it } from "vitest";
import {
  parseUatChatScript,
  parseUatExcludeChunks,
  parseUatSeedLevel
} from "./level-validation.js";

// #1087 finding 5: prove the parsers fail closed on typo'd env values instead
// of silently falling through to a default that seeds max data (exit 0).
describe("parseUatSeedLevel", () => {
  it("accepts each known level unchanged", () => {
    for (const level of ["bare", "solo-admin", "admin+data", "multi-user"]) {
      expect(parseUatSeedLevel(level)).toBe(level);
    }
  });

  it("fails closed on an unknown level instead of falling through", () => {
    expect(() => parseUatSeedLevel("solo_admin")).toThrow(/unknown UAT seed level "solo_admin"/);
  });
});

describe("parseUatExcludeChunks", () => {
  it("returns an empty array for an empty string", () => {
    expect(parseUatExcludeChunks("")).toEqual([]);
  });

  it("parses a comma-separated list of known chunk names", () => {
    expect(parseUatExcludeChunks("news, finance")).toEqual(["news", "finance"]);
  });

  it("fails closed on a typo'd chunk name instead of silently no-op'ing", () => {
    expect(() => parseUatExcludeChunks("news,jobsearch")).toThrow(
      /unknown UAT seed excludeChunks entry "jobsearch"/
    );
  });
});

describe("parseUatChatScript", () => {
  it("returns undefined for an empty string", () => {
    expect(parseUatChatScript("")).toBeUndefined();
  });

  it("passes through a known chat script id", () => {
    expect(parseUatChatScript("phase1-smoke")).toBe("phase1-smoke");
  });

  it("fails closed on an unknown chat script id", () => {
    expect(() => parseUatChatScript("bogus-script")).toThrow(
      /unknown UAT chat script "bogus-script"/
    );
  });
});

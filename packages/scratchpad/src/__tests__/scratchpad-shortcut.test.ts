import { describe, expect, it } from "vitest";
import { isValidShortcut, parseShortcut } from "@moss/shared";

// #2236 slice 1: the shortcut validator is a pure function shared between the API route and (in
// a later slice) the web app, so it's tested here without touching a database or the network.

describe("parseShortcut", () => {
  it("parses a modifier plus a key", () => {
    expect(parseShortcut("mod+shift+s")).toEqual({ modifiers: ["mod", "shift"], key: "s" });
  });

  it("lowercases and trims each token", () => {
    expect(parseShortcut(" Mod + S ")).toEqual({ modifiers: ["mod"], key: "s" });
  });

  it("rejects an empty string", () => {
    expect(parseShortcut("")).toBeNull();
    expect(parseShortcut("   ")).toBeNull();
  });

  it("rejects a key with no modifier", () => {
    expect(parseShortcut("s")).toBeNull();
  });

  it("rejects an unrecognized modifier token", () => {
    expect(parseShortcut("banana+s")).toBeNull();
  });

  it("accepts multiple modifiers", () => {
    expect(parseShortcut("mod+alt+shift+s")).toEqual({
      modifiers: ["mod", "alt", "shift"],
      key: "s"
    });
  });
});

describe("isValidShortcut", () => {
  it("accepts the default shortcut", () => {
    expect(isValidShortcut("mod+shift+s")).toBe(true);
  });

  it("rejects a shortcut with no modifier", () => {
    expect(isValidShortcut("s")).toBe(false);
  });

  it("rejects the reserved command palette shortcut", () => {
    expect(isValidShortcut("mod+k")).toBe(false);
  });

  it("rejects garbage input", () => {
    expect(isValidShortcut("not a shortcut")).toBe(false);
    expect(isValidShortcut("++")).toBe(false);
  });

  it("treats the reserved shortcut check as case and spacing insensitive", () => {
    expect(isValidShortcut(" Mod + K ")).toBe(false);
  });

  it("rejects ctrl+k, cmd+k and meta+k too - they are the same reserved shortcut as mod+k", () => {
    expect(isValidShortcut("ctrl+k")).toBe(false);
    expect(isValidShortcut("cmd+k")).toBe(false);
    expect(isValidShortcut("meta+k")).toBe(false);
  });

  it("rejects a shortcut whose only modifier is shift", () => {
    expect(isValidShortcut("shift+s")).toBe(false);
  });

  it("accepts shift alongside a real modifier", () => {
    expect(isValidShortcut("mod+shift+s")).toBe(true);
  });
});

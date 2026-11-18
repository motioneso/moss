import test from "node:test";
import assert from "node:assert/strict";
import { audioOptions, checkVocabulary, languageOptions, normalizeVocabulary, savedMode } from "./settings-logic.mjs";

test("vocabulary trims, drops blanks and duplicates", () => {
  assert.deepEqual(normalizeVocabulary(" Moss \n\nMoss\nAcme"), ["Moss", "Acme"]);
});
test("vocabulary limits", () => {
  assert.throws(() => normalizeVocabulary(Array.from({ length: 21 }, (_, i) => `t${i}`).join("\n")), /at most 20/);
  assert.throws(() => normalizeVocabulary("x".repeat(201)), /200 UTF-8 bytes/);
  assert.throws(() => normalizeVocabulary("a\u0001b"), /control characters/);
  assert.throws(() => normalizeVocabulary("\n".repeat(100)), /at most 20/);
});
test("vocabulary needs a language", () => {
  assert.throws(() => checkVocabulary(null, "Moss"), /Choose a transcript language/);
  assert.deepEqual(checkVocabulary("en", "Moss"), ["Moss"]);
  assert.deepEqual(checkVocabulary(null, ""), []);
});
test("saved mode falls back", () => {
  assert.equal(savedMode({ defaultCaptureMode: null, rememberedSource: null }), "computer-audio");
  assert.equal(savedMode({ defaultCaptureMode: null, rememberedSource: { mode: "microphone-only" } }), "microphone-only");
  assert.equal(savedMode({ defaultCaptureMode: "selected-app" }), "selected-app");
});
test("audio options show the saved app only when chosen", () => {
  assert.equal(audioOptions({ rememberedSource: null }).length, 2);
  assert.equal(audioOptions({ defaultCaptureMode: "selected-app" }).at(-1)[1], "Selected app (saved)");
});
test("languages sort by name", () => {
  const list = languageOptions((c) => ({ en: "English", de: "German" })[c] ?? c);
  assert.ok(list.findIndex((o) => o[0] === "en") < list.findIndex((o) => o[0] === "de"));
});

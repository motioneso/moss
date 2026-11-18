/** Pure helpers for the Meetings settings screen. */

export const LANGUAGE_CODES = `aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs
ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy
ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu
ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv
mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny
oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw
ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu`.split(
  /\s+/
);

const MAX_TERMS = 20;
const MAX_BYTES = 200;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Language options sorted by English name. `names` maps a code to its display name. */
export function languageOptions(names = (code) => code) {
  return LANGUAGE_CODES.map((code) => [code, names(code) ?? code]).sort((a, b) =>
    a[1].localeCompare(b[1], "en")
  );
}

/** Splits the textarea into terms and applies the same limits as the server. Throws a plain message. */
export function normalizeVocabulary(text) {
  const lines = String(text).split("\n");
  if (lines.length > 100) throw new Error("Enter at most 20 spellings, one per line.");
  const terms = [];
  for (const line of lines) {
    if (line.length > 1000) throw new Error("Each spelling must be bounded text.");
    const term = line.trim();
    if (CONTROL.test(term))
      throw new Error("Use one spelling per line without control characters.");
    if (term && !terms.includes(term)) terms.push(term);
  }
  if (terms.length > MAX_TERMS) throw new Error("Enter at most 20 spellings.");
  if (terms.length && new TextEncoder().encode(terms.join(", ")).length > MAX_BYTES)
    throw new Error(
      "The complete vocabulary must fit within 200 UTF-8 bytes, including separators."
    );
  return terms;
}

/** Throws when vocabulary is set without a language. */
export function checkVocabulary(language, text) {
  const terms = normalizeVocabulary(text);
  if (terms.length && !language)
    throw new Error(
      "Choose a transcript language before saving vocabulary. Clear vocabulary before choosing automatic detection."
    );
  return terms;
}

export const savedMode = (prefs) =>
  prefs.defaultCaptureMode ?? prefs.rememberedSource?.mode ?? "computer-audio";

export function audioOptions(prefs) {
  const options = [
    ["computer-audio", "Microphone + system audio"],
    ["microphone-only", "Microphone only"]
  ];
  if (
    prefs.rememberedSource?.mode === "selected-app" ||
    prefs.defaultCaptureMode === "selected-app"
  )
    options.push(["selected-app", "Selected app (saved)"]);
  return options;
}

export function newKey() {
  return globalThis.crypto.randomUUID();
}

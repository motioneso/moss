/** Complete optional ASR hint, including separators; never truncate a spelling. */
export const MEETING_VOCABULARY_MAX_BYTES = 200;
export const MEETING_VOCABULARY_MAX_TERMS = 20;
const invalidCharacters = /[\p{Cc}\p{Cs}\u2028\u2029]/u;
export class MeetingVocabularyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeetingVocabularyError";
  }
}
export function isBoundedTranscriptionPrompt(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !invalidCharacters.test(value) &&
    new TextEncoder().encode(value).byteLength <= MEETING_VOCABULARY_MAX_BYTES
  );
}
export function normalizeMeetingVocabulary(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new MeetingVocabularyError("Enter at most 20 spellings, one per line.");
  const terms: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length > 1000)
      throw new MeetingVocabularyError("Each spelling must be bounded text.");
    const term = item.trim();
    if (invalidCharacters.test(term))
      throw new MeetingVocabularyError("Use one spelling per line without control characters.");
    if (term && !terms.includes(term)) terms.push(term);
  }
  if (terms.length > MEETING_VOCABULARY_MAX_TERMS)
    throw new MeetingVocabularyError("Enter at most 20 spellings.");
  if (terms.length && !isBoundedTranscriptionPrompt(terms.join(", ")))
    throw new MeetingVocabularyError(
      "The complete vocabulary must fit within 200 UTF-8 bytes, including separators."
    );
  return terms;
}
export function meetingTranscriptionOptions(
  language: string | null,
  value: unknown
): { language?: string; prompt?: string } {
  const terms = normalizeMeetingVocabulary(value);
  if (terms.length && !language)
    throw new MeetingVocabularyError(
      "Choose a transcript language before saving vocabulary. Clear vocabulary before choosing automatic detection."
    );
  return {
    ...(language ? { language } : {}),
    ...(terms.length ? { prompt: terms.join(", ") } : {})
  };
}

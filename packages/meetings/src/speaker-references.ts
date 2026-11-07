import type { MeetingOutputContent, MeetingSpeakerGuess } from "@moss/shared";

const TOKEN = /\{\{speaker:([^{}\s]{1,100})\}\}/g;

/** Number shown for a speaker with no name, for example S2 gives "Speaker 2". */
function fallbackLabel(speakerId: string): string {
  const digits = /(\d+)$/.exec(speakerId)?.[1];
  return digits ? `Speaker ${Number(digits)}` : `Speaker (${speakerId})`;
}

/**
 * Replaces {{speaker:<id>}} tokens with display text. An owner label is fact, an inferred
 * name is marked "(guess)", and an unknown or unnamed speaker becomes "Speaker N".
 */
export function resolveSpeakerReferences(
  text: string,
  speakers: readonly MeetingSpeakerGuess[] | undefined,
  ownerLabels: ReadonlyMap<string, string>
): string {
  if (!text.includes("{{speaker:")) return text;
  return text.replace(TOKEN, (_match, id: string) => {
    const label = ownerLabels.get(id);
    if (label) return label;
    const guess = speakers?.find((entry) => entry.speakerId === id);
    if (guess?.name) return `${guess.name} (guess)`;
    return fallbackLabel(id);
  });
}

/**
 * Returns the summary with every speaker token resolved, for screens, copy and export.
 * Returns the same object when nothing needs resolving.
 */
export function resolveSummarySpeakerText(
  content: MeetingOutputContent,
  ownerLabels: ReadonlyMap<string, string> = new Map()
): MeetingOutputContent {
  const resolve = (text: string) => resolveSpeakerReferences(text, content.speakers, ownerLabels);
  const touched =
    content.overview.includes("{{speaker:") ||
    content.decisions.some((claim) => claim.text.includes("{{speaker:")) ||
    content.openQuestions.some((text) => text.includes("{{speaker:")) ||
    content.actions.some((action) => action.text.includes("{{speaker:")) ||
    content.warnings.some((text) => text.includes("{{speaker:"));
  if (!touched) return content;
  return {
    ...content,
    overview: resolve(content.overview),
    decisions: content.decisions.map((claim) => ({ ...claim, text: resolve(claim.text) })),
    openQuestions: content.openQuestions.map(resolve),
    actions: content.actions.map((action) => ({ ...action, text: resolve(action.text) })),
    warnings: content.warnings.map(resolve)
  };
}

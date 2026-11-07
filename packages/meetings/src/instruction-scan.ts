import type { MeetingInstructionFlag, MeetingOutputInputs } from "@moss/shared";

const MAX_LINES = 5;
const MAX_LINE_LENGTH = 160;

/** Phrase patterns run over one lowercased, whitespace-collapsed line. Best effort only. */
const ORDER_PATTERNS: readonly RegExp[] = [
  /\b(ignore|disregard|forget|override)\b.{0,40}\b(instructions?|rules|prompt|above|previous|prior|everything)\b/,
  /\byou are now\b/,
  /\b(new|updated) instructions?\b/,
  /\bsend (this|it|that|everything) to\b/,
  /\bchange (the |my |your )?settings\b/,
  /(^|\b(and|then|please|now)\s)(delete|erase|remove) (my|all|the|every)\b/,
  /^(please )?(delete|erase) /,
  /^(please )?(leave out|omit|do not mention|don't mention|dont mention)\b/
];

export const looksLikeOrder = (line: string): boolean => {
  const normal = line.toLowerCase().replace(/\s+/g, " ").trim();
  return normal.length > 0 && ORDER_PATTERNS.some((pattern) => pattern.test(normal));
};

const cut = (line: string): string => {
  const text = line.replace(/\s+/g, " ").trim();
  return text.length > MAX_LINE_LENGTH ? `${text.slice(0, MAX_LINE_LENGTH - 1)}…` : text;
};

/**
 * Plain text scan that runs in Moss before any transcript goes to the AI. It is best
 * effort: a cleverly worded order passes. The flag is for the reader and never stops a run.
 * Returns undefined when nothing looks like an order.
 */
export function scanForInstructions(
  inputs: Pick<MeetingOutputInputs, "transcript" | "personalNotes">
): MeetingInstructionFlag | undefined {
  const texts = [
    ...(inputs.transcript?.segments.map((segment) => segment.text) ?? []),
    inputs.personalNotes
  ];
  const found: string[] = [];
  for (const text of texts)
    for (const line of text.split(/\r?\n/)) if (looksLikeOrder(line)) found.push(cut(line));
  if (found.length === 0) return undefined;
  return { lines: found.slice(0, MAX_LINES), more: Math.max(0, found.length - MAX_LINES) };
}

import { HEARTBEAT_INTRO_MAX_CHARS, HEARTBEAT_NOTE_MAX_CHARS } from "./limits.js";
import type { HeartbeatCandidate } from "./filter.js";

export interface HeartbeatModelResult {
  readonly selected: readonly { readonly findingId: string; readonly note: string }[];
  readonly intro: string | null;
}

export type HeartbeatValidation =
  | { readonly ok: true; readonly result: HeartbeatModelResult }
  | { readonly ok: false; readonly reason: string };

/** Every number a reader could see for this item: its title, time and facts. */
function allowedNumbers(candidate: HeartbeatCandidate): Set<string> {
  const text = [
    candidate.item.title,
    candidate.item.at ?? "",
    ...Object.values(candidate.item.facts).map((value) => String(value ?? ""))
  ].join(" ");
  const allowed = new Set<string>();
  for (const match of text.match(/\d+/g) ?? []) {
    allowed.add(match);
    allowed.add(String(Number(match)));
  }
  const when = candidate.item.at ? new Date(candidate.item.at) : null;
  if (when && !Number.isNaN(when.getTime()) && candidate.item.at?.includes("T")) {
    for (const hour of [when.getUTCHours(), when.getUTCHours() % 12 || 12]) {
      allowed.add(String(hour));
    }
  }
  return allowed;
}

function unsupportedNumber(note: string, candidate: HeartbeatCandidate): boolean {
  const allowed = allowedNumbers(candidate);
  return (note.match(/\d+/g) ?? []).some(
    (digits) => !allowed.has(digits) && !allowed.has(String(Number(digits)))
  );
}

/** Rejects the whole result on any unsupplied ID, repeat, overlong text or unsupported number. */
export function validateHeartbeatResult(
  raw: unknown,
  supplied: readonly HeartbeatCandidate[]
): HeartbeatValidation {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "not an object" };
  const record = raw as Record<string, unknown>;
  const intro = record.intro ?? null;
  if (intro !== null && (typeof intro !== "string" || intro.length > HEARTBEAT_INTRO_MAX_CHARS))
    return { ok: false, reason: "intro" };
  if (!Array.isArray(record.selected)) return { ok: false, reason: "selected" };
  const byId = new Map(supplied.map((candidate) => [candidate.findingId, candidate]));
  const seen = new Set<string>();
  const selected: { findingId: string; note: string }[] = [];
  for (const entry of record.selected) {
    const item = (entry ?? {}) as Record<string, unknown>;
    if (typeof item.findingId !== "string" || typeof item.note !== "string")
      return { ok: false, reason: "entry shape" };
    const candidate = byId.get(item.findingId);
    if (!candidate || seen.has(item.findingId)) return { ok: false, reason: "unknown finding" };
    if (item.note.trim() === "" || item.note.length > HEARTBEAT_NOTE_MAX_CHARS)
      return { ok: false, reason: "note length" };
    if (unsupportedNumber(item.note, candidate)) return { ok: false, reason: "unsupported number" };
    seen.add(item.findingId);
    selected.push({ findingId: item.findingId, note: item.note.trim() });
  }
  // An intro has no evidence record of its own, so it may not state numbers.
  if (typeof intro === "string" && /\d/.test(intro)) return { ok: false, reason: "intro number" };
  return { ok: true, result: { selected, intro: typeof intro === "string" ? intro.trim() : null } };
}

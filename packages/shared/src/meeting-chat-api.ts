import type { MeetingTranscriptEvidence } from "./meeting-transcript-api.js";
import {
  normalizeChatSurface,
  type AnswerSourceSupportCard,
  type ChatSurface
} from "./chat-api.js";

/** Shared cache namespace: meeting-id prefixes cover every selection of that meeting. */
export const MEETING_CHAT_TITLE_QUERY_KEY = "meeting-chat-title";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Full 128-bit identity, without hashing/truncation; fits the existing 32-character surface limit. */
export function meetingChatSurface(meetingId: string): ChatSurface {
  if (!UUID.test(meetingId)) throw new Error("Invalid meeting id");
  return normalizeChatSurface(`mtg-${BigInt(`0x${meetingId.replaceAll("-", "")}`).toString(36)}`);
}

/** Reserved malformed/noncanonical values throw rather than falling back to general chat. */
export function meetingIdFromChatSurface(surface: string): string | null {
  if (!surface.startsWith("mtg-")) return null;
  const encoded = surface.slice(4);
  if (!/^[0-9a-z]{1,25}$/.test(encoded)) throw new Error("Invalid meeting chat surface");
  let value = 0n;
  for (const character of encoded) value = value * 36n + BigInt(parseInt(character, 36));
  const hex = value.toString(16).padStart(32, "0");
  if (hex.length !== 32) throw new Error("Invalid meeting chat surface");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (meetingChatSurface(id) !== surface) throw new Error("Invalid meeting chat surface");
  return id;
}

/** Selection is UI intent only. The server resolves ownership, revisions and coverage. */
export interface MeetingChatSelection {
  readonly meetingId: string;
  readonly selectionId: string;
}

export interface MeetingChatCoverage extends MeetingChatSelection {
  readonly transcriptRevision: number;
  readonly cursor: number;
  readonly cutoffMs: number;
  /** Latest selected evidence, not proof of continuous or complete coverage. */
  readonly throughMs: number | null;
  readonly containsProvisional: boolean;
  readonly omittedSegments: number;
  /** Present on answers including saved personal notes; older answers have transcript only. */
  readonly notesRevision?: number;
  readonly notesCharacters?: number;
  readonly notesTruncated?: boolean;
}

export interface MeetingChatCitation extends MeetingTranscriptEvidence {
  readonly supportId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly finality: "provisional" | "final";
}

/** Server-generated answer binding. Evidence text is intentionally not copied into metadata. */
export interface StoredMeetingChatContext {
  readonly ownerUserId: string;
  readonly coverage: MeetingChatCoverage;
  readonly citations: readonly MeetingChatCitation[];
}

export type MeetingChatEvidenceResult =
  | { readonly available: true; readonly citation: MeetingChatCitation; readonly excerpt: string }
  | { readonly available: false };

export interface MeetingChatTurnResponse {
  readonly reply: string;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly meetingContext: MeetingChatCoverage;
  readonly answerProvenance: readonly AnswerSourceSupportCard[];
  readonly answerProvenanceCitedIds: readonly string[];
}

import type {
  BriefingPlanContextV1,
  BriefingStructuredPayloadV1,
  SourceFreshnessV1
} from "@moss/shared";

import type { BriefingGap, ComposeResult, Section } from "./compose.js";

// Degraded, non-AI briefing render. Used when there is no model, a credential error, or
// synthesis failed: emit a plain label/count/lines digest from the already-gathered
// sections so the user still gets their sources. No external text is ever treated as
// instructions here — every line was sanitized upstream at gather time.
export function fallback(
  sections: readonly Section[],
  gaps: BriefingGap[],
  reason: "no_model" | "credential_error" | "synthesis_failed",
  commitments: Section,
  tasks: Section,
  calendar: Section,
  email: Section,
  vault: Section,
  chats: Section,
  vaultNotes: Array<{ path: string; id: string; excerpt: string }>,
  structuredPayload: BriefingStructuredPayloadV1,
  sourceTimestamps?: SourceFreshnessV1,
  editorial?: Record<string, unknown>,
  planSnapshot?: BriefingPlanContextV1
): ComposeResult {
  const text = sections
    .map(
      (s) =>
        `${s.label}: ${s.count} item${s.count === 1 ? "" : "s"}${s.lines.length > 0 ? `\n${s.lines.map((l) => `- ${l}`).join("\n")}` : ""}`
    )
    .join("\n\n");
  return {
    status: "succeeded",
    summaryText: text || "Briefing did not produce visible source items.",
    sourceMetadata: {
      commitmentCount: commitments.count,
      taskCount: tasks.count,
      calendarCount: calendar.count,
      calendarSignals: [],
      emailCount: email.count,
      emailSignals: [],
      vaultCount: vault.count,
      chatTurnCount: chats.count,
      notes: vaultNotes,
      aiModel: null,
      gaps,
      ...(editorial !== undefined ? { editorial } : {}),
      ...(planSnapshot !== undefined ? { planSnapshot } : {}),
      degraded: true,
      degradedReason: reason,
      ...(sourceTimestamps !== undefined ? { sourceTimestamps } : {})
    },
    structuredPayload
  };
}

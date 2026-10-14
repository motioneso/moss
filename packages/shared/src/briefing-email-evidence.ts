/** Dated email assessments stored privately with a briefing run. */
export interface BriefingEmailEvidenceV1 {
  readonly version: 1;
  readonly capturedAt: string;
  readonly localDate: string;
  readonly truncated: boolean;
  readonly items: readonly {
    readonly messageId: string;
    readonly connectorAccountId: string;
    readonly threadId: string | null;
    readonly receivedAt: string | null;
    readonly ageDays: number | null;
    readonly actionability: string | null;
    readonly awaitingJudgement: boolean;
    readonly status: "reported_today" | "settled" | "current_status_unknown" | "informational";
    readonly reason: string;
    readonly contraryMessageIds: readonly string[];
    readonly rank: number | null;
    readonly rankingReasons: readonly string[];
  }[];
}

import type { AccessContext, DataContextDb } from "@moss/db";

export type MeetingCaptureTranscriber = (
  actor: AccessContext,
  input: {
    audio: Uint8Array;
    language?: string;
    readonly prompt?: string;
    sampleRateHz: number;
    signal: AbortSignal;
    expectedModelRoute: string;
    dispatch: <T>(
      initiate: () => Promise<T>,
      validate?: (db: DataContextDb) => Promise<void>
    ) => Promise<T>;
  }
) => Promise<{
  segments: readonly { startMs: number; endMs: number; text: string }[];
  modelRoute: string;
}>;

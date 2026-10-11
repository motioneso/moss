import { describe, expect, it } from "vitest";
import type { TranscriptRecord } from "@moss/shared";
import { injectActionResultRecord } from "../../packages/chat/src/live/session-runtime-helpers.js";
import { upsertTranscriptRecord } from "../../apps/web/src/chat/stream-record-identity.js";
import { parseRecord } from "../../apps/web/src/chat/use-chat-stream.js";
import { groupRecords } from "../../packages/ui/src/chat-thread.js";

describe("gateway approval notification replay", () => {
  it.each(["person", "timeout", "cancelled", "policy"] as const)(
    "does not duplicate %s decision steps or change Thinking's count",
    (decidedBy) => {
      const emitted: TranscriptRecord[] = [];
      injectActionResultRecord(
        {
          kind: "action_result",
          text: "Gateway status",
          toolName: "app.callAction",
          actionRequestId: "request-1",
          decidedBy,
          outcome: "denied"
        },
        {
          sessionKey: "session",
          sequenceBySession: new Map(),
          emit: (record) => {
            emitted.push(parseRecord(JSON.stringify(record))!);
          }
        }
      );
      expect(emitted).toHaveLength(2);
      let records: TranscriptRecord[] = [{ kind: "thought", text: "Planning" }];
      for (const record of emitted) records = upsertTranscriptRecord(records, record);
      const before = groupRecords(records, false);
      for (const record of emitted) records = upsertTranscriptRecord(records, record);
      expect(groupRecords(records, false)).toEqual(before);
      expect(records).toHaveLength(3);
    }
  );
});

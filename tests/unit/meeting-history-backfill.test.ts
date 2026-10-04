import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
const sidecar = fileURLToPath(
  new URL("../../packages/meetings/sql/0267_meeting_history.backfill.mjs", import.meta.url)
);
type Query = (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
const load = async () =>
  (await import(sidecar)) as { backfill: (client: { query: Query }) => Promise<void> };
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
describe("frozen meeting history backfill", () => {
  it("preserves escaped Unicode identity and original bodies while filling bounded projections", async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const { backfill } = await load();
    const source = {
      sourceId: "mic",
      epoch: 1,
      kind: "microphone",
      label: "Mic\ud800",
      startMs: 0,
      endMs: 30
    };
    const event = (segmentId: string, revision: number, text: string) => ({
      cursor: revision,
      segment: {
        meetingId: id,
        segmentId,
        sourceId: "mic",
        epoch: 1,
        startMs: 0,
        endMs: 30,
        revision,
        text,
        finality: "final",
        provenance: "transcription",
        speakerId: null
      }
    });
    const input = JSON.stringify({
      sources: [source],
      events: [
        event("\ud800", 1, "old"),
        event("\ud801", 1, "other\ud800word"),
        event("\ud800", 2, "current😀")
      ]
    });
    const artifact = JSON.stringify({
      origin: "manual",
      inputs: { notesRevision: 2, transcript: null },
      stale: false,
      content: { overview: "accepted\0\ud800" }
    });
    await backfill({
      query: async (text, values = []) => {
        calls.push({ text, values });
        if (text.startsWith("SELECT id,") && values[0] === null)
          return { rows: [{ id, owner_user_id: id }] };
        if (text.startsWith("SELECT version, input_json") && values[1] === 0)
          return { rows: [{ version: 1, input_json: input }] };
        if (text.startsWith("SELECT request_key,") && values[1] === null)
          return {
            rows: [
              {
                request_key: id,
                input_json: '{"kind":"generate"}',
                result_json: JSON.stringify({ status: "saved", artifact: JSON.parse(artifact) })
              }
            ]
          };
        if (text.startsWith("SELECT version,artifact_json") && values[1] === 0)
          return { rows: [{ version: 1, artifact_json: artifact }] };
        return { rows: [] };
      }
    });
    const inserts = calls.filter(({ text }) =>
      text.startsWith("INSERT INTO app.meeting_history_segments")
    );
    expect(inserts).toHaveLength(2);
    expect(inserts.map(({ values }) => values[2])).toEqual([
      JSON.stringify("\ud800"),
      JSON.stringify("\ud801")
    ]);
    expect(inserts.map(({ values }) => values[7])).toEqual(["current😀", "other word"]);
    expect(calls.filter(({ text }) => text.includes("FORCE ROW LEVEL SECURITY"))).toHaveLength(6);
    expect(
      calls.some(({ text }) => /SET (input_json|artifact_json|result_json|receipt_json)/.test(text))
    ).toBe(false);
    expect(calls.some(({ values }) => values.includes(input) || values.includes(artifact))).toBe(
      false
    );
    expect(
      calls
        .filter(({ text }) => text.startsWith("SELECT") && !text.startsWith("SELECT id,"))
        .every(({ text }) => text.includes("LIMIT 8"))
    ).toBe(true);
  });
  it("throws a content-free error when a query fails, leaving rollback to the canonical runner", async () => {
    const { backfill } = await load();
    await expect(
      backfill({
        query: async () => {
          throw new Error("private-migration-payload");
        }
      })
    ).rejects.toThrow("Meeting history migration backfill failed");
  });
});

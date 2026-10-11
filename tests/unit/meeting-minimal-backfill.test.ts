import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { projectMeetingOverview } from "../../packages/meetings/src/history-projection.js";
async function load() {
  const source = await readFile(
    new URL("../../packages/meetings/sql/0292_meeting_minimal.backfill.mjs", import.meta.url),
    "utf8"
  );
  return import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  ) as Promise<{
    backfill(client: {
      query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
    }): Promise<void>;
  }>;
}
describe("0292 bounded retained projections", () => {
  it("projects existing summaries and actual native durations, preserving source JSON", async () => {
    const text = `  Two owners\n retain evidence \0 \ud800 ${"🙂".repeat(250)}`;
    let artifactsRead = false,
      capturesRead = false;
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.startsWith("SELECT id,artifact_json") && !artifactsRead) {
        artifactsRead = true;
        return {
          rows: [
            { id: "a", artifact_json: JSON.stringify({ content: { overview: text } }) },
            { id: "b", artifact_json: JSON.stringify({ content: { overview: "Second owner" } }) }
          ]
        };
      }
      if (sql.startsWith("SELECT id,state_json") && !capturesRead) {
        capturesRead = true;
        return {
          rows: [
            {
              id: "c",
              state_json: JSON.stringify({ recordedDurationMs: 3210, padding: "x".repeat(510000) })
            },
            { id: "d", state_json: JSON.stringify({ recordedDurationMs: "not-a-duration" }) }
          ]
        };
      }
      return { rows: [] };
    });
    await (await load()).backfill({ query });
    expect(query).toHaveBeenCalledWith(
      "UPDATE app.meeting_output_artifacts SET history_overview=$2 WHERE id=$1::uuid",
      ["a", projectMeetingOverview(text)]
    );
    expect(query).toHaveBeenCalledWith(
      "UPDATE app.meeting_capture_grants SET recorded_duration_ms=$2 WHERE id=$1::uuid",
      ["c", 3210]
    );
    expect(query).toHaveBeenCalledWith(
      "UPDATE app.meeting_capture_grants SET recorded_duration_ms=$2 WHERE id=$1::uuid",
      ["d", null]
    );
    expect(query).toHaveBeenCalledWith(
      "ALTER TABLE app.meeting_capture_grants FORCE ROW LEVEL SECURITY"
    );
    expect(
      query.mock.calls
        .filter(([sql]) => sql.startsWith("UPDATE"))
        .every(([sql]) => !/SET (artifact_json|state_json)/.test(sql))
    ).toBe(true);
  });
  it("sanitizes failure diagnostics rather than exposing retained text", async () => {
    const query = vi.fn(async () => {
      throw new Error("private malformed row");
    });
    await expect((await load()).backfill({ query })).rejects.toThrow(
      "Meeting minimal projection backfill failed"
    );
  });
});

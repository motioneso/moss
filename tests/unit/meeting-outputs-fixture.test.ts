import { describe, expect, it } from "vitest";
import {
  fixtureOutput,
  OUTPUT_FIXTURE_MODEL,
  OUTPUT_FIXTURE_TEXT
} from "../uat/fixtures/meeting-outputs-fixture-server.js";

function request(meetingId = "synthetic-meeting", segmentId = "synthetic-segment", revision = 7) {
  return {
    model: OUTPUT_FIXTURE_MODEL,
    messages: [
      {
        role: "user",
        content:
          "Retained evidence, not necessarily the full meeting.\nexternalData (escaped JSON):\n" +
          JSON.stringify({
            meetingId,
            notesRevision: 0,
            personalNotes: "",
            transcript: {
              segments: [{ meetingId, segmentId, revision, text: OUTPUT_FIXTURE_TEXT }]
            }
          })
      }
    ]
  };
}
describe("disclosed Meeting output HTTP stand-in", () => {
  it("binds exact dynamic meeting, segment revision and UTF-16 ranges from actual outbound JSON", () => {
    const result = fixtureOutput(request("meeting-two", "segment-three", 9));
    const expected = [
      {
        kind: "transcript",
        meetingId: "meeting-two",
        segmentId: "segment-three",
        segmentRevision: 9,
        startCharacter: 0,
        endCharacter: OUTPUT_FIXTURE_TEXT.length
      }
    ];
    expect(result.content.decisions[0]!.evidence).toEqual(expected);
    expect(result.content.actions[0]!.evidence).toEqual(expected);
    expect(result.content.actions[0]).toMatchObject({ ownerPhrase: "Alex", duePhrase: "tomorrow" });
  });
  it("retains bounded observations rather than private prompts, IDs or headers", () => {
    const result = fixtureOutput(request());
    expect(result.observation).toEqual({
      model: OUTPUT_FIXTURE_MODEL,
      hasTools: false,
      hasSearch: false,
      exactSource: true,
      sourceCount: 1,
      promptBytes: expect.any(Number)
    });
    expect(JSON.stringify(result.observation)).not.toContain(OUTPUT_FIXTURE_TEXT);
    expect(JSON.stringify(result.observation)).not.toContain("synthetic-meeting");
  });
  it("reports tools/search instead of concealing unexpected capabilities", () => {
    const result = fixtureOutput({ ...request(), tools: [], web_search_options: {} });
    expect(result.observation).toMatchObject({ hasTools: true, hasSearch: true });
  });
  it("rejects absent or non-synthetic source instead of inventing grounded output", () => {
    expect(() => fixtureOutput({ messages: [] })).toThrow("Missing structured source");
    const altered = JSON.parse(
      JSON.stringify(request()).replace(OUTPUT_FIXTURE_TEXT, "Other source")
    );
    expect(() => fixtureOutput(altered)).toThrow("Unexpected synthetic source");
  });
});

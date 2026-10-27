import { describe, it, expect } from "vitest";
import { validateManualTranscript } from "../../packages/meetings/src/manual-entry-service.js";
import { validateRecordingInterpretation } from "../../packages/meetings/src/recording-validation.js";
import { DEFAULT_RECORDING_TYPES } from "../../packages/meetings/src/recording-types.js";
import type { RecordingOutputContext } from "@moss/shared";
const context: RecordingOutputContext = {
  metadata: {
    meetingId: "m",
    revision: 0,
    typeId: null,
    typeSource: "automatic",
    titleSource: "automatic",
    side: null,
    confidence: null,
    reason: null,
    recordedAt: null,
    source: "recording",
    outputVersion: null
  },
  configuration: { revision: 0, types: DEFAULT_RECORDING_TYPES }
};
const valid = {
  title: "Grass ideas",
  typeId: "brain-dump",
  side: "personal",
  confidence: 0.85,
  reason: "A hobby project",
  ideaGroups: [{ title: "Grass", ideas: ["Animate the wind"] }]
};
describe("recording interpretation boundary", () => {
  it("accepts bounded active-type values and rejects unknown fields", () => {
    expect(validateRecordingInterpretation(valid, context)).toEqual(valid);
    expect(() =>
      validateRecordingInterpretation({ ...valid, path: "/private" }, context)
    ).toThrow();
  });
  it.each([
    { typeId: "Brain dump" },
    { typeId: "missing" },
    { confidence: 1.1 },
    { confidence: NaN },
    { side: "both" },
    { title: "🍃".repeat(70) },
    { ideaGroups: [{ title: "topic", ideas: [] }] }
  ])("rejects invalid interpretation %j", (patch) => {
    expect(() => validateRecordingInterpretation({ ...valid, ...patch }, context)).toThrow();
  });
  it("rejects retired classification IDs", () => {
    expect(() =>
      validateRecordingInterpretation(valid, {
        ...context,
        configuration: {
          revision: 1,
          types: DEFAULT_RECORDING_TYPES.map((type) => ({
            ...type,
            retired: type.id === "brain-dump"
          }))
        }
      })
    ).toThrow();
  });
  it("rejects blank manual evidence and unrecognized controls", () => {
    const input = { requestKey: "11111111-1111-4111-8111-111111111111", transcript: " " };
    expect(() => validateManualTranscript(input)).toThrow();
    const unrecognized = { ...input, transcript: "Thoughts", side: "work" };
    expect(() => validateManualTranscript(unrecognized)).toThrow();
  });
});

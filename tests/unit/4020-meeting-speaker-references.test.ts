import { describe, expect, it } from "vitest";
import type { MeetingOutputArtifact, MeetingSpeakerGuess } from "@moss/shared";
import {
  resolveSpeakerReferences,
  resolveSummarySpeakerText
} from "../../packages/meetings/src/speaker-references.js";
import { renderMeetingExport } from "../../packages/meetings/src/export-render.js";

const guess = (over: Partial<MeetingSpeakerGuess> = {}): MeetingSpeakerGuess => ({
  speakerId: "S1",
  name: "Alex",
  basis: "inference",
  confidence: "low",
  evidence: ["seg-1"],
  ...over
});

describe("resolveSpeakerReferences", () => {
  it("renders an unknown speaker as Speaker N and never leaves a raw token", () => {
    expect(resolveSpeakerReferences("{{speaker:S2}} agreed.", [], new Map())).toBe(
      "Speaker 2 agreed."
    );
    expect(resolveSpeakerReferences("{{speaker:mic}} agreed.", undefined, new Map())).not.toContain(
      "{{"
    );
  });
  it("marks an inferred name as a guess", () => {
    expect(resolveSpeakerReferences("{{speaker:S1}} spoke", [guess()], new Map())).toBe(
      "Alex (guess) spoke"
    );
  });
  it("uses an owner label as fact", () => {
    expect(
      resolveSpeakerReferences("{{speaker:S1}} spoke", [guess()], new Map([["S1", "Alexandra"]]))
    ).toBe("Alexandra spoke");
  });
  it("falls back to Speaker N when the guess has no name", () => {
    expect(
      resolveSpeakerReferences(
        "{{speaker:S3}}",
        [guess({ speakerId: "S3", name: null })],
        new Map()
      )
    ).toBe("Speaker 3");
  });
  it("leaves text without tokens byte-identical", () => {
    const text = "Plain {text} with {{ other }} braces";
    expect(resolveSpeakerReferences(text, [guess()], new Map())).toBe(text);
  });
});

function artifact(content: Record<string, unknown>): MeetingOutputArtifact {
  return {
    id: "a",
    meetingId: "m",
    version: 1,
    inputs: { meetingId: "m", transcript: null, personalNotes: "", notesRevision: 0 },
    templateId: "general",
    templateVersion: 1,
    modelRoute: "r",
    content: {
      overview: "{{speaker:S2}} led.",
      decisions: [],
      openQuestions: [],
      actions: [],
      warnings: [],
      ...content
    } as MeetingOutputArtifact["content"],
    origin: "generated",
    stale: false,
    createdAt: "2026-11-07T00:00:00.000Z"
  };
}

describe("export and copy", () => {
  it("exports Speaker 2 when no entry exists", () => {
    const out = renderMeetingExport(artifact({}));
    expect(out).toContain("Speaker 2 led");
    expect(out).not.toContain("speaker:");
  });
  it("exports Name (guess) with an inference entry", () => {
    const out = renderMeetingExport(
      artifact({ overview: "{{speaker:S1}} led.", speakers: [guess()] })
    );
    expect(out).toContain("Alex \\(guess\\) led");
  });
  it("resolves decisions and actions too", () => {
    const content = resolveSummarySpeakerText(
      artifact({
        decisions: [{ text: "{{speaker:S1}} decided", evidence: [] }],
        actions: [
          { text: "{{speaker:S1}} sends", evidence: [], ownerPhrase: null, duePhrase: null }
        ],
        speakers: [guess()]
      }).content
    );
    expect(content.decisions[0]!.text).toBe("Alex (guess) decided");
    expect(content.actions[0]!.text).toBe("Alex (guess) sends");
  });
  it("leaves a legacy summary byte-identical", () => {
    const legacy = artifact({ overview: "Plain." }).content;
    expect(JSON.stringify(resolveSummarySpeakerText(legacy))).toBe(JSON.stringify(legacy));
    expect(resolveSummarySpeakerText(legacy)).toBe(legacy);
  });
});

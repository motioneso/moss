import assert from "node:assert/strict";
import test from "node:test";
import {
  esc,
  lineLabel,
  markdownBody,
  meetingLength,
  operationError,
  parseEvidence,
  resolveSummary,
  summaryFailure,
  titleProblem,
  transcriptTime
} from "./format.mjs";
import { evidenceHtml } from "./summary-parts.mjs";

test("text is escaped", () =>
  assert.equal(esc(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;"));

test("times and lengths", () => {
  assert.equal(transcriptTime(65000), "1:05");
  assert.equal(meetingLength(null), "—");
  assert.equal(meetingLength(30000), "1 min");
  assert.equal(meetingLength(95 * 60000), "1 hr 35 min");
});

test("line labels match on source and epoch", () => {
  const sources = [
    { sourceId: "a", epoch: 1, kind: "microphone" },
    { sourceId: "a", epoch: 2, kind: "output" }
  ];
  assert.equal(lineLabel({ sourceId: "a", epoch: 1 }, sources), "You");
  assert.equal(lineLabel({ sourceId: "a", epoch: 2 }, sources), "Call audio");
  assert.equal(lineLabel({ sourceId: "z", epoch: 1 }, sources), "Audio");
});

test("speaker references resolve in summary text", () => {
  const out = resolveSummary({
    speakers: [],
    overview: "{{speaker:s2}} spoke",
    decisions: [],
    openQuestions: [],
    actions: [],
    warnings: []
  });
  assert.equal(out.overview, "Speaker 2 spoke");
});

test("evidence ranges are validated", () => {
  const ok = new URLSearchParams("segmentId=x&segmentRevision=1&startCharacter=0&endCharacter=4");
  assert.deepEqual(parseEvidence(ok), {
    segmentId: "x",
    segmentRevision: 1,
    startCharacter: 0,
    endCharacter: 4
  });
  assert.equal(
    parseEvidence(
      new URLSearchParams("segmentId=x&segmentRevision=1&startCharacter=4&endCharacter=4")
    ),
    null
  );
  assert.equal(parseEvidence(new URLSearchParams("segmentRevision=1")), null);
});

test("failures name a fix only for known codes", () => {
  assert.equal(summaryFailure("meeting_output_provider_failed").remediation, "ai-providers");
  assert.equal(summaryFailure("nonsense").remediation, undefined);
  assert.equal(operationError({ status: 500 }).status, "retry");
  assert.equal(operationError({ status: 403 }).status, "denied");
  assert.equal(operationError({ status: 409 }).status, "failed");
});

test("titles over the byte limit are refused", () => {
  assert.equal(titleProblem("ok"), null);
  assert.ok(titleProblem("x".repeat(241)));
});

test("markdown copy holds title, notes, summary and transcript", () => {
  const body = markdownBody(
    { title: "T", personalNotes: "N" },
    {
      content: {
        speakers: [],
        overview: "O",
        decisions: [{ text: "D" }],
        openQuestions: [],
        actions: [{ text: "A" }],
        warnings: []
      }
    },
    { snapshot: { segments: [{ startMs: 1000, text: "hi" }] } }
  );
  assert.ok(body.startsWith("# T\n\n## Notes\n\nN"));
  assert.ok(body.includes("- D") && body.includes("- [ ] A") && body.includes("[0:01] hi"));
});

test("evidence from a note shows only the quoted slice", () => {
  const html = evidenceHtml([{ kind: "personal-note", startCharacter: 0, endCharacter: 3 }], {
    inputs: { personalNotes: "abcdef" }
  });
  assert.ok(html.includes("abc") && !html.includes("abcdef"));
});

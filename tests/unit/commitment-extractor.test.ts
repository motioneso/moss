import { describe, it, expect, vi } from "vitest";
import { extractCommitmentsFromText } from "@moss/commitments/extractor";

describe("extractCommitmentsFromText", () => {
  it("returns empty array for text that fails prefilter", async () => {
    const mockGenerate = vi.fn().mockResolvedValue({ text: '{"candidates":[]}' });
    const warn = vi.fn();
    const result = await extractCommitmentsFromText(
      mockGenerate,
      "Sounds good, thanks!",
      "chat",
      "2026-06-28T10:00:00Z",
      { warn }
    );
    expect(result).toEqual([]);
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn on a valid empty candidates result", async () => {
    const mockGenerate = vi.fn().mockResolvedValue({ text: '{"candidates":[]}' });
    const warn = vi.fn();
    const result = await extractCommitmentsFromText(
      mockGenerate,
      "I need to submit by tomorrow",
      "chat",
      "2026-06-28T10:00:00Z",
      { warn }
    );
    expect(result).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("calls AI and parses valid response", async () => {
    const mockGenerate = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        candidates: [
          {
            kind: "deadline",
            title: "Send the report",
            dueLocalDate: "2026-07-01",
            counterpartyLabel: "Alice",
            evidenceExcerpt: "I need to send the report to Alice by July 1st",
            confidence: "high"
          }
        ]
      })
    });
    const result = await extractCommitmentsFromText(
      mockGenerate,
      "I need to send the report to Alice by July 1st",
      "chat",
      "2026-06-28T10:00:00Z"
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe("deadline");
    expect(result[0]!.title).toBe("Send the report");
  });

  it("returns empty array on malformed AI response and warns once, bounded", async () => {
    const mockGenerate = vi.fn().mockResolvedValue({ text: "not json" });
    const warn = vi.fn();
    const result = await extractCommitmentsFromText(
      mockGenerate,
      "I need to submit by tomorrow",
      "chat",
      "2026-06-28T10:00:00Z",
      { warn }
    );
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0]!;
    expect(fields).toMatchObject({
      event: "commitment-extraction-malformed-output",
      sourceKind: "chat"
    });
    expect(message).toBe("commitment extraction: malformed model output");
  });

  it("warns once when the response has a candidates field that is not an array", async () => {
    const mockGenerate = vi.fn().mockResolvedValue({ text: '{"candidates":"not-an-array"}' });
    const warn = vi.fn();
    const result = await extractCommitmentsFromText(
      mockGenerate,
      "I need to submit by tomorrow",
      "chat",
      "2026-06-28T10:00:00Z",
      { warn }
    );
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({
      event: "commitment-extraction-malformed-output",
      sourceKind: "chat"
    });
  });

  it("returns empty array when AI throws and warns once, bounded", async () => {
    const mockGenerate = vi.fn().mockRejectedValue(new Error("API error"));
    const warn = vi.fn();
    const result = await extractCommitmentsFromText(
      mockGenerate,
      "I need to submit by tomorrow",
      "chat",
      "2026-06-28T10:00:00Z",
      { warn }
    );
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0]!;
    expect(fields).toMatchObject({
      event: "commitment-extraction-adapter-error",
      sourceKind: "chat",
      errorName: "Error",
      errorMessage: "API error"
    });
    expect(message).toBe("commitment extraction: adapter generation failed");
  });

  it("bounds a long, multi-line error message to 256 chars with no CR/LF", async () => {
    const longMessage = `line one\r\nline two\r\n${"x".repeat(400)}`;
    const mockGenerate = vi.fn().mockRejectedValue(new Error(longMessage));
    const warn = vi.fn();
    await extractCommitmentsFromText(
      mockGenerate,
      "I need to submit by tomorrow",
      "chat",
      "2026-06-28T10:00:00Z",
      { warn }
    );
    const fields = warn.mock.calls[0]![0] as { errorMessage: string };
    expect(fields.errorMessage.length).toBeLessThanOrEqual(256);
    expect(fields.errorMessage).not.toMatch(/[\r\n]/);
  });

  it("warning fields on a caught-error path are exactly the closed set (no prompt/model-output leak)", async () => {
    const mockGenerate = vi.fn().mockRejectedValue(new Error("upstream failure"));
    const warn = vi.fn();
    await extractCommitmentsFromText(
      mockGenerate,
      "I need to submit by tomorrow",
      "chat",
      "2026-06-28T10:00:00Z",
      { warn }
    );
    expect(Object.keys(warn.mock.calls[0]![0] as object).sort()).toEqual(
      ["errorMessage", "errorName", "event", "sourceKind"].sort()
    );
  });

  it("malformed-output warning never carries the raw model response text", async () => {
    const rawResponse = "this-exact-string-must-never-appear-in-warn-fields";
    const mockGenerate = vi.fn().mockResolvedValue({ text: rawResponse });
    const warn = vi.fn();
    await extractCommitmentsFromText(
      mockGenerate,
      "I need to submit by tomorrow",
      "chat",
      "2026-06-28T10:00:00Z",
      { warn }
    );
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain(rawResponse);
  });
});

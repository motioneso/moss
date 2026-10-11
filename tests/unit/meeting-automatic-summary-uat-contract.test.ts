import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("tests/uat/specs/2981-meeting-automatic-summary.uat.spec.ts", "utf8");

describe("automatic meeting summary UAT default-model contract", () => {
  it("provisions a chat-eligible default while retaining capture and structured-summary capabilities", () => {
    const capabilities = source.match(/capabilities:\s*\[([^\]]+)\]/)?.[1];
    expect(capabilities).toBeDefined();
    const declared = [...capabilities!.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect(declared).toEqual(["chat", "transcription", "summarization", "json"]);
  });

  it("checks the real default selection and meeting availability before recording", () => {
    const pin = source.indexOf("page.request.put(pinPath, { data: { modelId } })");
    const selected = source.indexOf('page.request.get("/api/ai/chat-model-override")');
    const availability = source.indexOf(
      "const availability = await page.request.get(`${path}/outputs`)"
    );
    const start = source.indexOf(
      'getByRole("button", { name: "Start recording", exact: true }).click()'
    );
    expect(pin).toBeGreaterThan(-1);
    expect(selected).toBeGreaterThan(pin);
    expect(availability).toBeGreaterThan(selected);
    expect(start).toBeGreaterThan(availability);
    expect(source).toContain("defaultModel: { id: modelId }");
    expect(source).toContain("selectedModel: { id: modelId }");
    expect(source).toContain(
      'expect((await availability.json()).generationAvailability).toBe("available")'
    );
  });

  it("keeps bounded status/code diagnostics and the original automatic-generation proof", () => {
    expect(source).toContain("status: completed.automaticSummary?.status ?? null");
    expect(source).toContain("code: completed.automaticSummary?.code ?? null");
    expect(source).toContain('.toEqual({ status: "saved", code: null })');
    expect(source).toContain('toMatchObject({ status: "waiting" })');
    expect(source).toContain("expect(completed!.artifacts).toHaveLength(1)");
    expect(source).toContain("expect(generationPosts).toBe(0)");
    expect(source).toContain(
      "expect(replayOutputs.automaticSummary).toEqual(completed!.automaticSummary)"
    );
  });
});

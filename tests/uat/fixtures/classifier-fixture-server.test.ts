import { describe, expect, it } from "vitest";

import {
  buildChoiceObject,
  buildClassifierFixtureResponse,
  chooseFixtureOption
} from "./classifier-fixture-server.js";

// #2907 (plan 3.5): the classifier fixture's wire shape, without a port. The product adapter
// (openai-compatible structured) reads `choices[0].message.content` as JSON, so the answer must be
// a verbatim JSON choice object whose scores name every option and sum to one.

function request(schema: Record<string, unknown>): string {
  return JSON.stringify({
    model: "uat-classifier-fixture-model",
    messages: [{ role: "user", content: "which area?" }],
    response_format: { type: "json_schema", json_schema: { name: "structured_output", schema } }
  });
}

function choiceSchema(options: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: { choice: { type: "string", enum: [...options] } },
    required: ["choice"]
  };
}

describe("classifier fixture choice answers", () => {
  it("prefers the calendar area the shadow proof needs", () => {
    expect(chooseFixtureOption(["none", "calendar", "needs_earlier_conversation"])).toBe(
      "calendar"
    );
    expect(chooseFixtureOption(["calendar.listVisibleEvents", "none"])).toBe(
      "calendar.listVisibleEvents"
    );
    expect(chooseFixtureOption(["tomorrow", "today", "none_of_these"])).toBe("today");
  });

  it("falls back to the first non-sentinel option", () => {
    expect(chooseFixtureOption(["none", "tasks", "other"])).toBe("tasks");
  });

  it("builds a valid choice object with a one-decimal-summing score set", () => {
    const object = buildChoiceObject(["calendar", "none", "needs_earlier_conversation"])!;
    expect(object["choice"]).toBe("calendar");
    expect(object["confidence"]).toBe(0.99);
    const scores = object["scores"] as Record<string, number>;
    expect(Object.keys(scores)).toHaveLength(3);
    expect(scores["calendar"]).toBe(0.99);
    const sum = Object.values(scores).reduce((total, value) => total + value, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(0.02);
  });

  it("returns a fixed openai-compatible body for a choice request", () => {
    const { status, body } = buildClassifierFixtureResponse(
      request(choiceSchema(["none", "calendar", "needs_earlier_conversation"]))
    );
    expect(status).toBe(200);
    const parsed = JSON.parse(body) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number };
    };
    expect(JSON.parse(parsed.choices[0]!.message.content)).toMatchObject({ choice: "calendar" });
    expect(parsed.usage.prompt_tokens).toBeGreaterThan(0);
  });

  it("fails loudly for a non-choice schema or a malformed body", () => {
    expect(buildClassifierFixtureResponse("{not json").status).toBe(400);
    expect(
      buildClassifierFixtureResponse(
        request({ type: "object", properties: { title: { type: "string" } } })
      ).status
    ).toBe(400);
  });
});

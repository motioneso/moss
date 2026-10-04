import { describe, expect, it } from "vitest";
import {
  MEETING_FIXTURE_MODEL,
  MEETING_FIXTURE_QUESTION,
  MEETING_FIXTURE_OLD,
  MEETING_FIXTURE_NEW,
  MEETING_FIXTURE_UNRELATED,
  observeMeetingFixtureRequest
} from "./meeting-chat-fixture-server.js";

describe("meeting chat third-party request observer", () => {
  it("records bounded synthetic evidence without retaining prompt or credentials", () => {
    const evidence = observeMeetingFixtureRequest("/v1/chat/completions", {
      model: MEETING_FIXTURE_MODEL,
      messages: [
        {
          role: "user",
          content: `${MEETING_FIXTURE_QUESTION} external_source ${MEETING_FIXTURE_OLD}`
        }
      ]
    });
    expect(evidence).toEqual({
      path: "/v1/chat/completions",
      model: MEETING_FIXTURE_MODEL,
      hasTools: false,
      hasNativeSearch: false,
      hasOld: true,
      hasNew: false,
      hasUnrelated: false,
      hasExternalSource: true
    });
    expect(JSON.stringify(evidence)).not.toContain(MEETING_FIXTURE_QUESTION);
    expect(JSON.stringify(evidence)).not.toContain(MEETING_FIXTURE_OLD);
  });
  it("detects tools, search, contamination and revised text instead of silently passing", () => {
    const body = {
      input: MEETING_FIXTURE_QUESTION + MEETING_FIXTURE_NEW + MEETING_FIXTURE_UNRELATED,
      tools: [{ type: "web_search" }]
    };
    expect(observeMeetingFixtureRequest("/v1/responses", body)).toMatchObject({
      hasTools: true,
      hasNativeSearch: true,
      hasOld: false,
      hasNew: true,
      hasUnrelated: true
    });
  });
  it("ignores provider setup probes unrelated to the actual user turn", () => {
    expect(observeMeetingFixtureRequest("/v1/chat/completions", { messages: [] })).toBeNull();
  });
});

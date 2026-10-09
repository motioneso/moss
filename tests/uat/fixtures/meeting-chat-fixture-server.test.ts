import { afterEach, describe, expect, it } from "vitest";
import {
  MEETING_FIXTURE_LATE_REPLY,
  MEETING_FIXTURE_MODEL,
  MEETING_FIXTURE_QUESTION,
  MEETING_FIXTURE_OLD,
  MEETING_FIXTURE_NEW,
  MEETING_FIXTURE_UNRELATED,
  MEETING_FIXTURE_REPLY,
  observeMeetingFixtureRequest,
  startMeetingChatFixtureServer
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

describe("meeting chat third-party stand-in hold controls", () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  async function start() {
    const server = await startMeetingChatFixtureServer(0);
    stop = server.stop;
    const base = `http://127.0.0.1:${server.port}`;
    const completion = (question = MEETING_FIXTURE_QUESTION) =>
      fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MEETING_FIXTURE_MODEL, messages: [{ content: question }] })
      });
    const held = async () =>
      ((await (await fetch(`${base}/control/held`)).json()) as { held: boolean }).held;
    return { base, completion, held };
  }

  it("holds the next meeting turn until released with a distinct late answer", async () => {
    const { base, completion, held } = await start();
    expect((await fetch(`${base}/control/hold`, { method: "POST" })).status).toBe(204);
    expect(await held()).toBe(false);

    let settled = false;
    const pending = completion().then((response) => {
      settled = true;
      return response;
    });
    await expect.poll(held).toBe(true);
    expect(settled).toBe(false);

    const release = await fetch(`${base}/control/release?outcome=success`, { method: "POST" });
    expect(release.status).toBe(204);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      choices: [{ message: { content: MEETING_FIXTURE_LATE_REPLY } }]
    });
    expect(await held()).toBe(false);

    const next = await completion();
    expect(await next.json()).toMatchObject({
      choices: [{ message: { content: MEETING_FIXTURE_REPLY } }]
    });
  });

  it("fails a held turn with a provider error when released as a failure", async () => {
    const { base, completion, held } = await start();
    await fetch(`${base}/control/hold`, { method: "POST" });
    const pending = completion();
    await expect.poll(held).toBe(true);

    expect(
      (await fetch(`${base}/control/release?outcome=failure`, { method: "POST" })).status
    ).toBe(204);
    const response = await pending;
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain(MEETING_FIXTURE_LATE_REPLY);
  });

  it("does not hold setup probes, and refuses a release with nothing held", async () => {
    const { base, completion, held } = await start();
    await fetch(`${base}/control/hold`, { method: "POST" });
    expect((await completion("provider probe")).status).toBe(200);
    expect(await held()).toBe(false);
    expect(
      (await fetch(`${base}/control/release?outcome=success`, { method: "POST" })).status
    ).toBe(409);
    expect(
      (await fetch(`${base}/control/release?outcome=sideways`, { method: "POST" })).status
    ).toBe(400);
  });
});

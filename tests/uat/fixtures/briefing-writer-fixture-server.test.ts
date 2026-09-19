import { afterEach, describe, expect, it } from "vitest";

import { HttpApiAdapter } from "../../../packages/ai/src/adapters/http-api.js";

import {
  BRIEFING_WRITER_PROSE,
  buildBriefingWriterResponse,
  startBriefingWriterFixtureServer
} from "./briefing-writer-fixture-server.js";

// Fail-first cover for the p8 briefing-writer stand-in. The server is the
// only thing standing between synthesis and the fallback dump, so these
// prove it answers through the real product adapter with byte-identical
// prose, not just that it listens.

describe("startBriefingWriterFixtureServer", () => {
  let stop: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  it("returns the same fixed prose for different prompts", async () => {
    const server = await startBriefingWriterFixtureServer({ host: "127.0.0.1" });
    stop = server.stop;

    const first = await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "uat-briefing-writer-fixture-model",
        messages: [{ role: "user", content: "Write the morning briefing." }]
      })
    });
    const second = await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "uat-briefing-writer-fixture-model",
        messages: [
          { role: "user", content: "Write the evening briefing about something else entirely." }
        ]
      })
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstText = await first.text();
    expect(await second.text()).toBe(firstText);
    expect(JSON.parse(firstText)).toEqual(JSON.parse(buildBriefingWriterResponse("{}").body));
  });

  it("answers through the real product chat adapter", async () => {
    const server = await startBriefingWriterFixtureServer({ host: "127.0.0.1" });
    stop = server.stop;

    const adapter = new HttpApiAdapter("openai-compatible", "uat-fixture-not-a-real-key", {
      baseUrl: server.baseUrl
    });
    const first = await adapter.generateChat({
      model: {
        provider_kind: "openai-compatible",
        provider_model_id: "uat-briefing-writer-fixture-model"
      },
      messages: [{ role: "user", content: "Write the morning briefing." }]
    });
    const second = await adapter.generateChat({
      model: {
        provider_kind: "openai-compatible",
        provider_model_id: "uat-briefing-writer-fixture-model"
      },
      messages: [{ role: "user", content: "Something completely different." }]
    });
    expect(first.text).toBe(BRIEFING_WRITER_PROSE);
    expect(second.text).toBe(BRIEFING_WRITER_PROSE);
  });

  it("serves prose shaped like a briefing, with nothing that can vary", async () => {
    const [headline, paragraph] = BRIEFING_WRITER_PROSE.split("\n\n");
    expect(headline).toMatch(/\.$/);
    expect((paragraph ?? "").length).toBeGreaterThan(headline?.length ?? 0);
    // No years, times, counts or links: anything run-derived here would make
    // two captures of the same card differ for no product reason.
    expect(BRIEFING_WRITER_PROSE).not.toMatch(/\d/);
    expect(BRIEFING_WRITER_PROSE).not.toContain("http");
  });

  it("400s on an invalid JSON body instead of answering", async () => {
    const server = await startBriefingWriterFixtureServer({ host: "127.0.0.1" });
    stop = server.stop;

    const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "this is not json"
    });
    expect(response.status).toBe(400);
  });

  it("404s loudly, naming the path, for anything outside the chat route", async () => {
    const server = await startBriefingWriterFixtureServer({ host: "127.0.0.1" });
    stop = server.stop;

    const response = await fetch(`${server.baseUrl}/v1/models`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("/v1/models");
  });
});

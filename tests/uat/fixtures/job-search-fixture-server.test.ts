import { afterEach, describe, expect, it } from "vitest";

import { parseScoreResult } from "../../../external-modules/job-search/src/domain/score.js";

import {
  buildChatCompletionsResponse,
  deterministicFixtureScore,
  startJobSearchFixtureServer
} from "./job-search-fixture-server.js";

describe("startJobSearchFixtureServer", () => {
  let stop: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  it("serves the freehire capture as JSON at /__data.json, ignoring query strings", async () => {
    const server = await startJobSearchFixtureServer({ host: "127.0.0.1" });
    stop = server.stop;

    const response = await fetch(`${server.baseUrl}/__data.json?p=3&region=worldwide`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    const body = await response.json();
    expect(body.type).toBe("data");
  });

  it("serves the synthetic auth-wall capture as HTML at the guest search path", async () => {
    // Deliberately the auth-wall body, not a happy-path capture — see buildRoutes()'s header
    // comment. This makes Task 22's UAT spec able to rely on LinkedIn being degraded from its
    // very first crawl, with freehire left as the sole happy-path source in UAT.
    const server = await startJobSearchFixtureServer({ host: "127.0.0.1" });
    stop = server.stop;

    const response = await fetch(
      `${server.baseUrl}/jobs-guest/jobs/api/seeMoreJobPostings/search?start=25`
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/html/);
    const body = await response.text();
    expect(body.toLowerCase()).toContain("sign in to linkedin");
  });

  it("404s loudly, naming the path, for anything not in the route table", async () => {
    const server = await startJobSearchFixtureServer({ host: "127.0.0.1" });
    stop = server.stop;

    const response = await fetch(`${server.baseUrl}/not-a-real-route`);
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toContain("/not-a-real-route");
  });

  it("stop() actually closes the listener", async () => {
    const server = await startJobSearchFixtureServer({ host: "127.0.0.1" });
    await server.stop();
    stop = undefined;

    await expect(fetch(`${server.baseUrl}/__data.json`)).rejects.toThrow();
  });

  // N42 (#57): the scoring stage's fake `openai-compatible` provider posts here — see
  // tests/uat/seed/chunks/job-search-ai.ts. These assertions shape-match
  // packages/ai/src/adapters/http-api-structured.ts's extractStructuredResult exactly, since a
  // divergence here would only show up as an opaque "provider_error" deep in a real UAT run.
  describe("POST /v1/chat/completions (N42 fake AI provider)", () => {
    it("answers with an OpenAI-shaped response whose content is a valid SCORE_SCHEMA object", async () => {
      const server = await startJobSearchFixtureServer({ host: "127.0.0.1" });
      stop = server.stop;

      const prompt = [
        "Read one job posting against one person and answer two separate questions.",
        "--- POSTING ---",
        "Senior Backend Engineer at Freehire — Remote",
        "Build the thing."
      ].join("\n");
      const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer uat-fixture-not-a-real-key"
        },
        body: JSON.stringify({
          model: "uat-job-search-fixture-model",
          max_tokens: 1024,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_schema", json_schema: { name: "structured_output" } }
        })
      });
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(typeof payload.choices[0].message.content).toBe("string");
      const scored = parseScoreResult(JSON.parse(payload.choices[0].message.content));
      expect(scored.fitDisposition).toBe("supported");
      expect(Number.isInteger(scored.fit)).toBe(true);
      expect(scored.fit).toBeGreaterThanOrEqual(0);
      expect(scored.fit).toBeLessThanOrEqual(100);
      expect(Number.isInteger(scored.want)).toBe(true);
      expect(typeof scored.fitReason).toBe("string");
      expect(scored.fitReason.length).toBeGreaterThan(0);
      expect(typeof payload.usage.prompt_tokens).toBe("number");
      expect(typeof payload.usage.completion_tokens).toBe("number");
    });

    it("is deterministic per posting title and varies fit/want across two different postings", async () => {
      const server = await startJobSearchFixtureServer({ host: "127.0.0.1" });
      stop = server.stop;

      const scoreFor = async (title: string) => {
        const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: [
              { role: "user", content: `--- POSTING ---\n${title} at Acme — Remote\nbody` }
            ]
          })
        });
        const payload = await response.json();
        return JSON.parse(payload.choices[0].message.content);
      };

      const first = await scoreFor("Senior Backend Engineer");
      const firstAgain = await scoreFor("Senior Backend Engineer");
      const second = await scoreFor("Staff Product Designer");

      expect(first).toEqual(firstAgain); // same title -> same score, every call
      expect(first.fit === second.fit && first.want === second.want).toBe(false);
    });

    it("400s with a readable body on malformed JSON instead of crashing the listener", async () => {
      const server = await startJobSearchFixtureServer({ host: "127.0.0.1" });
      stop = server.stop;

      const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json"
      });
      expect(response.status).toBe(400);
    });
  });

  describe("deterministicFixtureScore / buildChatCompletionsResponse (pure helpers)", () => {
    it("returns a value in [55, 94] for both axes", () => {
      for (const axis of ["fit", "want"] as const) {
        const value = deterministicFixtureScore("Any Title At All", axis);
        expect(value).toBeGreaterThanOrEqual(55);
        expect(value).toBeLessThanOrEqual(94);
      }
    });

    it("fit and want salts diverge for the same title", () => {
      const title = "Principal Engineer";
      expect(deterministicFixtureScore(title, "fit")).not.toBe(
        deterministicFixtureScore(title, "want")
      );
    });

    it("falls back to scoring the whole prompt text when no POSTING marker is present", () => {
      const { status, body } = buildChatCompletionsResponse(
        JSON.stringify({ messages: [{ role: "user", content: "no marker here" }] })
      );
      expect(status).toBe(200);
      const parsed = JSON.parse(JSON.parse(body).choices[0].message.content);
      expect(typeof parsed.fit).toBe("number");
    });
  });
});

import {
  newsFeedbackFixtureBaseUrlFor,
  startNewsFeedbackFixtureContainer,
  removeNewsFeedbackFixtureContainer
} from "../uat/fixtures/news-feedback-fixture-container.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import type { NewsSnapshotPayload } from "../../packages/news/src/personalization-domain.js";
import {
  newsFeedbackModelResponse,
  newsFeedbackRss,
  startNewsFeedbackFixtureServer
} from "../uat/fixtures/news-feedback-fixture-server.js";

describe("authentic News feedback input protocol", () => {
  it("emits fresh declared synthetic RSS input on the UAT clock", () => {
    const now = new Date("2026-10-11T03:00:00.000Z");
    const rss = newsFeedbackRss(now);
    expect(rss).toContain(now.toUTCString());
    expect(rss.match(/<item>/g)).toHaveLength(12);
    expect(rss).toContain("Declared synthetic audit story");
    expect(rss).not.toContain("2026-09-15");
  });
  it("models ranking IDs from the compiler request instead of inventing a Moss snapshot", () => {
    const result = newsFeedbackModelResponse(
      JSON.stringify({ messages: [{ content: 'Candidates: [{"id":"c1"},{"id":"c2"}]' }] })
    );
    expect(result.status).toBe(200);
    const response = JSON.parse(result.body);
    expect(JSON.parse(response.choices[0].message.content)).toEqual({
      rankings: [
        { id: "c1", relevance: 100, eligible: true },
        { id: "c2", relevance: 99, eligible: true }
      ]
    });
    expect(result.body).not.toContain("snapshot");
  });
  it("rejects malformed or unrelated model requests", () => {
    expect(newsFeedbackModelResponse("invalid").status).toBe(400);
    expect(newsFeedbackModelResponse('{"messages":[{"content":"unrelated"}]}').status).toBe(400);
  });
});

// Runtime/compiler checks are deliberately pure: persistence is mocked, no SQL or DB connection.
// The isolated gated UAT remains responsible for proving real repository/CAS and overview targets.
const persistence = vi.hoisted(() => ({
  beginRefreshRun: vi.fn(),
  listCustomSources: vi.fn(),
  listCustomTopics: vi.fn(),
  listExclusions: vi.fn(),
  readLatestSnapshot: vi.fn(),
  publishSnapshotIfCurrent: vi.fn(),
  prefs: vi.fn()
}));
vi.mock("@moss/news", () => ({
  NewsPrefsRepository: class {
    list = persistence.prefs;
  }
}));
vi.mock("../../packages/news/src/personalization-repository.js", () => ({
  NewsPersonalizationRepository: class {
    beginRefreshRun = persistence.beginRefreshRun;
    listCustomSources = persistence.listCustomSources;
    listCustomTopics = persistence.listCustomTopics;
    listExclusions = persistence.listExclusions;
    readLatestSnapshot = persistence.readLatestSnapshot;
    publishSnapshotIfCurrent = persistence.publishSnapshotIfCurrent;
  }
}));

const { seedNewsFeedbackFixture } = await import("../uat/seed/chunks/news-feedback-fixture.js");

describe("News fixture socket and production compiler runtime (mock persistence)", () => {
  let fixture: Awaited<ReturnType<typeof startNewsFeedbackFixtureServer>> | undefined;
  const scopedDb = {} as DataContextDb;
  const run = vi.fn(async <T>(context: AccessContext, work: (db: DataContextDb) => Promise<T>) => {
    expect(context).toEqual({ actorUserId: "fixture-owner" });
    return work(scopedDb);
  });
  const runner = { withDataContext: run } as unknown as DataContextRunner;
  beforeEach(() => {
    vi.clearAllMocks();
    persistence.beginRefreshRun.mockResolvedValue(7);
    persistence.listCustomSources.mockResolvedValue([]);
    persistence.listCustomTopics.mockResolvedValue([]);
    persistence.listExclusions.mockResolvedValue([]);
    persistence.prefs.mockResolvedValue([]);
    persistence.publishSnapshotIfCurrent.mockImplementation(async (_db, _generation, snapshot) => {
      persistence.readLatestSnapshot.mockResolvedValue(snapshot);
      return true;
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture?.stop();
    fixture = undefined;
  });
  it("serves only RSS/model inputs and rejects Moss API paths", async () => {
    fixture = await startNewsFeedbackFixtureServer();
    const baseUrl = `http://127.0.0.1:${fixture.port}`;
    const rss = await fetch(`${baseUrl}/rss`);
    expect(rss.status).toBe(200);
    expect(rss.headers.get("content-type")).toBe("application/rss+xml");
    expect((await rss.text()).match(/<item>/g)).toHaveLength(12);
    const model = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ messages: [{ content: '[{"id":"c1"}]' }] })
    });
    expect(model.status).toBe(200);
    expect(await fetch(`${baseUrl}/api/news/overview`).then((response) => response.status)).toBe(
      404
    );
    expect(
      await fetch(`${baseUrl}/api/me/usefulness-feedback`).then((response) => response.status)
    ).toBe(404);
  });
  it("imports the seed and compiles fresh candidate IDs into valid snapshot/CAS arguments", async () => {
    fixture = await startNewsFeedbackFixtureServer();
    const baseUrl = `http://127.0.0.1:${fixture.port}`;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await seedNewsFeedbackFixture(runner, "fixture-owner", baseUrl);
    expect(run).toHaveBeenCalledOnce();
    expect(persistence.beginRefreshRun).toHaveBeenCalledWith(scopedDb);
    expect(persistence.publishSnapshotIfCurrent).toHaveBeenCalledWith(
      scopedDb,
      7,
      expect.objectContaining({ compiledAt: expect.any(Date), expiresAt: expect.any(Date) })
    );
    const snapshot = persistence.publishSnapshotIfCurrent.mock.calls[0]![2] as {
      compiledAt: Date;
      expiresAt: Date;
      payload: NewsSnapshotPayload;
    };
    expect(snapshot.payload.articles).toHaveLength(12);
    expect(snapshot.payload.articles[0]).toEqual(
      expect.objectContaining({
        headline: "Declared synthetic audit story 1",
        canonicalDomain: "www.bbc.com",
        rank: 1
      })
    );
    expect(snapshot.expiresAt.getTime() - snapshot.compiledAt.getTime()).toBe(
      7 * 24 * 60 * 60 * 1000
    );
    expect(fetchSpy.mock.calls.some(([url]) => url === `${baseUrl}/rss`)).toBe(true);
    expect(
      fetchSpy.mock.calls.filter(([url]) => url === `${baseUrl}/v1/chat/completions`)
    ).toHaveLength(1);
  });
  it("fails rather than accepting malformed model rankings through fallback", async () => {
    fixture = await startNewsFeedbackFixtureServer();
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) =>
      String(url).endsWith("/v1/chat/completions")
        ? Promise.resolve(
            Response.json({ choices: [{ message: { content: '{"unexpected":true}' } }] })
          )
        : realFetch(url, init)
    );
    await expect(
      seedNewsFeedbackFixture(runner, "fixture-owner", `http://127.0.0.1:${fixture.port}`)
    ).rejects.toThrow("News fixture ranking did not use its declared model input");
  });
  it("fails when the production CAS reports a superseding generation", async () => {
    fixture = await startNewsFeedbackFixtureServer();
    persistence.publishSnapshotIfCurrent.mockResolvedValue(false);
    await expect(
      seedNewsFeedbackFixture(runner, "fixture-owner", `http://127.0.0.1:${fixture.port}`)
    ).rejects.toThrow("News fixture compile did not publish: stale");
  });
  it("fails instead of counting a model failure's deterministic ranking fallback as fixture proof", async () => {
    fixture = await startNewsFeedbackFixtureServer();
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) =>
      String(url).endsWith("/v1/chat/completions")
        ? Promise.resolve(new Response("Invalid model response", { status: 503 }))
        : realFetch(url, init)
    );
    await expect(
      seedNewsFeedbackFixture(runner, "fixture-owner", `http://127.0.0.1:${fixture.port}`)
    ).rejects.toThrow("News fixture compile did not publish: kept_last_good");
  });
});

describe("News fixture container lifecycle", () => {
  it("uses the isolated stack network and waits for server readiness before returning", async () => {
    const docker = {
      runCommand: vi.fn().mockResolvedValue(undefined),
      runCapture: vi.fn().mockResolvedValue("[news-feedback-fixture] listening on 4319")
    };
    await startNewsFeedbackFixtureContainer("fixture-proj", docker);
    expect(docker.runCommand).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining([
        "--detach",
        "--name",
        "fixture-proj-newsfixture",
        "--network",
        "fixture-proj_jarv1s",
        "node",
        "--import",
        "tsx",
        "tests/uat/fixtures/news-feedback-fixture-cli.ts"
      ])
    );
    expect(docker.runCapture).toHaveBeenCalledWith("docker", ["logs", "fixture-proj-newsfixture"]);
    expect(newsFeedbackFixtureBaseUrlFor("fixture-proj")).toBe(
      "http://fixture-proj-newsfixture:4319"
    );
    await removeNewsFeedbackFixtureContainer("fixture-proj", docker);
    expect(docker.runCommand).toHaveBeenLastCalledWith("docker", [
      "rm",
      "--force",
      "fixture-proj-newsfixture"
    ]);
  });
  it("makes removal idempotent when the container is already absent", async () => {
    await expect(
      removeNewsFeedbackFixtureContainer("fixture-proj", {
        runCommand: vi.fn().mockRejectedValue(new Error("No such container")),
        runCapture: vi.fn()
      })
    ).resolves.toBeUndefined();
  });
});

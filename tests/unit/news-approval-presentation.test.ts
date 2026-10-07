import { beforeEach, describe, expect, it, vi } from "vitest";
import { dataContextBrand, type DataContextDb } from "@moss/db";
import type { ToolContext } from "@moss/module-sdk";
import { configureNewsChatTools } from "../../packages/news/src/chat-tools.js";
import {
  createPreviewStore,
  type VerifiedSourceCandidate
} from "../../packages/news/src/discovery/preview-store.js";
import type { NewsPersonalizationStore } from "../../packages/news/src/personalization-routes.js";
import { newsModuleManifest } from "../../packages/news/src/manifest.js";
import {
  newsImagePresentation,
  newsFaviconPresentation,
  newsAddTopicPresentation,
  newsConfirmPresentation,
  newsExclusionPresentation,
  newsRefreshPresentation,
  newsRemoveSourcePresentation,
  newsRemoveTopicPresentation
} from "../../packages/news/src/approval-presentation.js";

const db = { db: {}, [dataContextBrand]: true } as DataContextDb;
const ctx = { actorUserId: "owner", requestId: "request", chatSessionId: "chat" } as ToolContext;
let now: number;
let previews: ReturnType<typeof createPreviewStore>;
const candidate: VerifiedSourceCandidate = {
  candidateId: "candidate-id",
  label: "Trusted wire",
  canonicalDomain: "news.example.com",
  homepageUrl: "https://news.example.com",
  feedUrl: "https://news.example.com/feed",
  retrievalMethod: "feed",
  sampleCount: 3,
  validationFingerprint: "private-fingerprint",
  redirectNote: null,
  confirmedFetchHosts: ["news.example.com"],
  iconUrl: null,
  workaround: false,
  feedHost: null
};
const source = { id: "source-id", label: "Stored source", canonicalDomain: "source.example.com" };
const readSnapshot = vi.fn();
const topic = { id: "topic-id", label: "Stored topic" };
beforeEach(() => {
  now = 0;
  readSnapshot.mockReset().mockResolvedValue({
    compiledAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    payload: {
      articles: [
        {
          id: "article-id",
          publisher: "Publisher",
          canonicalDomain: "news.example.com",
          headline: "Full article headline",
          url: "https://news.example.com/article",
          publishedAt: new Date().toISOString(),
          excerpt: null,
          imageUrl: "https://images.example.com/picture.jpg",
          topics: [],
          preferred: true,
          rank: 1
        }
      ]
    }
  });
  previews = createPreviewStore({ now: () => now, ttlMs: 1000 });
  configureNewsChatTools({
    previews,
    discovery: {} as never,
    availability: {} as never,
    boss: null,
    repository: {
      listCustomSources: vi.fn().mockResolvedValue([source]),
      listCustomTopics: vi.fn().mockResolvedValue([topic]),
      readLatestSnapshot: readSnapshot
    } as unknown as NewsPersonalizationStore
  });
});
function pending() {
  return previews.put({
    ownerUserId: "owner",
    candidates: [candidate],
    replaceSourceId: null,
    createdAt: now
  });
}

describe("News approval presentations", () => {
  it("covers all six existing mutating tools with explicit titles and hooks", () => {
    const writes = newsModuleManifest.assistantTools.filter((tool) => tool.risk !== "read");
    expect(writes).toHaveLength(6);
    for (const tool of writes) {
      expect("approvalPresentation" in tool).toBe(true);
      expect("actionLabel" in tool).toBe(true);
    }
  });
  it("discloses the exact stored preview label and domain without consuming it or leaking its internal references", async () => {
    const confirmationId = pending();
    const input = {
      confirmationId,
      candidateId: candidate.candidateId,
      label: candidate.label,
      domain: candidate.canonicalDomain
    };
    const first = await newsConfirmPresentation(db, input, ctx);
    expect(first?.target).toBe(candidate.label);
    expect(first?.fields).toEqual([
      { label: "Publisher", value: candidate.label },
      { label: "Domain", value: candidate.canonicalDomain }
    ]);
    expect(await newsConfirmPresentation(db, input, ctx)).toEqual(first);
    expect(JSON.stringify(first)).not.toContain(confirmationId);
    expect(JSON.stringify(first)).not.toContain(candidate.validationFingerprint);
    expect(previews.take("owner", confirmationId)).not.toBeNull();
    expect(await newsConfirmPresentation(db, input, ctx)).toBeNull();
  });
  it("refuses foreign, expired, tampered, ambiguous or undeclared preview values", async () => {
    const confirmationId = pending();
    const input = { confirmationId, label: candidate.label, domain: candidate.canonicalDomain };
    expect(await newsConfirmPresentation(db, input, { ...ctx, actorUserId: "other" })).toBeNull();
    expect(await newsConfirmPresentation(db, { ...input, label: "Spoof" }, ctx)).toBeNull();
    expect(await newsConfirmPresentation(db, { ...input, hidden: "value" }, ctx)).toBeNull();
    now = 1001;
    expect(await newsConfirmPresentation(db, input, ctx)).toBeNull();
    const ambiguous = previews.put({
      ownerUserId: "owner",
      candidates: [candidate, { ...candidate, candidateId: "other" }],
      replaceSourceId: null,
      createdAt: now
    });
    expect(
      await newsConfirmPresentation(db, { ...input, confirmationId: ambiguous }, ctx)
    ).toBeNull();
  });
  it("returns an immutable-to-the-store peek snapshot", () => {
    const id = pending();
    const snapshot = previews.peek("owner", id)!;
    (snapshot.candidates[0] as { label: string }).label = "Mutated";
    expect(previews.peek("owner", id)?.candidates[0]?.label).toBe(candidate.label);
    expect(previews.peek("other", id)).toBeNull();
  });
  it("discloses publisher credential deletion and saved briefing pruning", async () => {
    const view = await newsRemoveSourcePresentation(db, { sourceId: source.id }, ctx);
    expect(view?.fields).toContainEqual({
      label: "Saved credentials",
      value: "Delete any saved credentials for this publisher"
    });
    expect(view?.fields).toContainEqual({
      label: "Saved briefings",
      value: "Remove articles from this publisher and its subdomains"
    });
  });
  it("resolves source/topic references from the same scoped store as execution", async () => {
    expect((await newsRemoveSourcePresentation(db, { sourceId: source.id }, ctx))?.target).toBe(
      source.label
    );
    expect((await newsRemoveTopicPresentation(db, { topicId: topic.id }, ctx))?.target).toBe(
      topic.label
    );
    expect(await newsRemoveSourcePresentation(db, { sourceId: "missing" }, ctx)).toBeNull();
    expect(
      await newsRemoveTopicPresentation(db, { topicId: topic.id, hidden: "value" }, ctx)
    ).toBeNull();
  });
  it("preserves exact submitted labels and shows normalized exclusion scope", async () => {
    expect(await newsRefreshPresentation(db, {}, ctx)).toEqual({
      target: "Your news feed",
      fields: []
    });
    expect(await newsRefreshPresentation(db, { hidden: "value" }, ctx)).toBeNull();
    const label = "  Topic <b>text</b>  ";
    expect((await newsAddTopicPresentation(db, { label }, ctx))?.fields).toEqual([
      { label: "Topic", value: label }
    ]);
    expect(
      await newsAddTopicPresentation(db, { label, guidance: "Hidden instructions" }, ctx)
    ).toBeNull();
    expect(
      (await newsExclusionPresentation(db, { domain: "news.example.com" }, ctx))?.fields
    ).toContainEqual({ label: "Subdomains", value: "Also excluded" });
  });
  it("discloses outbound image and icon targets from the same approved server records", async () => {
    const image = await newsImagePresentation(
      db,
      { params: { articleId: "article-id" }, target: null },
      ctx
    );
    expect(image?.target).toBe("Full article headline");
    expect(image?.fields).toContainEqual({ label: "Image host", value: "images.example.com" });
    expect(JSON.stringify(image)).not.toContain("article-id");
    const icon = await newsFaviconPresentation(
      db,
      { params: { domain: source.canonicalDomain }, target: null },
      ctx
    );
    expect(icon?.target).toBe(source.label);
    expect(
      await newsFaviconPresentation(
        db,
        { params: { domain: "unknown.example.com" }, target: null },
        ctx
      )
    ).toBeNull();
    expect(
      await newsImagePresentation(db, { params: { articleId: "missing" }, target: null }, ctx)
    ).toBeNull();
    expect(
      await newsImagePresentation(
        db,
        { params: { articleId: "article-id" }, query: { hidden: "value" }, target: null },
        ctx
      )
    ).toBeNull();
    readSnapshot.mockResolvedValue(null);
    expect(
      await newsImagePresentation(db, { params: { articleId: "article-id" }, target: null }, ctx)
    ).toBeNull();
  });
});

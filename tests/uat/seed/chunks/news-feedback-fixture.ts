import type { DataContextRunner } from "@moss/db";
import { NewsPrefsRepository } from "@moss/news";
import { NewsPersonalizationRepository } from "../../../../packages/news/src/personalization-repository.js";
import { assertSnapshotPayload } from "../../../../packages/news/src/personalization-domain.js";
import { compilePersonalizedNews } from "../../../../packages/news/src/compilation/compile.js";
import { NEWS_CATALOG } from "../../../../packages/news/src/source/catalog.js";

/** Opt-in only. Real owner-scoped compiler/repository writes use a declared RSS/model stand-in.
 * This seeds feedback input; it does not prove production refresh discovery or AI routing. */
export async function seedNewsFeedbackFixture(
  runner: DataContextRunner,
  actorUserId: string,
  baseUrl: string
) {
  const repo = new NewsPersonalizationRepository();
  await runner.withDataContext({ actorUserId }, async (db) => {
    const generation = await repo.beginRefreshRun(db);
    let rankingFallback = false;
    let modelResponses = 0;
    const outcome = await compilePersonalizedNews(
      db,
      {
        repo,
        prefs: new NewsPrefsRepository(),
        catalog: NEWS_CATALOG.filter((source) => source.sourceKey === "bbc"),
        fetch: async (url) => {
          const response = await fetch(`${baseUrl}/rss`, { signal: AbortSignal.timeout(10_000) });
          if (!response.ok) return { ok: false, reason: "http_error", status: response.status };
          return {
            ok: true,
            status: response.status,
            finalUrl: url,
            contentType: response.headers.get("content-type"),
            body: await response.text(),
            truncated: false
          };
        },
        search: { search: async () => ({ results: [] }) },
        ai: {
          fingerprint: async () => "uat-news-feedback-scripted-model",
          generateJson: async (_db, input) => {
            const response = await fetch(`${baseUrl}/v1/chat/completions`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ messages: [{ role: "user", content: input.prompt }] }),
              signal: AbortSignal.timeout(10_000)
            });
            if (!response.ok) throw new Error(`News fixture model returned ${response.status}`);
            const result = (await response.json()) as {
              choices: Array<{ message: { content: string } }>;
            };
            const object: unknown = JSON.parse(result.choices[0]!.message.content);
            modelResponses += 1;
            return { ok: true, object };
          }
        },
        logger: {
          info: () => undefined,
          warn: (fields) => {
            if (fields.event === "news_compile_ai_fallback") rankingFallback = true;
          }
        }
      },
      { now: new Date(), generation, ownerUserId: actorUserId }
    );
    if (outcome.outcome !== "replaced")
      throw new Error(`News fixture compile did not publish: ${outcome.outcome}`);
    if (rankingFallback || modelResponses !== 1)
      throw new Error("News fixture ranking did not use its declared model input");
    const snapshot = await repo.readLatestSnapshot(db);
    if (snapshot) assertSnapshotPayload(snapshot.payload);
    if (
      !snapshot ||
      !Array.isArray(snapshot.payload.articles) ||
      snapshot.payload.articles.length === 0
    )
      throw new Error("News fixture compiled no stories");
  });
}

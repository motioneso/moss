// tests/integration/news-chat-tools-harness.ts
//
// Shared setup and helpers for the news chat tools integration tests (#2298).
// Split out of news-chat-tools.test.ts so each test file stays comfortably
// under the 1000-line limit. This is the same beforeAll/afterAll bootstrap and
// the same helper functions the tests were already using, moved into a class
// so two test files can share one copy instead of duplicating it.
import { expect } from "vitest";
import pg from "pg";
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";

import {
  AiRepository,
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry,
  type GatewaySessionRecord,
  type PlatformDiagnosticsService
} from "@moss/ai";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { createPgBossClient } from "@moss/jobs";
import { settingsModuleManifest } from "@moss/settings";

import { configureNewsChatTools } from "../../packages/news/src/chat-tools.js";
import { createPreviewStore } from "../../packages/news/src/discovery/preview-store.js";
import { newsModuleManifest } from "../../packages/news/src/manifest.js";
import { NewsPersonalizationRepository } from "../../packages/news/src/personalization-repository.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

export type McpResponse = {
  readonly result?: {
    readonly content?: readonly { readonly text?: string }[];
    readonly isError?: boolean;
  };
};

export const feed = `<?xml version="1.0"?><rss><channel><title>Example News</title><item><title>Verified publisher headline</title><link>https://example.com/story</link><pubDate>Fri, 11 Jul 2026 12:00:00 GMT</pubDate></item></channel></rss>`;

export function feedForRefresh(url: string): string {
  const host = new URL(url).hostname;
  const publisher = host.includes("bbci")
    ? "www.bbc.com"
    : host.includes("guardian")
      ? "www.theguardian.com"
      : "www.npr.org";
  return `<?xml version="1.0"?><rss><channel><item><title>Refresh test item from ${publisher}</title><link>https://${publisher}/story</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`;
}

/**
 * Gateway output is always `{ text }` (renderAndCap). For `externalContent`
 * tools the rendered JSON additionally sits HTML-escaped inside a
 * `<tool_result source="…">` trust envelope — strip + unescape + parse to get
 * the structured payload back for follow-up calls.
 */
export function parseToolText(result: unknown): Record<string, unknown> {
  const text = (result as { data?: { text?: string } }).data?.text;
  if (typeof text !== "string")
    throw new Error(`tool result has no text: ${JSON.stringify(result)}`);
  const inner = text
    .replace(/^<tool_result[^>]*>\n/, "")
    .replace(/\n<\/tool_result>$/, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  return JSON.parse(inner) as Record<string, unknown>;
}

export type PreviewPayload = {
  confirmationId: string;
  candidates: Array<{ candidateId: string; label: string; domain: string }>;
};

export class NewsChatToolsHarness {
  bootstrap!: pg.Client;
  appDb!: Kysely<MossDatabase>;
  workerDb!: Kysely<MossDatabase>;
  appContext!: DataContextRunner;
  workerContext!: DataContextRunner;
  appBoss!: PgBoss;
  workerBoss!: PgBoss;
  readonly newsRepository = new NewsPersonalizationRepository();

  configureChatTools(boss: PgBoss | null): void {
    // Same deferred-deps seam routes.ts uses at composition time: one shared
    // preview store, stubbed discovery/availability, and an optional real queue.
    configureNewsChatTools({
      previews: createPreviewStore(),
      discovery: {
        fetch: async (url: string) => ({
          ok: true as const,
          status: 200,
          finalUrl: url,
          contentType: "application/rss+xml",
          body: feed,
          truncated: false
        }),
        search: { search: async () => ({ results: [] }) },
        ai: {
          fingerprint: async () => "opaque-test-fingerprint",
          generateJson: async (_db: unknown, input: { prompt: string }) => ({
            ok: true as const,
            object: input.prompt.includes("news TOPIC")
              ? { allowed: true, category: "news_topic" }
              : { allowed: true, category: "news_publisher" }
          })
        }
      },
      availability: {
        hasJsonModel: async () => true,
        hasWebSearch: async () => true
      },
      boss,
      repository: this.newsRepository,
      credentials: { readStatuses: async () => [] }
    });
  }

  async setup(): Promise<void> {
    await resetFoundationDatabase();
    this.bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
    await this.bootstrap.connect();
    this.appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    this.workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 2 });
    this.appContext = new DataContextRunner(this.appDb);
    this.workerContext = new DataContextRunner(this.workerDb);
    this.appBoss = createPgBossClient(connectionStrings.app);
    this.workerBoss = createPgBossClient(connectionStrings.worker);
    await Promise.all([this.appBoss.start(), this.workerBoss.start()]);
    this.configureChatTools(null);
  }

  async teardown(): Promise<void> {
    await Promise.allSettled([
      this.bootstrap?.end(),
      this.appDb?.destroy(),
      this.workerDb?.destroy(),
      this.appBoss?.stop({ graceful: false }),
      this.workerBoss?.stop({ graceful: false })
    ]);
  }

  makeGateway(
    options: { diagnostics?: PlatformDiagnosticsService; boss?: PgBoss | null } = {}
  ) {
    this.configureChatTools(options.boss ?? null);
    const tokens = new SessionTokenRegistry();
    const emitted: GatewaySessionRecord[] = [];
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [
        newsModuleManifest,
        ...(options.diagnostics ? [settingsModuleManifest] : [])
      ],
      repository: new AiRepository(),
      runner: new DataContextRunner(this.appDb),
      tokens,
      confirmations: new ConfirmationRegistry(),
      notifier: { emit: (_session, record) => emitted.push(record) },
      confirmTimeoutMs: 5_000,
      readToolServices: options.diagnostics
        ? { platformDiagnostics: options.diagnostics }
        : undefined,
      toolServices: { writeOnly: { secret: "never passed to read tools" } }
    });
    const mint = (actorUserId: string, chatSessionId: string) =>
      tokens.mint({ actorUserId, chatSessionId, allowedToolNames: null });
    return { gateway, emitted, mint };
  }

  async previewExampleFeed(
    gateway: AssistantToolGateway,
    token: string
  ): Promise<PreviewPayload> {
    const result = await gateway.callTool(token, "news.previewSource", {
      source: "https://example.com/feed.xml"
    });
    expect(result).toMatchObject({ ok: true });
    const payload = parseToolText(result) as unknown as PreviewPayload;
    expect(typeof payload.confirmationId).toBe("string");
    expect(payload.candidates.length).toBeGreaterThan(0);
    return payload;
  }

  async waitForActionRequest(
    emitted: GatewaySessionRecord[],
    from: number
  ): Promise<Extract<GatewaySessionRecord, { kind: "action_request" }>> {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const record = emitted
        .slice(from)
        .find((entry): entry is Extract<GatewaySessionRecord, { kind: "action_request" }> => {
          return entry.kind === "action_request";
        });
      if (record) return record;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("action request never emitted");
  }

  async sourceRowCount(): Promise<number> {
    const rows = await this.bootstrap.query(`SELECT count(*)::int AS n FROM app.news_custom_sources`);
    return rows.rows[0].n as number;
  }

  async waitForAudit(where: {
    toolName: string;
    outcome: string;
    ownerUserId?: string;
  }): Promise<Record<string, unknown>> {
    // Audit writes are fire-and-forget — poll for the row. The optional owner
    // filter disambiguates when two actors exercised the same tool in one test.
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const audit = await this.bootstrap.query(
        `SELECT owner_user_id, approval_mode, outcome, tool_name
         FROM app.moss_action_audit_log
         WHERE tool_name = $1 AND outcome = $2
           AND ($3::uuid IS NULL OR owner_user_id = $3::uuid)`,
        [where.toolName, where.outcome, where.ownerUserId ?? null]
      );
      if (audit.rowCount) return audit.rows[0] as Record<string, unknown>;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`audit row not written for ${where.toolName}/${where.outcome}`);
  }

  async waitForRefreshSuccess(requestId: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = await this.appContext.withDataContext({ actorUserId: ids.userA, requestId }, (db) =>
        this.newsRepository.readRefreshState(db)
      );
      if (state.state === "idle" && state.lastSuccessAt) return;
      if (attempt === 99) throw new Error("news refresh worker did not complete successfully");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async waitForPendingAction(ownerUserId: string, toolName: string): Promise<string> {
    const repository = new AiRepository();
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const actions = await this.appContext.withDataContext(
        { actorUserId: ownerUserId, requestId: `wait-pending-${attempt}` },
        (db) => repository.listAssistantActions(db)
      );
      const action = actions.find(
        (entry) => entry.status === "pending" && entry.tool_name === toolName
      );
      if (action) return action.id;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`no pending action request appeared for ${toolName}`);
  }

  async listActorAudits(ownerUserId: string): Promise<readonly unknown[]> {
    return this.appContext.withDataContext(
      { actorUserId: ownerUserId, requestId: `list-audits-${ownerUserId}` },
      (db) => new AiRepository().listActionAuditLog(db, { since: new Date(0), limit: 100 })
    );
  }
}

import Fastify, { type FastifyInstance } from "fastify";
import type { Kysely } from "kysely";

import {
  DataContextRunner,
  type AccessContext,
  type DataContextDb,
  type MossDatabase,
  type UsefulnessFeedbackSignal
} from "@moss/db";
import type { StoryFeedbackModule } from "@moss/shared";
import { ManualMemoryCandidateService } from "../../packages/memory/src/index.js";
import {
  buildStoryTargetContext,
  createStoryFeedbackTargetVerifier,
  FeedbackTargetVerifierRegistry,
  registerUsefulnessFeedbackRoutes,
  storyFeedbackTargetRef,
  STORY_TARGET_KIND_BY_MODULE,
  type FeedbackTargetVerifier,
  type FeedbackTargetVerification
} from "../../packages/usefulness-feedback/src/index.js";
import { UsefulnessFeedbackRepository } from "../../packages/usefulness-feedback/src/repository.js";

import { ids } from "./test-database.js";

/**
 * Shared setup for the usefulness feedback integration tests. It lives beside them rather than
 * inside either test file because the story cases and the original cases both need the same
 * server, and the repository caps a source file at 1000 lines.
 */

export function userAHeaders(): Record<string, string> {
  return { authorization: "Bearer user-a" };
}

export function userBHeaders(): Record<string, string> {
  return { authorization: "Bearer user-b" };
}

export function userAContext(): AccessContext {
  return { actorUserId: ids.userA, requestId: "req:feedback-a" };
}

export function userBContext(): AccessContext {
  return { actorUserId: ids.userB, requestId: "req:feedback-b" };
}

export interface FeedbackTestServerOptions {
  /** Who the server treats every request as coming from. Defaults to user A. */
  readonly access?: AccessContext;
  /** Collects everything the server logs, so a test can prove a reason never reaches a log line. */
  readonly logLines?: string[];
}

export async function buildFeedbackTestServer(
  appDb: Kysely<MossDatabase>,
  verifier?: FeedbackTargetVerifier,
  options: FeedbackTestServerOptions = {}
): Promise<{ server: FastifyInstance; dataContext: DataContextRunner }> {
  const dataContext = new DataContextRunner(appDb);
  const registry = new FeedbackTargetVerifierRegistry();
  registry.register(
    "chat_message",
    verifier ??
      (async (_scopedDb: DataContextDb, input): Promise<FeedbackTargetVerification | null> => ({
        ownerUserId: input.actorUserId,
        targetKind: input.targetKind,
        targetRef: input.targetRef,
        surface: input.surface,
        canRemember: false
      }))
  );
  // Story feedback goes through the real ownership check rather than a stand-in, so these tests
  // exercise the same code the running app uses: only a story the caller had registered passes.
  const storyVerifier = createStoryFeedbackTargetVerifier(new UsefulnessFeedbackRepository());
  registry.register("news_story", storyVerifier);
  registry.register("sports_story", storyVerifier);

  const logLines = options.logLines;
  const server = Fastify(
    logLines
      ? {
          logger: {
            level: "trace",
            stream: {
              write(chunk: string) {
                logLines.push(chunk);
              }
            }
          }
        }
      : { logger: false }
  );
  const access = options.access ?? userAContext();
  registerUsefulnessFeedbackRoutes(server, {
    dataContext,
    registry,
    manualMemoryCandidates: new ManualMemoryCandidateService(),
    resolveAccessContext: async () => access
  });
  await server.ready();
  return { server, dataContext };
}

export function rememberableVerifier(excerpt: string): FeedbackTargetVerifier {
  return async (_scopedDb, input) => ({
    ownerUserId: input.actorUserId,
    targetKind: input.targetKind,
    targetRef: input.targetRef,
    surface: input.surface,
    sourceKind: "chat",
    sourceLabel: "Chat",
    metadata: { role: "user" },
    canRemember: true,
    rememberExcerpt: excerpt
  });
}

/**
 * Registers a story the way News or Sports would, and hands back the opaque reference the API
 * expects. Without this row the ownership check refuses the story, which is the point.
 */
export async function registerStoryTarget(
  appDb: Kysely<MossDatabase>,
  input: {
    readonly ownerUserId: string;
    readonly moduleId: StoryFeedbackModule;
    readonly canonicalLink: string;
    readonly headline?: string;
  }
): Promise<string> {
  const repository = new UsefulnessFeedbackRepository();
  const dataContext = new DataContextRunner(appDb);
  const targetRef = storyFeedbackTargetRef(input.moduleId, input.canonicalLink);
  await dataContext.withDataContext(
    { actorUserId: input.ownerUserId, requestId: `req:story-${input.moduleId}` },
    (scopedDb) =>
      repository.upsertTarget(scopedDb, {
        ownerUserId: input.ownerUserId,
        targetKind: STORY_TARGET_KIND_BY_MODULE[input.moduleId],
        targetRef,
        surface: input.moduleId,
        sourceKind: input.moduleId,
        sourceLabel: input.moduleId === "news" ? "News" : "Sports",
        metadata: buildStoryTargetContext({
          moduleId: input.moduleId,
          headline: input.headline ?? null
        })
      })
  );
  return targetRef;
}

export function storyPayload(
  moduleId: StoryFeedbackModule,
  targetRef: string,
  kind: "more_like_this" | "less_like_this",
  reason?: string
): Record<string, unknown> {
  return {
    targetKind: STORY_TARGET_KIND_BY_MODULE[moduleId],
    targetRef,
    surface: moduleId,
    kind,
    ...(reason === undefined ? {} : { reason })
  };
}

/** Every stored signal for one story, read as its owner. */
export async function storySignalRows(
  appDb: Kysely<MossDatabase>,
  targetRef: string,
  ownerUserId: string = ids.userA
): Promise<UsefulnessFeedbackSignal[]> {
  const dataContext = new DataContextRunner(appDb);
  return dataContext.withDataContext(
    { actorUserId: ownerUserId, requestId: "req:story-rows" },
    (scopedDb) =>
      scopedDb.db
        .selectFrom("app.usefulness_feedback_signals")
        .selectAll()
        .where("owner_user_id", "=", ownerUserId)
        .where("target_ref", "=", targetRef)
        .orderBy("created_at")
        .orderBy("id")
        .execute()
  );
}

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PgBoss } from "pg-boss";

import type { DatasetClient } from "@moss/datasets";
import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import { HttpError, handleRouteError } from "@moss/module-sdk";
import {
  createNewsPrefResponseSchema,
  deleteNewsPrefResponseSchema,
  newsCatalogResponseSchema,
  newsOverviewResponseSchema,
  newsPrefsResponseSchema,
  type CreateNewsPrefRequest,
  type NewsPrefDto,
  type NewsSourcePreviewResponse
} from "@moss/shared";

import { configureNewsChatTools } from "./chat-tools.js";
import { createPreviewStore } from "./discovery/preview-store.js";
import { NewsPrefsRepository } from "./repository.js";
import { NewsService, type NewsPrefsReader } from "./news-service.js";
import type {
  NewsAiPort,
  NewsImageFetchPort,
  NewsSafeFetchPort,
  NewsWebSearchPort
} from "./discovery/ports.js";
import type { NewsCredentialCipherPort } from "./credential-cipher-port.js";
import type { NewsCredentialStore } from "./credential-repository.js";
import { registerNewsCredentialRoutes } from "./credential-routes.js";
import { registerNewsImageRoute } from "./image-route.js";
import {
  createEmptyNewsPublisherConnectionPort,
  type NewsPublisherConnectionPort
} from "./publisher-connection-port.js";
import {
  registerNewsPersonalizationRoutes,
  triggerNewsRefresh,
  type NewsPersonalizationStore
} from "./personalization-routes.js";
import { NewsPersonalizationRepository } from "./personalization-repository.js";
import { sourceEntry, topicOption } from "./source/catalog.js";

/**
 * The prefs persistence surface the routes need. `NewsPrefsRepository` satisfies it; tests
 * inject a fake. (`NewsService` only reads via `NewsPrefsReader`; the CRUD routes also write.)
 */
export interface NewsPrefsWriter extends NewsPrefsReader {
  create(scopedDb: DataContextDb, input: CreateNewsPrefRequest): Promise<NewsPrefDto>;
  remove(scopedDb: DataContextDb, id: string): Promise<boolean>;
}

/**
 * #953: capability availability the personalization GET reports. News receives booleans only —
 * the composition root builds these from the public AI/Settings APIs (resolveModelForCapability
 * for `json`, Brave-key config presence) so News never imports foreign internals and no key or
 * model identity crosses this seam.
 */
export interface NewsPersonalizationAvailabilityPort {
  hasJsonModel(scopedDb: DataContextDb): Promise<boolean>;
  hasWebSearch(scopedDb: DataContextDb): Promise<boolean>;
}

export interface NewsRoutesDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  /**
   * The dataset-connector-SDK runtime client bound to the news module's `newsfeeds` external
   * source (composition root: packages/module-registry/src/index.ts).
   */
  readonly datasetClient: DatasetClient;
  /** #953: injected availability callbacks (see NewsPersonalizationAvailabilityPort). */
  readonly availability: NewsPersonalizationAvailabilityPort;
  readonly discovery: {
    readonly fetch: NewsSafeFetchPort;
    readonly image: NewsImageFetchPort;
    readonly search: NewsWebSearchPort;
    readonly ai: NewsAiPort;
  };
  readonly boss: PgBoss | null;
  /** Optional injection point for tests; defaults to a real `NewsPrefsRepository`. */
  readonly repository?: NewsPrefsWriter;
  /** Optional injection point for tests; defaults to a real `NewsPersonalizationRepository`. */
  readonly personalizationRepository?: NewsPersonalizationStore;
  /** #1110: UAT-only deterministic override for the source-preview route; see module-registry's buildUatNewsPreviewOverride(). */
  readonly previewOverride?: (input: string) => NewsSourcePreviewResponse | undefined;
  /**
   * #2005: the encryption seam for publisher access keys. Required, not optional: the
   * route guard rejects a manifest routes[] entry with no registered route, so the
   * credential routes must always register. News never resolves key material itself, so
   * the composition root supplies this.
   */
  readonly credentialCipher: NewsCredentialCipherPort;
  /**
   * #2005: the reviewed publisher connections. Defaults to the implementation that knows
   * no connections, so until #2007 lands every connect attempt answers "unsupported".
   */
  readonly publisherConnections?: NewsPublisherConnectionPort;
  /** Optional injection point for tests; defaults to a real `NewsCredentialRepository`. */
  readonly credentialRepository?: NewsCredentialStore;
}

/** POST /prefs key validation: the key must exist in the catalog for its kind. */
function isValidPrefKey(input: CreateNewsPrefRequest): boolean {
  if (input.kind === "topic") return topicOption(input.key) !== undefined;
  return sourceEntry(input.key) !== undefined;
}

export function registerNewsRoutes(
  server: FastifyInstance,
  dependencies: NewsRoutesDependencies
): void {
  const repository: NewsPrefsWriter = dependencies.repository ?? new NewsPrefsRepository();
  const personalization: NewsPersonalizationStore =
    dependencies.personalizationRepository ?? new NewsPersonalizationRepository();
  const service = new NewsService({
    datasetClient: dependencies.datasetClient,
    dataContext: dependencies.dataContext,
    repository,
    personalization
  });

  server.get("/api/news/catalog", { schema: newsCatalogResponseSchema }, async (request, reply) => {
    try {
      await dependencies.resolveAccessContext(request);
      return service.getCatalog();
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });

  server.get(
    "/api/news/overview",
    { schema: newsOverviewResponseSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        return await service.getOverview(accessContext, async (db) => {
          await triggerNewsRefresh(
            db,
            personalization,
            dependencies.boss,
            accessContext.actorUserId
          );
        });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get("/api/news/prefs", { schema: newsPrefsResponseSchema }, async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      const prefs = await dependencies.dataContext.withDataContext(accessContext, (db) =>
        repository.list(db)
      );
      return { prefs };
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });

  server.post(
    "/api/news/prefs",
    { schema: createNewsPrefResponseSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const input = request.body as CreateNewsPrefRequest;
        if (!isValidPrefKey(input)) {
          throw new HttpError(
            400,
            `Unknown ${input.kind === "topic" ? "topic" : "source"}: ${input.key}`
          );
        }
        const disabledSource = input.kind === "source_exclude" ? sourceEntry(input.key) : undefined;
        const pref = await dependencies.dataContext.withDataContext(accessContext, (db) =>
          repository.create(db, input).then(async (created) => {
            await triggerNewsRefresh(
              db,
              personalization,
              dependencies.boss,
              accessContext.actorUserId,
              disabledSource
                ? () =>
                    personalization.pruneSnapshotDomain(
                      db,
                      new URL(disabledSource.homepageUrl).hostname
                    )
                : undefined
            );
            return created;
          })
        );
        return { pref };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.delete(
    "/api/news/prefs/:id",
    { schema: deleteNewsPrefResponseSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const { id } = request.params as { id: string };
        const ok = await dependencies.dataContext.withDataContext(accessContext, async (db) => {
          const removed = await repository.remove(db, id);
          if (removed) {
            await triggerNewsRefresh(
              db,
              personalization,
              dependencies.boss,
              accessContext.actorUserId
            );
          }
          return removed;
        });
        return { ok };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  // #975 Slice 4: ONE preview store shared by the REST routes and the chat tools,
  // so a source previewed in chat can be confirmed in Settings and vice versa.
  const previews = createPreviewStore();
  configureNewsChatTools({
    previews,
    discovery: {
      fetch: dependencies.discovery.fetch,
      search: dependencies.discovery.search,
      ai: dependencies.discovery.ai
    },
    availability: dependencies.availability,
    boss: dependencies.boss,
    repository: personalization
  });
  registerNewsPersonalizationRoutes(server, {
    dataContext: dependencies.dataContext,
    resolveAccessContext: dependencies.resolveAccessContext,
    availability: dependencies.availability,
    discovery: dependencies.discovery,
    boss: dependencies.boss,
    repository: personalization,
    previews,
    previewOverride: dependencies.previewOverride
  });
  // #2005: always registered. The route guard treats a manifest routes[] entry with no
  // registered route as drift and stops the server, so this must not be conditional.
  registerNewsCredentialRoutes(server, {
    dataContext: dependencies.dataContext,
    resolveAccessContext: dependencies.resolveAccessContext,
    cipher: dependencies.credentialCipher,
    connections: dependencies.publisherConnections ?? createEmptyNewsPublisherConnectionPort(),
    sources: personalization,
    credentials: dependencies.credentialRepository
  });
  registerNewsImageRoute(server, {
    dataContext: dependencies.dataContext,
    resolveAccessContext: dependencies.resolveAccessContext,
    repository: personalization,
    fetchImage: dependencies.discovery.image
  });
}

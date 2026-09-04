import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import { HttpError, handleRouteError } from "@moss/module-sdk";

import type { SportsPhotoStore } from "./photo-store.js";

/**
 * #2237 slice 1 — serves the owner's stored copy of a story photo from our own origin, so the
 * web CSP never has to name a publisher's image host and the publisher never sees the reader.
 */

export const SPORTS_PHOTO_CACHE_CONTROL = "private, max-age=604800, immutable";
const SPORTS_PHOTO_CACHE_MAX_ENTRIES = 32;
const SPORTS_PHOTO_CACHE_MAX_BYTES = 16 * 1024 * 1024;

interface SportsPhotoSourceRepository {
  findById(scopedDb: DataContextDb, id: string): Promise<{ readonly id: string } | null>;
}

export interface SportsHeadlinePhotoRouteDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly repository: SportsPhotoSourceRepository;
  /** Absent only where the composition root built no vault runner; every request then 404s. */
  readonly photos?: Pick<
    SportsPhotoStore,
    "read" | "keyForHeadline" | "touch" | "onCopyRemoved"
  >;
}

export function registerSportsHeadlinePhotoRoute(
  server: FastifyInstance,
  dependencies: SportsHeadlinePhotoRouteDependencies
): void {
  const cache = new Map<string, { bytes: Buffer; etag: string }>();
  let cacheBytes = 0;

  function drop(key: string): void {
    const previous = cache.get(key);
    if (!previous) return;
    cacheBytes -= previous.bytes.byteLength;
    cache.delete(key);
  }

  function cached(key: string): { bytes: Buffer; etag: string } | null {
    const entry = cache.get(key);
    if (!entry) return null;
    cache.delete(key);
    cache.set(key, entry);
    return entry;
  }

  function put(key: string, entry: { bytes: Buffer; etag: string }): void {
    drop(key);
    while (
      cache.size >= SPORTS_PHOTO_CACHE_MAX_ENTRIES ||
      cacheBytes + entry.bytes.byteLength > SPORTS_PHOTO_CACHE_MAX_BYTES
    ) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      drop(oldest);
    }
    cache.set(key, entry);
    cacheBytes += entry.bytes.byteLength;
  }

  // A removed copy must stop being served. Cache keys are the owner id and the photo key joined,
  // so every owner holding that photo is dropped at once.
  dependencies.photos?.onCopyRemoved((removedKey) => {
    const suffix = `:${removedKey}`;
    for (const cacheKey of [...cache.keys()]) {
      if (cacheKey.endsWith(suffix)) drop(cacheKey);
    }
  });

  server.get(
    "/api/sports/headlines/:headlineId/photo",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["headlineId"],
          properties: { headlineId: { type: "string", minLength: 1, maxLength: 256 } }
        }
      }
    },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const photos = dependencies.photos;
        if (!photos) throw new HttpError(404, "Sports headline photo not found");
        const { headlineId } = request.params as { headlineId: string };
        const separator = headlineId.indexOf(":");
        if (separator <= 0) throw new HttpError(404, "Sports headline photo not found");
        const sourceId = headlineId.slice(0, separator);
        // Owner scope: the repository runs under the actor's RLS, so another owner's source id
        // resolves to nothing here, and the vault read below is rooted at the actor's own vault.
        const source = await dependencies.dataContext.withDataContext(accessContext, (db) =>
          dependencies.repository.findById(db, sourceId)
        );
        if (!source) throw new HttpError(404, "Sports headline photo not found");

        const key = photos.keyForHeadline(accessContext.actorUserId, headlineId);
        if (!key) throw new HttpError(404, "Sports headline photo not found");

        const cacheKey = `${accessContext.actorUserId}:${key}`;
        const hit = cached(cacheKey);
        // Serving from memory still counts as serving. Without this a popular photo looks
        // untouched to retention and gets swept while people are still looking at it.
        if (hit) void photos.touch(accessContext, key).catch(() => undefined);
        const stored = hit ?? (await photos.read(accessContext, key));
        if (!stored) throw new HttpError(404, "Sports headline photo not found");
        put(cacheKey, stored);

        if (request.headers["if-none-match"] === stored.etag) {
          return reply
            .code(304)
            .header("Cache-Control", SPORTS_PHOTO_CACHE_CONTROL)
            .header("ETag", stored.etag)
            .send();
        }
        return reply
          .type("image/webp")
          .header("Cache-Control", SPORTS_PHOTO_CACHE_CONTROL)
          .header("ETag", stored.etag)
          .header("X-Content-Type-Options", "nosniff")
          .send(stored.bytes);
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}

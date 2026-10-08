import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import { HttpError, handleRouteError } from "@moss/module-sdk";

import type { NewsImageFetchPort } from "./discovery/ports.js";
import {
  assertSnapshotPayload,
  type NewsSnapshotArticle,
  type NewsSnapshotPayload
} from "./personalization-domain.js";
import type { NewsSnapshotRecord } from "./personalization-repository.js";

export const NEWS_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const NEWS_IMAGE_CACHE_MAX_ENTRIES = 32;
const NEWS_IMAGE_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const NEWS_ARTICLE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

type SupportedImageType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

interface NewsImageRepository {
  readLatestSnapshot(scopedDb: DataContextDb): Promise<NewsSnapshotRecord | null>;
}

interface NewsImageRouteDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly repository: NewsImageRepository;
  readonly fetchImage: NewsImageFetchPort;
  readonly now?: () => Date;
}

interface CachedImage {
  readonly contentType: SupportedImageType;
  readonly body: Uint8Array;
}

function hasPrefix(body: Uint8Array, bytes: readonly number[]): boolean {
  return bytes.every((byte, index) => body[index] === byte);
}

function hasAscii(body: Uint8Array, offset: number, text: string): boolean {
  return [...text].every((character, index) => body[offset + index] === character.charCodeAt(0));
}

export function validatedNewsImageType(
  contentType: string | null,
  body: Uint8Array
): SupportedImageType | null {
  const mime = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mime === "image/jpeg" && hasPrefix(body, [0xff, 0xd8, 0xff])) return mime;
  if (mime === "image/png" && hasPrefix(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return mime;
  }
  if (mime === "image/gif" && (hasAscii(body, 0, "GIF87a") || hasAscii(body, 0, "GIF89a"))) {
    return mime;
  }
  if (mime === "image/webp" && hasAscii(body, 0, "RIFF") && hasAscii(body, 8, "WEBP")) {
    return mime;
  }
  return null;
}

export function currentImageArticle(
  snapshot: NewsSnapshotRecord | null,
  articleId: string,
  now: Date
): NewsSnapshotArticle | null {
  if (!snapshot || snapshot.expiresAt.getTime() <= now.getTime()) return null;
  try {
    assertSnapshotPayload(snapshot.payload);
  } catch {
    return null;
  }
  const cutoff = now.getTime() - NEWS_ARTICLE_MAX_AGE_MS;
  const matches = (snapshot.payload as NewsSnapshotPayload).articles.filter(
    (article) =>
      article.id === articleId &&
      article.imageUrl !== null &&
      Date.parse(article.publishedAt) >= cutoff
  );
  return matches.length === 1 ? matches[0]! : null;
}

export function registerNewsImageRoute(
  server: FastifyInstance,
  dependencies: NewsImageRouteDependencies
): void {
  const cache = new Map<string, CachedImage>();
  let cacheBytes = 0;

  function cached(key: string): CachedImage | null {
    const value = cache.get(key);
    if (!value) return null;
    cache.delete(key);
    cache.set(key, value);
    return value;
  }

  function put(key: string, value: CachedImage): void {
    const previous = cache.get(key);
    if (previous) {
      cacheBytes -= previous.body.byteLength;
      cache.delete(key);
    }
    while (
      cache.size >= NEWS_IMAGE_CACHE_MAX_ENTRIES ||
      cacheBytes + value.body.byteLength > NEWS_IMAGE_CACHE_MAX_BYTES
    ) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = cache.get(oldestKey)!;
      cache.delete(oldestKey);
      cacheBytes -= oldest.body.byteLength;
    }
    cache.set(key, value);
    cacheBytes += value.body.byteLength;
  }

  server.get(
    "/api/news/images/:articleId",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["articleId"],
          properties: { articleId: { type: "string", minLength: 1, maxLength: 128 } }
        }
      }
    },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const { articleId } = request.params as { articleId: string };
        const article = await dependencies.dataContext.withDataContext(accessContext, async (db) =>
          currentImageArticle(
            await dependencies.repository.readLatestSnapshot(db),
            articleId,
            dependencies.now?.() ?? new Date()
          )
        );
        if (!article?.imageUrl) throw new HttpError(404, "News image not found");

        const fromCache = cached(article.imageUrl);
        if (fromCache) return sendImage(reply, fromCache);

        const fetched = await dependencies.fetchImage(article.imageUrl, NEWS_IMAGE_MAX_BYTES);
        if (!fetched.ok || fetched.truncated || fetched.body.byteLength > NEWS_IMAGE_MAX_BYTES) {
          throw new HttpError(502, "News image is unavailable");
        }
        const contentType = validatedNewsImageType(fetched.contentType, fetched.body);
        if (!contentType) throw new HttpError(502, "News image is unavailable");
        const image = { contentType, body: Uint8Array.from(fetched.body) };
        put(article.imageUrl, image);
        return sendImage(reply, image);
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}

function sendImage(reply: Parameters<typeof handleRouteError>[1], image: CachedImage) {
  return reply
    .type(image.contentType)
    .header("Cache-Control", "private, max-age=300")
    .header("X-Content-Type-Options", "nosniff")
    .send(Buffer.from(image.body));
}

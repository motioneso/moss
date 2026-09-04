import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AccessContext } from "@moss/db";
import { HttpError, handleRouteError } from "@moss/module-sdk";

import type { NewsImageFetchPort } from "./discovery/ports.js";

export const NEWS_FAVICON_MAX_BYTES = 256 * 1024;
const NEWS_FAVICON_CACHE_MAX_ENTRIES = 128;
const NEWS_FAVICON_CACHE_MAX_BYTES = 4 * 1024 * 1024;

// A bare hostname only: labels of letters/digits/hyphens, at least one dot, no scheme, no path,
// no port. Matches what `new URL(homepageUrl).hostname` produces elsewhere in this module.
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)[a-zA-Z0-9]([a-zA-Z0-9-]{0,62}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,62}[a-zA-Z0-9])?)+$/;

type SupportedFaviconType = "image/png" | "image/x-icon" | "image/gif" | "image/webp";

interface CachedFavicon {
  readonly contentType: SupportedFaviconType;
  readonly body: Uint8Array;
}

interface NewsFaviconRouteDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly fetchImage: NewsImageFetchPort;
}

function hasPrefix(body: Uint8Array, bytes: readonly number[]): boolean {
  return bytes.length <= body.length && bytes.every((byte, index) => body[index] === byte);
}

function hasAscii(body: Uint8Array, offset: number, text: string): boolean {
  return [...text].every((character, index) => body[offset + index] === character.charCodeAt(0));
}

/**
 * Favicons arrive under wildly inconsistent (and often absent) content-type headers, so this
 * sniffs the bytes directly instead of trusting the server's declared type — same posture as
 * `validatedNewsImageType` in image-route.ts, just with the ICO signature added and SVG left out
 * (an SVG favicon can carry a script, and the site's own name already covers the fallback case).
 */
export function sniffedFaviconType(body: Uint8Array): SupportedFaviconType | null {
  if (hasPrefix(body, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  if (hasPrefix(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (hasAscii(body, 0, "GIF87a") || hasAscii(body, 0, "GIF89a")) return "image/gif";
  if (hasAscii(body, 0, "RIFF") && hasAscii(body, 8, "WEBP")) return "image/webp";
  return null;
}

export function registerNewsFaviconRoute(
  server: FastifyInstance,
  dependencies: NewsFaviconRouteDependencies
): void {
  const cache = new Map<string, CachedFavicon>();
  let cacheBytes = 0;

  function cached(key: string): CachedFavicon | null {
    const value = cache.get(key);
    if (!value) return null;
    cache.delete(key);
    cache.set(key, value);
    return value;
  }

  function put(key: string, value: CachedFavicon): void {
    const previous = cache.get(key);
    if (previous) {
      cacheBytes -= previous.body.byteLength;
      cache.delete(key);
    }
    while (
      cache.size >= NEWS_FAVICON_CACHE_MAX_ENTRIES ||
      cacheBytes + value.body.byteLength > NEWS_FAVICON_CACHE_MAX_BYTES
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
    "/api/news/favicon/:domain",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["domain"],
          properties: {
            domain: {
              type: "string",
              minLength: 1,
              maxLength: 253,
              pattern: HOSTNAME_PATTERN.source
            }
          }
        }
      }
    },
    async (request, reply) => {
      try {
        // A publisher's site is public, so unlike the personalized image route this needs no
        // per-article lookup — it just needs to know the requester is a signed-in actor.
        await dependencies.resolveAccessContext(request);
        const { domain } = request.params as { domain: string };

        const fromCache = cached(domain);
        if (fromCache) return sendFavicon(reply, fromCache);

        const faviconUrl = `https://${domain}/favicon.ico`;
        const fetched = await dependencies.fetchImage(faviconUrl, NEWS_FAVICON_MAX_BYTES);
        if (!fetched.ok || fetched.truncated || fetched.body.byteLength > NEWS_FAVICON_MAX_BYTES) {
          throw new HttpError(404, "Favicon not found");
        }
        const contentType = sniffedFaviconType(fetched.body);
        if (!contentType) throw new HttpError(404, "Favicon not found");
        const favicon = { contentType, body: Uint8Array.from(fetched.body) };
        put(domain, favicon);
        return sendFavicon(reply, favicon);
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}

function sendFavicon(reply: Parameters<typeof handleRouteError>[1], favicon: CachedFavicon) {
  return reply
    .type(favicon.contentType)
    .header("Cache-Control", "private, max-age=86400")
    .header("X-Content-Type-Options", "nosniff")
    .send(Buffer.from(favicon.body));
}

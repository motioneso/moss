import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import { HttpError, handleRouteError } from "@moss/module-sdk";

import type { NewsImageFetchPort } from "./discovery/ports.js";
import {
  NEWS_HOMEPAGE_HOSTS,
  NEWS_IMAGE_HOSTS,
  sourceEntryForHomepageHost
} from "./source/catalog.js";

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

/** Just enough of the personalization repository to check the requester's own saved sources. */
export interface NewsFaviconCustomSourcePort {
  listCustomSources(
    scopedDb: DataContextDb
  ): Promise<readonly { readonly canonicalDomain: string }[]>;
}

interface NewsFaviconRouteDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly fetchImage: NewsImageFetchPort;
  readonly dataContext: DataContextRunner;
  readonly customSources: NewsFaviconCustomSourcePort;
}

const STATIC_APPROVED_HOSTS = new Set(
  [...NEWS_HOMEPAGE_HOSTS, ...NEWS_IMAGE_HOSTS].map((host) => host.toLowerCase())
);

/**
 * An icon is only ever fetched for a host this actor is entitled to see attributed on their own
 * screen: a source in the built-in catalog, a host one of those sources declares its images come
 * from, or a custom source this same signed-in user has saved for themselves. Anything else is
 * refused before any network request is made — the blocker this closes (gpt-6-astra, PR 2252):
 * without it, any signed-in caller could ask the server to fetch and serve back an icon from an
 * arbitrary public site.
 */
async function isApprovedPublisherHost(
  domain: string,
  accessContext: AccessContext,
  dependencies: Pick<NewsFaviconRouteDependencies, "dataContext" | "customSources">
): Promise<boolean> {
  const lower = domain.toLowerCase();
  if (STATIC_APPROVED_HOSTS.has(lower)) return true;
  const customDomains = await dependencies.dataContext.withDataContext(accessContext, (db) =>
    dependencies.customSources.listCustomSources(db)
  );
  return customDomains.some((source) => source.canonicalDomain.toLowerCase() === lower);
}

/**
 * Hosts the favicon download (every redirect hop included) may land on: the requested domain
 * itself, plus — for a built-in publisher — the hosts that publisher already declares its
 * artwork comes from. NPR answers its favicon request with a redirect to media.npr.org, a host
 * it lists as an image host, and a same-host-only rule refused that hop, so NPR never got an
 * icon (#2291). A custom source declares no image hosts, so it stays same-host-only. Nothing
 * here widens the PR 2252 rule: the set is fixed by the catalog, never by the request.
 */
export function faviconFetchHosts(domain: string): readonly string[] {
  const lower = domain.toLowerCase();
  const declared = sourceEntryForHomepageHost(lower)?.imageHosts ?? [];
  return [...new Set([lower, ...declared.map((host) => host.toLowerCase())])];
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
        const accessContext = await dependencies.resolveAccessContext(request);
        const { domain } = request.params as { domain: string };

        if (!(await isApprovedPublisherHost(domain, accessContext, dependencies))) {
          throw new HttpError(404, "Favicon not found");
        }

        const fromCache = cached(domain);
        if (fromCache) return sendFavicon(reply, fromCache);

        const faviconUrl = `https://${domain}/favicon.ico`;
        const fetched = await dependencies.fetchImage(
          faviconUrl,
          NEWS_FAVICON_MAX_BYTES,
          faviconFetchHosts(domain)
        );
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

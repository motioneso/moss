import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import { HttpError, handleRouteError } from "@moss/module-sdk";

/**
 * #2211 source icons: a publication's favicon, fetched server-side because the web CSP only
 * allows images from a fixed set of hosts. Modelled on the News article-image route, but the
 * icon is keyed by source id and the body is accepted on magic bytes alone — favicon servers
 * routinely mislabel the content type (`image/x-icon`, `text/plain`, `application/octet-stream`).
 */

export const SPORTS_ICON_MAX_BYTES = 256 * 1024;
export const SPORTS_ICON_TIMEOUT_MS = 5_000;
export const SPORTS_ICON_HIT_TTL_MS = 24 * 60 * 60 * 1_000;
export const SPORTS_ICON_MISS_TTL_MS = 60 * 60 * 1_000;
const SPORTS_ICON_CACHE_MAX_ENTRIES = 256;
const SPORTS_ICON_CACHE_MAX_BYTES = 16 * 1024 * 1024;

export type SportsIconImageType =
  | "image/x-icon"
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

/** Byte fetch through the safe-fetch layer; the composition root pins HTTPS and the rate limiter. */
export type SportsIconFetchPort = (
  url: string,
  options: {
    readonly allowedHosts: readonly string[];
    readonly maxBytes: number;
    readonly rejectOversizedResponses: boolean;
    readonly timeoutMs: number;
  }
) => Promise<
  | {
      readonly ok: true;
      readonly contentType: string | null;
      readonly body: Uint8Array;
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly reason: string }
>;

export interface SportsIconSourceRecord {
  readonly id: string;
  readonly canonicalDomain: string;
}

interface SportsIconSourceRepository {
  findById(scopedDb: DataContextDb, id: string): Promise<SportsIconSourceRecord | null>;
}

export interface SportsSourceIconRouteDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly repository: SportsIconSourceRepository;
  readonly fetchBytes: SportsIconFetchPort;
  readonly now?: () => Date;
}

interface CachedIcon {
  readonly contentType: SportsIconImageType;
  readonly body: Uint8Array;
}

interface CacheEntry {
  readonly icon: CachedIcon | null;
  readonly expiresAt: number;
}

function hasPrefix(body: Uint8Array, bytes: readonly number[]): boolean {
  return bytes.every((byte, index) => body[index] === byte);
}

function hasAscii(body: Uint8Array, offset: number, text: string): boolean {
  return [...text].every((character, index) => body[offset + index] === character.charCodeAt(0));
}

/** Magic-byte sniff only. HTML, SVG (XML text), and anything else answer null. */
export function sniffSportsIconType(body: Uint8Array): SportsIconImageType | null {
  if (hasPrefix(body, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  if (hasPrefix(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (hasPrefix(body, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (hasAscii(body, 0, "GIF87a") || hasAscii(body, 0, "GIF89a")) return "image/gif";
  if (hasAscii(body, 0, "RIFF") && hasAscii(body, 8, "WEBP")) return "image/webp";
  return null;
}

/** `https://{domain}/favicon.ico`, then the `www.` variant unless the domain already has it. */
export function sportsIconCandidateUrls(canonicalDomain: string): readonly string[] {
  const domain = canonicalDomain.trim().toLowerCase();
  const urls = [`https://${domain}/favicon.ico`];
  if (!domain.startsWith("www.")) urls.push(`https://www.${domain}/favicon.ico`);
  return urls;
}

export function registerSportsSourceIconRoute(
  server: FastifyInstance,
  dependencies: SportsSourceIconRouteDependencies
): void {
  const cache = new Map<string, CacheEntry>();
  let cacheBytes = 0;
  const now = () => dependencies.now?.() ?? new Date();

  function entryBytes(entry: CacheEntry): number {
    return entry.icon?.body.byteLength ?? 0;
  }

  function drop(key: string): void {
    const previous = cache.get(key);
    if (!previous) return;
    cacheBytes -= entryBytes(previous);
    cache.delete(key);
  }

  function cached(key: string): CacheEntry | null {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now().getTime()) {
      drop(key);
      return null;
    }
    cache.delete(key);
    cache.set(key, entry);
    return entry;
  }

  function put(key: string, icon: CachedIcon | null): CacheEntry {
    drop(key);
    const entry: CacheEntry = {
      icon,
      expiresAt: now().getTime() + (icon ? SPORTS_ICON_HIT_TTL_MS : SPORTS_ICON_MISS_TTL_MS)
    };
    while (
      cache.size >= SPORTS_ICON_CACHE_MAX_ENTRIES ||
      cacheBytes + entryBytes(entry) > SPORTS_ICON_CACHE_MAX_BYTES
    ) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      drop(oldestKey);
    }
    cache.set(key, entry);
    cacheBytes += entryBytes(entry);
    return entry;
  }

  async function lookupIcon(canonicalDomain: string): Promise<CachedIcon | null> {
    for (const url of sportsIconCandidateUrls(canonicalDomain)) {
      const host = new URL(url).hostname;
      const fetched = await dependencies.fetchBytes(url, {
        allowedHosts: [host],
        maxBytes: SPORTS_ICON_MAX_BYTES,
        rejectOversizedResponses: true,
        timeoutMs: SPORTS_ICON_TIMEOUT_MS
      });
      if (!fetched.ok || fetched.truncated || fetched.body.byteLength > SPORTS_ICON_MAX_BYTES) {
        continue;
      }
      const contentType = sniffSportsIconType(fetched.body);
      if (!contentType) continue;
      return { contentType, body: Uint8Array.from(fetched.body) };
    }
    return null;
  }

  server.get(
    "/api/sports/sources/:sourceId/icon",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["sourceId"],
          properties: { sourceId: { type: "string", minLength: 1, maxLength: 128 } }
        }
      }
    },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const { sourceId } = request.params as { sourceId: string };
        // Owner scope: the repository runs under the actor's RLS, so another user's id is null.
        const source = await dependencies.dataContext.withDataContext(accessContext, (db) =>
          dependencies.repository.findById(db, sourceId)
        );
        if (!source) throw new HttpError(404, "Sports source not found");

        const entry = cached(source.id) ?? put(source.id, await lookupIcon(source.canonicalDomain));
        if (!entry.icon) throw new HttpError(404, "Sports source icon not found");
        return reply
          .type(entry.icon.contentType)
          .header("Cache-Control", "private, max-age=86400")
          .header("X-Content-Type-Options", "nosniff")
          .send(Buffer.from(entry.icon.body));
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}

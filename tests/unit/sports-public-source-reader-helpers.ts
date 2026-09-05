// Shared fixtures for the public source reader tests. Split out so neither test file goes
// over the repository's file-size limit; not itself a test file.

import { vi } from "vitest";

import type { AccessContext, DataContextDb } from "@moss/db";

import type { SportsSafeFetchPort } from "../../packages/sports/src/source/discovery.js";
import {
  SPORTS_PHOTO_DEADLINE_MARGIN_MS,
  SPORTS_PHOTO_DOWNLOAD_TIMEOUT_MS,
  type SportsPhotoStore,
  type EnsurePhotoResult,
  type PhotoHostSlot
} from "../../packages/sports/src/source/photo-store.js";
import { SportsPublicSourceReader } from "../../packages/sports/src/source/public-source-reader.js";
import { validateSportsSourceRecipe } from "../../packages/sports/src/source/recipe.js";
import type {
  SportsRuntimeSource,
  SportsRuntimeTargetResult,
  SportsSourcesRepository
} from "../../packages/sports/src/source/repository.js";
import type { SportsNewsScope } from "../../packages/sports/src/source/scope.js";

export const actor: AccessContext = { actorUserId: "user-a", requestId: "request-a" };

/** Mirrors the reader's own refresh deadline, which it does not export. */
export const REFRESH_DEADLINE_MS = 12_000;

export const jsonRecipe = {
  version: 1,
  kind: "json",
  fetchHosts: ["api.publisher.example"],
  request: {
    urlTemplate: "https://api.publisher.example/team/{teamId}/news",
    slots: [{ name: "teamId", location: "path", encoding: "path_segment", maxLength: 32 }],
    headers: { accept: "application/json" }
  },
  scopes: ["team"],
  itemLimit: 10,
  extraction: {
    itemsPath: ["news"],
    headlinePath: ["title"],
    urlPath: ["url"],
    publishedAtPath: ["publishedAt"],
    normalize: ["trim", "collapse_whitespace", "strip_controls"]
  }
} as const;

export const htmlRecipe = {
  version: 1,
  kind: "html",
  fetchHosts: ["www.publisher.example"],
  request: {
    urlTemplate: "https://www.publisher.example/team/{teamId}/news",
    slots: [{ name: "teamId", location: "path", encoding: "path_segment", maxLength: 32 }],
    headers: { accept: "text/html,application/xhtml+xml" }
  },
  scopes: ["team"],
  itemLimit: 10,
  extraction: {
    collectionSelector: "main.news",
    itemSelector: "article.story",
    headline: { selector: "h2", source: "text" },
    url: { selector: "a", source: "attribute", attribute: "href" },
    normalize: ["trim", "collapse_whitespace", "strip_controls"]
  }
} as const;

export function fingerprint(recipe: Readonly<Record<string, unknown>>): string {
  const result = validateSportsSourceRecipe(recipe);
  if (!result.ok) throw new Error(result.reason);
  return result.fingerprint;
}

export function runtimeSource(options: {
  id: string;
  recipe?: Readonly<Record<string, unknown>> | null;
  parameters?: Readonly<Record<string, unknown>>;
  targetUrl?: string | null;
  feedUrl?: string | null;
  hosts?: readonly string[];
  fingerprint?: string;
  scope?: SportsNewsScope;
}): SportsRuntimeSource {
  const recipe = options.recipe === undefined ? jsonRecipe : options.recipe;
  return {
    id: options.id,
    label: `Publisher ${options.id}`,
    canonicalDomain: "publisher.example",
    feedUrl: options.feedUrl ?? null,
    retrievalMethod: options.feedUrl ? "feed" : "scrape",
    enabled: true,
    runtimeFingerprint:
      options.fingerprint ?? (recipe === null ? `legacy-${options.id}` : fingerprint(recipe)),
    recipeJson: recipe,
    confirmedFetchHosts:
      options.hosts ??
      (recipe && Array.isArray(recipe.fetchHosts) ? (recipe.fetchHosts as string[]) : []),
    assignments: [
      {
        id: `assignment-${options.id}`,
        scope: options.scope ?? {
          kind: "team",
          sportKey: "soccer",
          competitionKey: "eng.1",
          teamKey: "arsenal"
        },
        targetUrl: options.targetUrl ?? `https://publisher.example/display/${options.id}`,
        targetParameters: options.parameters ?? { teamId: options.id },
        previewStatus: "verified"
      }
    ]
  };
}

export function success(
  finalUrl: string,
  body: string,
  contentType = "application/json"
): Awaited<ReturnType<SportsSafeFetchPort>> {
  return { ok: true, status: 200, finalUrl, contentType, body, truncated: false };
}

export function makeReader(
  sources: readonly SportsRuntimeSource[],
  fetch: SportsSafeFetchPort,
  options: {
    now?: () => number;
    sleep?: () => Promise<void>;
    photos?: PhotoStoreDouble;
  } = {}
) {
  const persisted: SportsRuntimeTargetResult[][] = [];
  const repository = {
    listRuntimeSources: vi.fn(async () => [...sources]),
    persistRuntimeResults: vi.fn(
      async (_db: DataContextDb, results: SportsRuntimeTargetResult[]) => {
        persisted.push([...results]);
        return results.length;
      }
    )
  } as unknown as SportsSourcesRepository;
  const reader = new SportsPublicSourceReader({
    dataContext: {
      withDataContext: async <T>(
        _accessContext: AccessContext,
        work: (db: DataContextDb) => Promise<T>
      ) => work({} as DataContextDb)
    },
    repository,
    fetch,
    now: options.now,
    sleep: options.sleep,
    ...(options.photos ? { photos: options.photos as unknown as SportsPhotoStore } : {})
  });
  return { reader, repository, persisted };
}

/**
 * #2237 stands in for the vault-backed photo store: it records every photo URL it was asked to
 * store, so a test can assert which candidate the reader chose without touching a filesystem.
 */
export class PhotoStoreDouble {
  readonly stored: string[] = [];
  /** Every call, including ones that decline: proves the reader stops asking once time is up. */
  attempts = 0;
  readonly budgets: number[] = [];
  readonly links = new Map<string, string>();
  swept: ReadonlySet<string> | null = null;
  /** Set to make every download attempt fail, as a permanently broken image would. */
  alwaysFails = false;
  /** Every publisher host a slot was actually taken for, proving the limiter is wired in. */
  readonly slotHosts: string[] = [];
  /** Called before each attempt, so a test can make one source's photo work burn the clock. */
  beforeEnsure: ((sourceId: string) => void) | null = null;

  async ensure(
    _access: AccessContext,
    sourceId: string,
    photoUrl: string,
    options: {
      readonly signal?: AbortSignal;
      readonly remainingMs?: () => number;
      readonly hostSlot?: PhotoHostSlot;
    } = {}
  ): Promise<EnsurePhotoResult> {
    // Mirrors the real store: the safety margin is applied to the time left at the moment the
    // download would start, and the download is capped at the store's own limit.
    this.attempts += 1;
    this.beforeEnsure?.(sourceId);
    if (options.hostSlot) {
      const host = new URL(photoUrl).hostname;
      if (await options.hostSlot.acquire(host)) {
        this.slotHosts.push(host);
        options.hostSlot.release(host);
      }
    }
    const remaining = options.remainingMs?.() ?? SPORTS_PHOTO_DOWNLOAD_TIMEOUT_MS;
    if (remaining <= SPORTS_PHOTO_DEADLINE_MARGIN_MS) return { outcome: "skipped" };
    const allowed = Math.min(SPORTS_PHOTO_DOWNLOAD_TIMEOUT_MS, remaining);
    this.stored.push(photoUrl);
    this.budgets.push(allowed);
    if (this.alwaysFails) return { outcome: "unusable" };
    return {
      outcome: "stored",
      photo: { key: `key-${this.stored.length}`, width: 1280, height: 720, bytes: 4096 }
    };
  }

  linkHeadline(actorUserId: string, headlineId: string, key: string): void {
    this.links.set(`${actorUserId} ${headlineId}`, key);
  }

  async sweep(_access: AccessContext, keepKeys: ReadonlySet<string>) {
    this.swept = keepKeys;
    return { removed: 0 };
  }
}

export async function permitInitialRequest(
  url: string,
  options: Parameters<SportsSafeFetchPort>[1]
): Promise<boolean> {
  return (await options?.beforeRequest?.({ url: new URL(url), redirectCount: 0 })) !== false;
}

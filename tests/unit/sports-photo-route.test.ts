import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";

import {
  SPORTS_PHOTO_CACHE_CONTROL,
  registerSportsHeadlinePhotoRoute
} from "../../packages/sports/src/source/photo-route.js";
import type { SportsPhotoStore } from "../../packages/sports/src/source/photo-store.js";

const user: AccessContext = { actorUserId: "user-a", requestId: "request-a" };
const sourceId = "11111111-1111-1111-1111-111111111111";
const headlineId = `${sourceId}:item-1`;
const key = "a".repeat(32);
const bytes = Buffer.from("RIFF1234WEBPfake-webp-body");
const etag = '"deadbeefdeadbeefdeadbeefdeadbeef"';

type RoutePhotos = Pick<SportsPhotoStore, "read" | "keyForHeadline" | "touch" | "onCopyRemoved">;

function buildApp(input: {
  knownSourceId?: string | null;
  photos?: RoutePhotos;
  reads?: string[];
}) {
  const app = Fastify();
  registerSportsHeadlinePhotoRoute(app, {
    dataContext: {
      withDataContext: async <T>(
        _accessContext: AccessContext,
        work: (db: DataContextDb) => Promise<T>
      ) => work({} as DataContextDb)
    } as unknown as DataContextRunner,
    resolveAccessContext: async () => user,
    repository: {
      findById: async (_db, id) => (id === (input.knownSourceId ?? sourceId) ? { id } : null)
    },
    ...(input.photos === undefined ? {} : { photos: input.photos })
  });
  return app;
}

function store(overrides: Partial<RoutePhotos> = {}): RoutePhotos {
  return {
    keyForHeadline: (_userId, id) => (id === headlineId ? key : null),
    read: async () => ({ bytes, etag }),
    touch: async () => undefined,
    onCopyRemoved: () => undefined,
    ...overrides
  };
}

describe("sports headline photo route (#2237)", () => {
  it("serves the stored copy with a private, long-lived cache header and a tag", async () => {
    const app = buildApp({ photos: store() });
    const response = await app.inject({
      method: "GET",
      url: `/api/sports/headlines/${headlineId}/photo`
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/webp");
    expect(response.headers["cache-control"]).toBe(SPORTS_PHOTO_CACHE_CONTROL);
    expect(response.headers["etag"]).toBe(etag);
    expect(response.rawPayload.equals(bytes)).toBe(true);
    await app.close();
  });

  it("answers 304 when the browser already has that exact copy", async () => {
    const app = buildApp({ photos: store() });
    const response = await app.inject({
      method: "GET",
      url: `/api/sports/headlines/${headlineId}/photo`,
      headers: { "if-none-match": etag }
    });
    expect(response.statusCode).toBe(304);
    expect(response.headers["etag"]).toBe(etag);
    await app.close();
  });

  it("answers 404 when no copy is stored for that headline", async () => {
    const app = buildApp({ photos: store({ keyForHeadline: () => null }) });
    const response = await app.inject({
      method: "GET",
      url: `/api/sports/headlines/${headlineId}/photo`
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("answers 404 when the stored file has gone", async () => {
    const app = buildApp({ photos: store({ read: async () => null }) });
    const response = await app.inject({
      method: "GET",
      url: `/api/sports/headlines/${headlineId}/photo`
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("answers 404 for a headline whose source this actor does not own", async () => {
    const app = buildApp({ knownSourceId: "someone-else", photos: store() });
    const response = await app.inject({
      method: "GET",
      url: `/api/sports/headlines/${headlineId}/photo`
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("answers 404 for a headline id that names no source", async () => {
    const app = buildApp({ photos: store() });
    const response = await app.inject({
      method: "GET",
      url: "/api/sports/headlines/nosource/photo"
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("serves a repeat request from memory instead of reading the file again", async () => {
    let reads = 0;
    const app = buildApp({
      photos: store({
        read: async () => {
          reads += 1;
          return { bytes, etag };
        }
      })
    });
    await app.inject({ method: "GET", url: `/api/sports/headlines/${headlineId}/photo` });
    await app.inject({ method: "GET", url: `/api/sports/headlines/${headlineId}/photo` });
    expect(reads).toBe(1);
    await app.close();
  });

  it("records that a photo was served even when the answer came from memory", async () => {
    const touched: string[] = [];
    const app = buildApp({
      photos: store({
        touch: async (_access, touchedKey) => {
          touched.push(touchedKey);
        }
      })
    });
    await app.inject({ method: "GET", url: `/api/sports/headlines/${headlineId}/photo` });
    await app.inject({ method: "GET", url: `/api/sports/headlines/${headlineId}/photo` });
    await app.inject({ method: "GET", url: `/api/sports/headlines/${headlineId}/photo` });
    expect(touched).toEqual([key, key]);
    await app.close();
  });

  it("stops answering from memory once the stored copy has been removed", async () => {
    const listeners: ((key: string) => void)[] = [];
    let present = true;
    let reads = 0;
    const app = buildApp({
      photos: store({
        onCopyRemoved: (listener) => {
          listeners.push(listener);
        },
        read: async () => {
          reads += 1;
          return present ? { bytes, etag } : null;
        }
      })
    });

    const first = await app.inject({
      method: "GET",
      url: `/api/sports/headlines/${headlineId}/photo`
    });
    present = false;
    for (const listener of listeners) listener(key);
    const second = await app.inject({
      method: "GET",
      url: `/api/sports/headlines/${headlineId}/photo`
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(404);
    expect(reads).toBe(2);
    await app.close();
  });
});

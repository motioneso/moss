import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AccessContext } from "@moss/db";
import { VaultContextRunner } from "@moss/vault";

import type { SportsIconFetchPort } from "../../packages/sports/src/source/icon-route.js";
import { photoKey } from "../../packages/sports/src/source/photo.js";
import { SportsPhotoStore } from "../../packages/sports/src/source/photo-store.js";

const actor: AccessContext = { actorUserId: "user-a", requestId: "request-a" };
const other: AccessContext = { actorUserId: "user-b", requestId: "request-b" };

async function jpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 90, b: 160 } }
  })
    .jpeg()
    .toBuffer();
}

function fetchPortReturning(bodies: ReadonlyMap<string, Buffer>): {
  port: SportsIconFetchPort;
  calls: string[];
} {
  const calls: string[] = [];
  const port: SportsIconFetchPort = async (url) => {
    calls.push(url);
    const body = bodies.get(url);
    if (!body) return { ok: false, reason: "blocked" };
    return { ok: true, contentType: "image/jpeg", body, truncated: false };
  };
  return { port, calls };
}

describe("sports photo store (#2237)", () => {
  let baseDir: string;
  let vault: VaultContextRunner;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "sports-photos-"));
    vault = new VaultContextRunner(baseDir);
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  async function storedFiles(userId: string): Promise<string[]> {
    try {
      return (await readdir(join(baseDir, userId, "sports", "photos"))).sort();
    } catch {
      return [];
    }
  }

  it("downloads, resizes and stores one copy with a sidecar", async () => {
    const url = "https://example.com/photo.jpg";
    const { port } = fetchPortReturning(new Map([[url, await jpeg(2000, 1000)]]));
    const store = new SportsPhotoStore({ vault, fetchBytes: port });

    const stored = await store.ensure(actor, "source-a", url);

    expect(stored).not.toBeNull();
    expect(stored?.key).toBe(photoKey("source-a", url));
    expect(stored?.width).toBe(1280);
    expect(stored?.height).toBe(640);
    expect(await storedFiles("user-a")).toEqual([`${stored?.key}.json`, `${stored?.key}.webp`]);
  });

  it("keeps each owner's copy in that owner's own vault", async () => {
    const url = "https://example.com/photo.jpg";
    const { port } = fetchPortReturning(new Map([[url, await jpeg(900, 600)]]));
    const store = new SportsPhotoStore({ vault, fetchBytes: port });

    await store.ensure(actor, "source-a", url);

    expect(await storedFiles("user-a")).toHaveLength(2);
    expect(await storedFiles("user-b")).toHaveLength(0);
    expect(await store.read(other, photoKey("source-a", url))).toBeNull();
  });

  it("does not download twice for the same source and photo", async () => {
    const url = "https://example.com/photo.jpg";
    const { port, calls } = fetchPortReturning(new Map([[url, await jpeg(900, 600)]]));
    const store = new SportsPhotoStore({ vault, fetchBytes: port });

    await store.ensure(actor, "source-a", url);
    await store.ensure(actor, "source-a", url);

    expect(calls).toHaveLength(1);
  });

  it("rejects a body that is not an image and one whose short side is under 64 pixels", async () => {
    const notImage = "https://example.com/page.html";
    const tiny = "https://example.com/tiny.jpg";
    const { port } = fetchPortReturning(
      new Map([
        [notImage, Buffer.from("<html><body>not an image</body></html>")],
        [tiny, await jpeg(400, 40)]
      ])
    );
    const store = new SportsPhotoStore({ vault, fetchBytes: port });

    expect(await store.ensure(actor, "source-a", notImage)).toBeNull();
    expect(await store.ensure(actor, "source-a", tiny)).toBeNull();
    expect(await storedFiles("user-a")).toHaveLength(0);
  });

  it("returns null rather than throwing when the download fails", async () => {
    const { port } = fetchPortReturning(new Map());
    const store = new SportsPhotoStore({ vault, fetchBytes: port });

    expect(await store.ensure(actor, "source-a", "https://example.com/missing.jpg")).toBeNull();
  });

  it("evicts the least recently served copy once the count cap is passed", async () => {
    const bodies = new Map<string, Buffer>();
    const body = await jpeg(400, 300);
    for (const index of [0, 1, 2]) bodies.set(`https://example.com/${index}.jpg`, body);
    const { port } = fetchPortReturning(bodies);
    let clock = Date.parse("2026-09-04T10:00:00.000Z");
    const store = new SportsPhotoStore({
      vault,
      fetchBytes: port,
      now: () => new Date(clock),
      limits: { maxCopiesPerOwner: 2 }
    });

    for (const index of [0, 1, 2]) {
      await store.ensure(actor, "source-a", `https://example.com/${index}.jpg`);
      clock += 1_000;
    }

    const files = await storedFiles("user-a");
    expect(files).toHaveLength(4);
    expect(files).not.toContain(`${photoKey("source-a", "https://example.com/0.jpg")}.webp`);
  });

  it("sweeps a copy past retention but keeps one the current refresh still uses", async () => {
    const bodies = new Map<string, Buffer>();
    const body = await jpeg(400, 300);
    bodies.set("https://example.com/old.jpg", body);
    bodies.set("https://example.com/kept.jpg", body);
    const { port } = fetchPortReturning(bodies);
    let clock = Date.parse("2026-09-04T10:00:00.000Z");
    const store = new SportsPhotoStore({ vault, fetchBytes: port, now: () => new Date(clock) });

    const old = await store.ensure(actor, "source-a", "https://example.com/old.jpg");
    const kept = await store.ensure(actor, "source-a", "https://example.com/kept.jpg");
    clock += 15 * 24 * 60 * 60 * 1_000;

    await store.sweep(actor, new Set([kept!.key]));

    const files = await storedFiles("user-a");
    expect(files).toContain(`${kept!.key}.webp`);
    expect(files).not.toContain(`${old!.key}.webp`);
  });

  it("removes every copy belonging to one source and leaves the others alone", async () => {
    const bodies = new Map<string, Buffer>();
    const body = await jpeg(400, 300);
    bodies.set("https://example.com/a.jpg", body);
    bodies.set("https://example.com/b.jpg", body);
    const { port } = fetchPortReturning(bodies);
    const store = new SportsPhotoStore({ vault, fetchBytes: port });

    const gone = await store.ensure(actor, "source-a", "https://example.com/a.jpg");
    const stays = await store.ensure(actor, "source-b", "https://example.com/b.jpg");

    await store.removeSource(actor, "source-a");

    const files = await storedFiles("user-a");
    expect(files).not.toContain(`${gone!.key}.webp`);
    expect(files).toContain(`${stays!.key}.webp`);
  });

  it("reads a stored copy back with a stable tag, and refuses a made-up key", async () => {
    const url = "https://example.com/photo.jpg";
    const { port } = fetchPortReturning(new Map([[url, await jpeg(900, 600)]]));
    const store = new SportsPhotoStore({ vault, fetchBytes: port });
    const stored = await store.ensure(actor, "source-a", url);

    const first = await store.read(actor, stored!.key);
    const second = await store.read(actor, stored!.key);

    expect(first?.bytes.byteLength).toBeGreaterThan(0);
    expect(first?.etag).toBe(second?.etag);
    expect(await store.read(actor, "../../etc/passwd")).toBeNull();
    expect(await store.read(actor, "0".repeat(32))).toBeNull();
  });

  it("shrinks a large photo but never enlarges a small one", async () => {
    const big = "https://example.com/big.jpg";
    const small = "https://example.com/small.jpg";
    const { port } = fetchPortReturning(
      new Map([
        [big, await jpeg(3000, 1500)],
        [small, await jpeg(300, 200)]
      ])
    );
    const store = new SportsPhotoStore({ vault, fetchBytes: port });

    const shrunk = await store.ensure(actor, "source-a", big);
    const untouched = await store.ensure(actor, "source-a", small);

    expect(shrunk).toEqual(expect.objectContaining({ width: 1280, height: 640 }));
    expect(untouched).toEqual(expect.objectContaining({ width: 300, height: 200 }));
  });

  it("rejects an oversized body and writes nothing to the folder", async () => {
    const url = "https://example.com/huge.jpg";
    const oversized = Buffer.concat([
      await jpeg(400, 300),
      Buffer.alloc(3 * 1024 * 1024, 0x20)
    ]);
    const { port } = fetchPortReturning(new Map([[url, oversized]]));
    const store = new SportsPhotoStore({ vault, fetchBytes: port });

    expect(await store.ensure(actor, "source-a", url)).toBeNull();
    expect(await storedFiles("user-a")).toHaveLength(0);
  });

  it("gives the download no more time than the refresh has left", async () => {
    const url = "https://example.com/slow.jpg";
    const timeouts: (number | undefined)[] = [];
    const port: SportsIconFetchPort = async (_url, options) => {
      timeouts.push(options?.timeoutMs);
      return { ok: false, reason: "timeout" };
    };
    const store = new SportsPhotoStore({ vault, fetchBytes: port });

    await store.ensure(actor, "source-a", url, { timeBudgetMs: 1_200 });
    await store.ensure(actor, "source-a", url, { timeBudgetMs: 30_000 });
    const refused = await store.ensure(actor, "source-a", url, { timeBudgetMs: 0 });

    expect(timeouts).toEqual([1_200, 5_000]);
    expect(refused).toBeNull();
  });

  it("treats a copy whose image file has been deleted as missing and fetches it again", async () => {
    const url = "https://example.com/photo.jpg";
    const { port, calls } = fetchPortReturning(new Map([[url, await jpeg(900, 600)]]));
    const store = new SportsPhotoStore({ vault, fetchBytes: port });
    const stored = await store.ensure(actor, "source-a", url);

    await rm(join(baseDir, "user-a", "sports", "photos", `${stored!.key}.webp`));
    const again = await store.ensure(actor, "source-a", url);

    expect(calls).toHaveLength(2);
    expect(again?.key).toBe(stored!.key);
    expect(await storedFiles("user-a")).toContain(`${stored!.key}.webp`);
  });

  it("records which stored copy a headline serves, per owner", async () => {
    const { port } = fetchPortReturning(new Map());
    const store = new SportsPhotoStore({ vault, fetchBytes: port });

    store.linkHeadline("user-a", "source-a:item-1", "abc");

    expect(store.keyForHeadline("user-a", "source-a:item-1")).toBe("abc");
    expect(store.keyForHeadline("user-b", "source-a:item-1")).toBeNull();
  });
});

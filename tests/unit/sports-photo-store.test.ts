import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AccessContext } from "@moss/db";
import { VaultContextRunner } from "@moss/vault";

import type { SportsIconFetchPort } from "../../packages/sports/src/source/icon-route.js";
import { photoKey } from "../../packages/sports/src/source/photo.js";
import {
  SPORTS_PHOTO_DEADLINE_MARGIN_MS,
  SportsPhotoStore,
  type EnsurePhotoResult,
  type StoredPhoto
} from "../../packages/sports/src/source/photo-store.js";

const actor: AccessContext = { actorUserId: "user-a", requestId: "request-a" };
const other: AccessContext = { actorUserId: "user-b", requestId: "request-b" };

/** The copy the store made, or nothing when it declined for any reason. */
function photoOf(result: EnsurePhotoResult): StoredPhoto | null {
  return result.outcome === "stored" ? result.photo : null;
}

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

    const stored = photoOf(await store.ensure(actor, "source-a", url));

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

    expect(await store.ensure(actor, "source-a", notImage)).toEqual({ outcome: "unusable" });
    expect(await store.ensure(actor, "source-a", tiny)).toEqual({ outcome: "unusable" });
    expect(await storedFiles("user-a")).toHaveLength(0);
  });

  it("reports an unusable photo rather than throwing when the download fails", async () => {
    const { port } = fetchPortReturning(new Map());
    const store = new SportsPhotoStore({ vault, fetchBytes: port });

    expect(await store.ensure(actor, "source-a", "https://example.com/missing.jpg")).toEqual({
      outcome: "unusable"
    });
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

    const old = photoOf(await store.ensure(actor, "source-a", "https://example.com/old.jpg"));
    const kept = photoOf(await store.ensure(actor, "source-a", "https://example.com/kept.jpg"));
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

    const gone = photoOf(await store.ensure(actor, "source-a", "https://example.com/a.jpg"));
    const stays = photoOf(await store.ensure(actor, "source-b", "https://example.com/b.jpg"));

    await store.removeSource(actor, "source-a");

    const files = await storedFiles("user-a");
    expect(files).not.toContain(`${gone!.key}.webp`);
    expect(files).toContain(`${stays!.key}.webp`);
  });

  it("reads a stored copy back with a stable tag, and refuses a made-up key", async () => {
    const url = "https://example.com/photo.jpg";
    const { port } = fetchPortReturning(new Map([[url, await jpeg(900, 600)]]));
    const store = new SportsPhotoStore({ vault, fetchBytes: port });
    const stored = photoOf(await store.ensure(actor, "source-a", url));

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

    const shrunk = photoOf(await store.ensure(actor, "source-a", big));
    const untouched = photoOf(await store.ensure(actor, "source-a", small));

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

    expect(await store.ensure(actor, "source-a", url)).toEqual({ outcome: "unusable" });
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

    await store.ensure(actor, "source-a", url, { remainingMs: () => 4_000 });
    await store.ensure(actor, "source-a", url, { remainingMs: () => 30_000 });

    // Four seconds left is above the margin, so the download starts and gets exactly that long;
    // plenty of time is still capped at the store's own five second limit.
    expect(timeouts).toEqual([4_000, 5_000]);
  });

  it("starts no download once the refresh is inside its safety margin", async () => {
    const url = "https://example.com/slow.jpg";
    let calls = 0;
    const port: SportsIconFetchPort = async () => {
      calls += 1;
      return { ok: false, reason: "timeout" };
    };
    const store = new SportsPhotoStore({ vault, fetchBytes: port });

    const inMargin = await store.ensure(actor, "source-a", url, {
      remainingMs: () => SPORTS_PHOTO_DEADLINE_MARGIN_MS - 1
    });
    const none = await store.ensure(actor, "source-a", url, { remainingMs: () => 0 });

    expect(calls).toBe(0);
    // Skipped, not unusable: nothing was learned about the photo, so it is tried again next time.
    expect(inMargin).toEqual({ outcome: "skipped" });
    expect(none).toEqual({ outcome: "skipped" });
  });

  it("does not blame the photo when a shortened budget causes the timeout", async () => {
    const url = "https://example.com/slow.jpg";
    const port: SportsIconFetchPort = async () => ({ ok: false, reason: "timeout" });
    const store = new SportsPhotoStore({ vault, fetchBytes: port });

    const hurried = await store.ensure(actor, "source-a", url, { remainingMs: () => 4_000 });
    const unhurried = await store.ensure(actor, "source-a", url, { remainingMs: () => 30_000 });

    expect(hurried).toEqual({ outcome: "skipped" });
    expect(unhurried).toEqual({ outcome: "unusable" });
  });

  it("does nothing once the refresh has been cancelled", async () => {
    const url = "https://example.com/photo.jpg";
    const { port, calls } = fetchPortReturning(new Map([[url, await jpeg(900, 600)]]));
    const store = new SportsPhotoStore({ vault, fetchBytes: port });
    const controller = new AbortController();
    controller.abort();

    const result = await store.ensure(actor, "source-a", url, { signal: controller.signal });

    expect(result).toEqual({ outcome: "skipped" });
    expect(calls).toHaveLength(0);
  });

  it("treats a copy whose image file has been deleted as missing and fetches it again", async () => {
    const url = "https://example.com/photo.jpg";
    const { port, calls } = fetchPortReturning(new Map([[url, await jpeg(900, 600)]]));
    const store = new SportsPhotoStore({ vault, fetchBytes: port });
    const stored = photoOf(await store.ensure(actor, "source-a", url));

    await rm(join(baseDir, "user-a", "sports", "photos", `${stored!.key}.webp`));
    const again = photoOf(await store.ensure(actor, "source-a", url));

    expect(calls).toHaveLength(2);
    expect(again?.key).toBe(stored!.key);
    expect(await storedFiles("user-a")).toContain(`${stored!.key}.webp`);
  });

  it("keeps a copy that was served recently, even long after it was stored", async () => {
    const url = "https://example.com/photo.jpg";
    const { port } = fetchPortReturning(new Map([[url, await jpeg(400, 300)]]));
    let clock = Date.parse("2026-09-04T10:00:00.000Z");
    const store = new SportsPhotoStore({ vault, fetchBytes: port, now: () => new Date(clock) });
    const stored = photoOf(await store.ensure(actor, "source-a", url));

    clock += 15 * 24 * 60 * 60 * 1_000;
    await store.touch(actor, stored!.key);
    await store.sweep(actor, new Set());

    expect(await storedFiles("user-a")).toContain(`${stored!.key}.webp`);
  });

  it("tells listeners the key of every copy it removes", async () => {
    const bodies = new Map<string, Buffer>();
    const body = await jpeg(400, 300);
    bodies.set("https://example.com/a.jpg", body);
    const { port } = fetchPortReturning(bodies);
    const store = new SportsPhotoStore({ vault, fetchBytes: port });
    const removed: string[] = [];
    store.onCopyRemoved((key) => removed.push(key));

    const gone = photoOf(await store.ensure(actor, "source-a", "https://example.com/a.jpg"));
    store.linkHeadline("user-a", "source-a:item-1", gone!.key);
    await store.removeSource(actor, "source-a");

    expect(removed).toEqual([gone!.key]);
    expect(store.keyForHeadline("user-a", "source-a:item-1")).toBeNull();
  });

  it("records which stored copy a headline serves, per owner", async () => {
    const { port } = fetchPortReturning(new Map());
    const store = new SportsPhotoStore({ vault, fetchBytes: port });

    store.linkHeadline("user-a", "source-a:item-1", "abc");

    expect(store.keyForHeadline("user-a", "source-a:item-1")).toBe("abc");
    expect(store.keyForHeadline("user-b", "source-a:item-1")).toBeNull();
  });
});

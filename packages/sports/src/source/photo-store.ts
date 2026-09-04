import { createHash } from "node:crypto";

import type { AccessContext } from "@moss/db";
import {
  type VaultContext,
  type VaultContextRunner,
  deleteVaultFile,
  listVaultFiles,
  readVaultFile,
  readVaultFileBytes,
  vaultFileExists,
  writeVaultFile,
  writeVaultFileBytes
} from "@moss/vault";
import sharp from "sharp";

import { sniffSportsIconType, type SportsIconFetchPort } from "./icon-route.js";
import { photoKey, SPORTS_PHOTO_MIN_SHORT_SIDE } from "./photo.js";

/**
 * #2237 slice 1 — the owner's private copy of a story photo (spec decision 4). Every byte goes
 * through `VaultContext`, never raw `fs`, so a copy inherits the vault's owner-only permissions
 * and a request can only ever reach the actor's own files.
 */

export const SPORTS_PHOTO_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
export const SPORTS_PHOTO_DOWNLOAD_TIMEOUT_MS = 5_000;
/**
 * No new network call in the photo pass may start with less than this left of the refresh
 * deadline. The spec's promise is that photo work never delays headlines, and it allows a story
 * to go out without a photo when the deadline is near, so the answer is to skip, never to squeeze
 * one more request in. This gates the byte download; the reader gates its article page fetch on
 * the same number.
 */
export const SPORTS_PHOTO_DEADLINE_MARGIN_MS = 3_000;
export const SPORTS_PHOTO_MAX_WIDTH = 1280;
export const SPORTS_PHOTO_MAX_HEIGHT = 720;

const PHOTO_DIR = "sports/photos";
const DEFAULT_MAX_COPIES_PER_OWNER = 200;
const DEFAULT_MAX_BYTES_PER_OWNER = 41_943_040;
const DEFAULT_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
// The headline-to-copy map is rebuilt by every refresh; it is a lookup, never the record of
// truth. A copy whose headline is not in it answers 404 and is re-attached on the next refresh.
const HEADLINE_LINK_LIMIT = 4_000;

export interface StoredPhoto {
  readonly key: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

export interface SportsPhotoLimits {
  readonly maxCopiesPerOwner: number;
  readonly maxBytesPerOwner: number;
  readonly retentionMs: number;
}

export interface SportsPhotoStoreDependencies {
  readonly vault: VaultContextRunner;
  readonly fetchBytes: SportsIconFetchPort;
  readonly now?: () => Date;
  readonly limits?: Partial<SportsPhotoLimits>;
  /** Waits the given time. Injectable so a test can prove the timeout without really waiting. */
  readonly delay?: (ms: number) => Promise<void>;
}

interface PhotoSidecar {
  readonly sourceId: string;
  readonly publisherUrl: string;
  readonly fetchedAt: string;
  readonly lastServedAt: string;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

function webpPath(key: string): string {
  return `${PHOTO_DIR}/${key}.webp`;
}

function sidecarPath(key: string): string {
  return `${PHOTO_DIR}/${key}.json`;
}

const KEY_RE = /^[0-9a-f]{32}$/;

export type EnsurePhotoResult =
  | { readonly outcome: "stored"; readonly photo: StoredPhoto }
  /** This photo is bad or unavailable. Worth remembering so it is not fetched again. */
  | { readonly outcome: "unusable" }
  /** Nothing was learned about the photo — out of time, or cancelled. Try again next refresh. */
  | { readonly outcome: "skipped" };

const UNUSABLE = { outcome: "unusable" } as const;
const SKIPPED = { outcome: "skipped" } as const;

/** Told the key of every copy the store removes, so callers can drop anything they cached. */
export type PhotoRemovalListener = (key: string) => void;

function parseSidecar(raw: string): PhotoSidecar | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Record<string, unknown>;
    if (
      typeof value["sourceId"] !== "string" ||
      typeof value["publisherUrl"] !== "string" ||
      typeof value["fetchedAt"] !== "string" ||
      typeof value["lastServedAt"] !== "string" ||
      typeof value["width"] !== "number" ||
      typeof value["height"] !== "number" ||
      typeof value["bytes"] !== "number"
    ) {
      return null;
    }
    return {
      sourceId: value["sourceId"],
      publisherUrl: value["publisherUrl"],
      fetchedAt: value["fetchedAt"],
      lastServedAt: value["lastServedAt"],
      originalWidth: typeof value["originalWidth"] === "number" ? value["originalWidth"] : 0,
      originalHeight: typeof value["originalHeight"] === "number" ? value["originalHeight"] : 0,
      width: value["width"],
      height: value["height"],
      bytes: value["bytes"]
    };
  } catch {
    return null;
  }
}

export class SportsPhotoStore {
  private readonly limits: SportsPhotoLimits;
  private readonly now: () => Date;
  private readonly delay: (ms: number) => Promise<void>;
  /** `<actor id>\0<headline id>` to photo key, so the route can join without a second table. */
  private readonly headlineKeys = new Map<string, string>();
  private readonly removalListeners: PhotoRemovalListener[] = [];

  constructor(private readonly dependencies: SportsPhotoStoreDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.delay =
      dependencies.delay ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms).unref();
        }));
    this.limits = {
      maxCopiesPerOwner: dependencies.limits?.maxCopiesPerOwner ?? DEFAULT_MAX_COPIES_PER_OWNER,
      maxBytesPerOwner: dependencies.limits?.maxBytesPerOwner ?? DEFAULT_MAX_BYTES_PER_OWNER,
      retentionMs: dependencies.limits?.retentionMs ?? DEFAULT_RETENTION_MS
    };
  }

  /**
   * Downloads, checks, resizes and stores one photo, or returns the copy that already exists.
   * Never throws: a photo miss must not cost the caller its headlines. "unusable" and "skipped"
   * are kept apart so the caller can remember a bad photo without remembering one it simply ran
   * out of time for.
   */
  async ensure(
    access: AccessContext,
    sourceId: string,
    photoUrl: string,
    opts: { readonly signal?: AbortSignal; readonly remainingMs?: () => number } = {}
  ): Promise<EnsurePhotoResult> {
    if (opts.signal?.aborted) return SKIPPED;
    const key = photoKey(sourceId, photoUrl);
    let host: string;
    try {
      host = new URL(photoUrl).hostname;
    } catch {
      return UNUSABLE;
    }
    return this.dependencies.vault.withVaultContext(access, async (ctx) => {
      const existing = await this.readSidecar(ctx, key);
      // The sidecar alone does not prove the copy is servable — the image itself may have been
      // deleted underneath us — so a sidecar without its image is treated as no copy at all.
      if (existing && (await vaultFileExists(ctx, webpPath(key)))) {
        return {
          outcome: "stored" as const,
          photo: { key, width: existing.width, height: existing.height, bytes: existing.bytes }
        };
      }
      // Measured here, after the reads above, so the number reflects the time that is actually
      // left when the request goes out rather than when this method was entered.
      const remaining = opts.remainingMs?.() ?? SPORTS_PHOTO_DOWNLOAD_TIMEOUT_MS;
      if (opts.signal?.aborted) return SKIPPED;
      if (remaining <= SPORTS_PHOTO_DEADLINE_MARGIN_MS) return SKIPPED;
      const timeoutMs = Math.min(SPORTS_PHOTO_DOWNLOAD_TIMEOUT_MS, remaining);
      // The budget is enforced here, not merely passed down: a host that accepts the connection
      // and then says nothing would otherwise hold the whole refresh open for as long as it liked.
      const fetched = await Promise.race([
        this.dependencies.fetchBytes(photoUrl, {
          allowedHosts: [host],
          maxBytes: SPORTS_PHOTO_MAX_DOWNLOAD_BYTES,
          rejectOversizedResponses: true,
          timeoutMs
        }),
        this.delay(timeoutMs).then(() => ({ ok: false, reason: "timeout" }) as const)
      ]);
      if (opts.signal?.aborted) return SKIPPED;
      if (!fetched.ok) {
        // A timeout under a budget shortened by the refresh deadline is the deadline's doing, not
        // the photo's, so it stays retryable.
        const shortened = timeoutMs < SPORTS_PHOTO_DOWNLOAD_TIMEOUT_MS;
        return shortened && fetched.reason === "timeout" ? SKIPPED : UNUSABLE;
      }
      if (fetched.truncated) return UNUSABLE;
      if (fetched.body.byteLength > SPORTS_PHOTO_MAX_DOWNLOAD_BYTES) return UNUSABLE;
      const type = sniffSportsIconType(fetched.body);
      if (!type || type === "image/x-icon") return UNUSABLE;
      const buffer = Buffer.from(fetched.body);
      let originalWidth: number;
      let originalHeight: number;
      let encoded: { data: Buffer; info: { width: number; height: number; size: number } };
      try {
        const metadata = await sharp(buffer, { animated: false }).metadata();
        originalWidth = metadata.width ?? 0;
        originalHeight = metadata.height ?? 0;
        if (Math.min(originalWidth, originalHeight) < SPORTS_PHOTO_MIN_SHORT_SIDE) return UNUSABLE;
        encoded = await sharp(buffer, { animated: false })
          .resize({
            width: SPORTS_PHOTO_MAX_WIDTH,
            height: SPORTS_PHOTO_MAX_HEIGHT,
            fit: "inside",
            withoutEnlargement: true
          })
          .webp({ quality: 80 })
          .toBuffer({ resolveWithObject: true });
      } catch {
        return UNUSABLE;
      }
      const stored: StoredPhoto = {
        key,
        width: encoded.info.width,
        height: encoded.info.height,
        bytes: encoded.info.size
      };
      const timestamp = this.now().toISOString();
      const sidecar: PhotoSidecar = {
        sourceId,
        publisherUrl: photoUrl,
        fetchedAt: timestamp,
        lastServedAt: timestamp,
        originalWidth,
        originalHeight,
        width: stored.width,
        height: stored.height,
        bytes: stored.bytes
      };
      await writeVaultFileBytes(ctx, webpPath(key), encoded.data);
      await writeVaultFile(ctx, sidecarPath(key), JSON.stringify(sidecar));
      await this.trimToCaps(ctx);
      return { outcome: "stored" as const, photo: stored };
    });
  }

  /** Reads a stored copy and stamps its last-served time, which is what retention measures. */
  async read(
    access: AccessContext,
    key: string
  ): Promise<{ bytes: Buffer; etag: string } | null> {
    if (!KEY_RE.test(key)) return null;
    return this.dependencies.vault.withVaultContext(access, async (ctx) => {
      let bytes: Buffer;
      try {
        bytes = await readVaultFileBytes(ctx, webpPath(key));
      } catch {
        // The image is gone, which only happens if something removed it behind our back. Treat
        // it exactly like a removal so the story stops pointing at it and nobody keeps serving
        // stale bytes from memory. Cheaper than checking the disk on every request.
        this.announceRemoval(key);
        return null;
      }
      const sidecar = await this.readSidecar(ctx, key);
      if (sidecar) {
        await writeVaultFile(
          ctx,
          sidecarPath(key),
          JSON.stringify({ ...sidecar, lastServedAt: this.now().toISOString() })
        );
      }
      const etag = `"${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}"`;
      return { bytes, etag };
    });
  }

  /**
   * Stamps a copy's last-served time without reading its bytes, for a caller that served the
   * photo from its own memory. Without this, a constantly served photo looks untouched to
   * retention and gets swept while people are still looking at it.
   */
  async touch(access: AccessContext, key: string): Promise<void> {
    if (!KEY_RE.test(key)) return;
    await this.dependencies.vault.withVaultContext(access, async (ctx) => {
      const sidecar = await this.readSidecar(ctx, key);
      if (!sidecar) return;
      await writeVaultFile(
        ctx,
        sidecarPath(key),
        JSON.stringify({ ...sidecar, lastServedAt: this.now().toISOString() })
      );
    });
  }

  /** Registers a listener told the key of every copy this store removes. */
  onCopyRemoved(listener: PhotoRemovalListener): void {
    this.removalListeners.push(listener);
  }

  /** Removes copies past retention, then trims to the per-owner caps (spec decision 4). */
  async sweep(
    access: AccessContext,
    keepKeys: ReadonlySet<string>
  ): Promise<{ removed: number }> {
    return this.dependencies.vault.withVaultContext(access, async (ctx) => {
      const entries = await this.listCopies(ctx);
      const cutoff = this.now().getTime() - this.limits.retentionMs;
      let removed = 0;
      for (const entry of entries) {
        if (keepKeys.has(entry.key)) continue;
        if (Date.parse(entry.sidecar.lastServedAt) >= cutoff) continue;
        await this.removeCopy(ctx, entry.key);
        removed += 1;
      }
      return { removed: removed + (await this.trimToCaps(ctx)) };
    });
  }

  /** Removes every copy belonging to one source, in the same request that removes the source. */
  async removeSource(access: AccessContext, sourceId: string): Promise<void> {
    await this.dependencies.vault.withVaultContext(access, async (ctx) => {
      for (const entry of await this.listCopies(ctx)) {
        if (entry.sidecar.sourceId === sourceId) await this.removeCopy(ctx, entry.key);
      }
    });
  }

  /** Records which stored copy a persisted headline id resolves to, for the serving route. */
  linkHeadline(actorUserId: string, headlineId: string, key: string): void {
    const mapKey = `${actorUserId}\0${headlineId}`;
    this.headlineKeys.delete(mapKey);
    this.headlineKeys.set(mapKey, key);
    while (this.headlineKeys.size > HEADLINE_LINK_LIMIT) {
      const oldest = this.headlineKeys.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.headlineKeys.delete(oldest);
    }
  }

  keyForHeadline(actorUserId: string, headlineId: string): string | null {
    return this.headlineKeys.get(`${actorUserId}\0${headlineId}`) ?? null;
  }

  private async readSidecar(ctx: VaultContext, key: string): Promise<PhotoSidecar | null> {
    try {
      return parseSidecar(await readVaultFile(ctx, sidecarPath(key)));
    } catch {
      return null;
    }
  }

  private async listCopies(
    ctx: VaultContext
  ): Promise<Array<{ key: string; sidecar: PhotoSidecar }>> {
    let names: string[];
    try {
      names = await listVaultFiles(ctx, PHOTO_DIR);
    } catch {
      return [];
    }
    const copies: Array<{ key: string; sidecar: PhotoSidecar }> = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const key = name.slice(0, -".json".length);
      if (!KEY_RE.test(key)) continue;
      const sidecar = await this.readSidecar(ctx, key);
      if (sidecar) copies.push({ key, sidecar });
    }
    return copies;
  }

  private async removeCopy(ctx: VaultContext, key: string): Promise<void> {
    for (const path of [webpPath(key), sidecarPath(key)]) {
      try {
        await deleteVaultFile(ctx, path);
      } catch {
        // Already gone: a concurrent sweep or a partial write. Nothing to undo.
      }
    }
    this.announceRemoval(key);
  }

  /**
   * Drops every story pointing at a removed copy and tells anyone holding its bytes, so a deleted
   * photo stops being served from someone else's memory.
   */
  private announceRemoval(key: string): void {
    for (const [mapKey, value] of this.headlineKeys) {
      if (value === key) this.headlineKeys.delete(mapKey);
    }
    for (const listener of this.removalListeners) {
      try {
        listener(key);
      } catch {
        // A listener must never break housekeeping.
      }
    }
  }

  /** Least-recently-served first, until the owner's folder is inside both caps. */
  private async trimToCaps(ctx: VaultContext): Promise<number> {
    const entries = (await this.listCopies(ctx)).sort(
      (left, right) =>
        Date.parse(left.sidecar.lastServedAt) - Date.parse(right.sidecar.lastServedAt)
    );
    let count = entries.length;
    let bytes = entries.reduce((total, entry) => total + entry.sidecar.bytes, 0);
    let removed = 0;
    for (const entry of entries) {
      if (count <= this.limits.maxCopiesPerOwner && bytes <= this.limits.maxBytesPerOwner) break;
      await this.removeCopy(ctx, entry.key);
      count -= 1;
      bytes -= entry.sidecar.bytes;
      removed += 1;
    }
    return removed;
  }
}

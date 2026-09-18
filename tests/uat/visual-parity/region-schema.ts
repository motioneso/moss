// tests/uat/visual-parity/region-schema.ts
//
// VP-REGIONS-R2: declaration types, parsers and rectangle/partition validation for the
// region/transition contract. Extracted from region-comparison.ts to stay under the file-size
// gate; no pixel I/O or run orchestration lives here. region-comparison.ts imports from this
// file, never the other way around.
//
// A capture declares named rectangles ("regions"): reference-owned (compared against an
// approved reference image) or behavior-changed (allowed to differ from the historical base,
// never auto-compared). A size transition may additionally declare base-guard translate
// regions: unchanged pixels that moved position, compared base-rect to head-rect so a
// regression inside the moved band still fails. Newly exposed or removed bands are owned
// explicitly, never guarded.

export const REGION_PURPOSES = ["reference-owned", "behavior-changed", "base-guard"] as const;
export type RegionPurpose = (typeof REGION_PURPOSES)[number];

export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RegionDeclaration {
  readonly id: string;
  readonly purpose: RegionPurpose;
  readonly rect: PixelRect;
  // Reference-owned only: the corresponding rect in the reference image, when it differs
  // from `rect`. Defaults to `rect`.
  readonly referenceRect?: PixelRect;
  // Whole-image reference ownership: covers the entire image, compares to the reference in
  // full, and binds no complement (there is none).
  readonly fullImage?: boolean;
  // Required for behavior-changed regions: a short description/ticket/task naming the
  // evidence that the allowed difference was reviewed.
  readonly behaviorEvidence?: string;
}

export interface RegionSetDeclaration {
  readonly imageSize: { readonly width: number; readonly height: number };
  readonly regions: readonly RegionDeclaration[];
}

export interface TransitionRegion {
  readonly id: string;
  readonly kind: "translate" | "removed-band" | "new-band";
  readonly purpose: RegionPurpose;
  readonly baseRect?: PixelRect; // translate/removed-band: rect in the old/base image.
  readonly headRect?: PixelRect; // translate/new-band: rect in the new/target (head) image.
  readonly referenceRect?: PixelRect; // translate, reference-owned only: rect in the reference image.
  // Required for behavior-changed regions: a short description/ticket/task naming the evidence reviewed.
  readonly behaviorEvidence?: string;
}

export interface SizeTransitionDeclaration {
  readonly oldSize: { readonly width: number; readonly height: number };
  readonly targetSize: { readonly width: number; readonly height: number };
  readonly regions: readonly TransitionRegion[];
  // Expected capture-crop origin (top-left, page coordinates) at target size. The spec checks
  // the captured crop against this within a 2px tolerance; raster width/height must match
  // targetSize exactly.
  readonly expectedGeometry: { readonly x: number; readonly y: number };
}

export function fail(message: string): never {
  throw new Error(`parity region comparison: ${message}`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be nonempty`);
  return value;
}

function finiteInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value))
    fail(`${label} must be a finite integer`);
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    fail(`${label} must be a finite number`);
  return value;
}

function dimensions(value: unknown, label: string): { width: number; height: number } {
  const input = object(value, label);
  const width = finiteInt(input.width, `${label}.width`);
  const height = finiteInt(input.height, `${label}.height`);
  if (width <= 0 || height <= 0) fail(`${label} must be positive`);
  return { width, height };
}

function rect(value: unknown, label: string): PixelRect {
  const input = object(value, label);
  const x = finiteInt(input.x, `${label}.x`);
  const y = finiteInt(input.y, `${label}.y`);
  const width = finiteInt(input.width, `${label}.width`);
  const height = finiteInt(input.height, `${label}.height`);
  if (width <= 0 || height <= 0) fail(`${label} must have positive dimensions`);
  return { x, y, width, height };
}

function purpose(value: unknown, label: string): RegionPurpose {
  if (typeof value !== "string" || !(REGION_PURPOSES as readonly string[]).includes(value))
    fail(`${label} must be one of ${REGION_PURPOSES.join(", ")}`);
  return value as RegionPurpose;
}

const TRANSITION_KINDS = ["translate", "removed-band", "new-band"] as const;

function transitionKind(value: unknown, label: string): TransitionRegion["kind"] {
  if (typeof value !== "string" || !(TRANSITION_KINDS as readonly string[]).includes(value))
    fail(`${label} must be translate, removed-band or new-band`);
  return value as TransitionRegion["kind"];
}

export function rectInBounds(r: PixelRect, width: number, height: number): boolean {
  return r.x >= 0 && r.y >= 0 && r.x + r.width <= width && r.y + r.height <= height;
}

export function rectsOverlap(a: PixelRect, b: PixelRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function assertNoOverlap(
  rects: readonly { readonly id: string; readonly rect: PixelRect }[]
): void {
  for (let i = 0; i < rects.length; i += 1)
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i]!;
      const b = rects[j]!;
      if (rectsOverlap(a.rect, b.rect)) fail(`region ${a.id} overlaps region ${b.id}`);
    }
}

// Disjoint, in-bounds rects whose areas sum to the bounding area must tile it exactly:
// coverage cannot exceed the bound, so equal total area rules out any gap.
function assertExhaustivePartition(
  width: number,
  height: number,
  rects: readonly PixelRect[],
  label: string
): void {
  for (const r of rects) if (!rectInBounds(r, width, height)) fail(`${label} rect out of bounds`);
  for (let i = 0; i < rects.length; i += 1)
    for (let j = i + 1; j < rects.length; j += 1)
      if (rectsOverlap(rects[i]!, rects[j]!)) fail(`${label} rects overlap`);
  const total = rects.reduce((sum, r) => sum + r.width * r.height, 0);
  if (total !== width * height) fail(`${label} coverage is not exhaustive`);
}

export function parseRegionSet(value: unknown): RegionSetDeclaration {
  const input = object(value, "regionSet");
  const imageSize = dimensions(input.imageSize, "regionSet.imageSize");
  if (!Array.isArray(input.regions) || input.regions.length === 0)
    fail("regionSet.regions must be nonempty");
  const regions = input.regions.map((entry, index) => {
    const label = `regionSet.regions[${index}]`;
    const record = object(entry, label);
    const id = nonEmptyString(record.id, `${label}.id`);
    const regionPurpose = purpose(record.purpose, `${label}.purpose`);
    const regionRect = rect(record.rect, `${label}.rect`);
    if (!rectInBounds(regionRect, imageSize.width, imageSize.height))
      fail(`${label}.rect is out of bounds`);
    const fullImage = record.fullImage === true;
    if (fullImage) {
      if (
        regionPurpose !== "reference-owned" ||
        regionRect.x !== 0 ||
        regionRect.y !== 0 ||
        regionRect.width !== imageSize.width ||
        regionRect.height !== imageSize.height
      )
        fail(`${label} fullImage requires a reference-owned rect covering the whole image`);
    }
    if (regionPurpose === "base-guard")
      fail(`${label}.purpose base-guard is only valid for size-transition translate regions`);
    const referenceRect =
      record.referenceRect === undefined
        ? undefined
        : rect(record.referenceRect, `${label}.referenceRect`);
    if (referenceRect && regionPurpose !== "reference-owned")
      fail(`${label}.referenceRect is only valid for reference-owned regions`);
    const behaviorEvidence =
      record.behaviorEvidence === undefined
        ? undefined
        : nonEmptyString(record.behaviorEvidence, `${label}.behaviorEvidence`);
    if (regionPurpose === "behavior-changed" && !behaviorEvidence)
      fail(`${label}.behaviorEvidence is required for behavior-changed regions`);
    if (behaviorEvidence !== undefined && regionPurpose !== "behavior-changed")
      fail(`${label}.behaviorEvidence is only valid for behavior-changed regions`);
    return {
      id,
      purpose: regionPurpose,
      rect: regionRect,
      referenceRect,
      fullImage,
      behaviorEvidence
    };
  });
  const seen = new Set<string>();
  for (const region of regions) {
    if (seen.has(region.id)) fail(`duplicate region id: ${region.id}`);
    seen.add(region.id);
  }
  if (regions.some((r) => r.fullImage) && regions.length > 1)
    fail("a fullImage region cannot share a regionSet with other regions");
  assertNoOverlap(regions);
  return { imageSize, regions };
}

export function parseSizeTransition(value: unknown): SizeTransitionDeclaration {
  const input = object(value, "sizeTransition");
  const oldSize = dimensions(input.oldSize, "sizeTransition.oldSize");
  const targetSize = dimensions(input.targetSize, "sizeTransition.targetSize");
  if (!Array.isArray(input.regions) || input.regions.length === 0)
    fail("sizeTransition.regions must be nonempty");
  const regions = input.regions.map((entry, index) => {
    const label = `sizeTransition.regions[${index}]`;
    const record = object(entry, label);
    const id = nonEmptyString(record.id, `${label}.id`);
    const kind = transitionKind(record.kind, `${label}.kind`);
    const regionPurpose = purpose(record.purpose, `${label}.purpose`);
    const baseRect =
      record.baseRect === undefined ? undefined : rect(record.baseRect, `${label}.baseRect`);
    const headRect =
      record.headRect === undefined ? undefined : rect(record.headRect, `${label}.headRect`);
    const referenceRect =
      record.referenceRect === undefined
        ? undefined
        : rect(record.referenceRect, `${label}.referenceRect`);
    if (kind === "translate") {
      if (!baseRect || !headRect) fail(`${label} translate requires baseRect and headRect`);
      if (baseRect.width !== headRect.width || baseRect.height !== headRect.height)
        fail(`${label} translate cannot scale: base and head rect dimensions must match`);
      if (!rectInBounds(baseRect, oldSize.width, oldSize.height))
        fail(`${label}.baseRect is out of bounds`);
      if (!rectInBounds(headRect, targetSize.width, targetSize.height))
        fail(`${label}.headRect is out of bounds`);
    } else if (kind === "removed-band") {
      if (!baseRect || headRect) fail(`${label} removed-band requires only baseRect`);
      if (!rectInBounds(baseRect, oldSize.width, oldSize.height))
        fail(`${label}.baseRect is out of bounds`);
      // Removed pixels have no counterpart in the head or reference image.
      if (regionPurpose === "reference-owned")
        fail(
          `${label} removed-band cannot be reference-owned: nothing exists in the head or ` +
            "reference image for pixels that no longer exist; declare behavior-changed instead"
        );
    } else {
      if (!headRect || baseRect) fail(`${label} new-band requires only headRect`);
      if (!rectInBounds(headRect, targetSize.width, targetSize.height))
        fail(`${label}.headRect is out of bounds`);
    }
    if (regionPurpose === "base-guard") {
      if (kind !== "translate")
        fail(`${label} base-guard requires kind translate: moved pixels keep equal-size rects`);
      if (referenceRect) fail(`${label}.referenceRect is only valid for reference-owned regions`);
      if (record.behaviorEvidence !== undefined)
        fail(`${label}.behaviorEvidence is only valid for behavior-changed regions`);
    }
    if (referenceRect && (kind !== "translate" || regionPurpose !== "reference-owned"))
      fail(`${label}.referenceRect is only valid for reference-owned translate regions`);
    // A reference-owned translate region must bind a referenceRect, or a region labeled
    // "reference-owned" could silently fall back to a base comparison instead.
    if (kind === "translate" && regionPurpose === "reference-owned" && !referenceRect)
      fail(`${label} reference-owned translate requires referenceRect`);
    const behaviorEvidence =
      record.behaviorEvidence === undefined
        ? undefined
        : nonEmptyString(record.behaviorEvidence, `${label}.behaviorEvidence`);
    if (regionPurpose === "behavior-changed" && !behaviorEvidence)
      fail(`${label}.behaviorEvidence is required for behavior-changed regions`);
    if (behaviorEvidence !== undefined && regionPurpose !== "behavior-changed")
      fail(`${label}.behaviorEvidence is only valid for behavior-changed regions`);
    return {
      id,
      kind,
      purpose: regionPurpose,
      baseRect,
      headRect,
      referenceRect,
      behaviorEvidence
    };
  });
  const seen = new Set<string>();
  for (const region of regions) {
    if (seen.has(region.id)) fail(`duplicate transition region id: ${region.id}`);
    seen.add(region.id);
  }
  const baseRects = regions.flatMap((r) => (r.baseRect ? [r.baseRect] : []));
  const headRects = regions.flatMap((r) => (r.headRect ? [r.headRect] : []));
  assertExhaustivePartition(oldSize.width, oldSize.height, baseRects, "sizeTransition base");
  assertExhaustivePartition(targetSize.width, targetSize.height, headRects, "sizeTransition head");
  const expectedGeometryInput = object(input.expectedGeometry, "sizeTransition.expectedGeometry");
  const expectedGeometry = {
    x: finiteNumber(expectedGeometryInput.x, "sizeTransition.expectedGeometry.x"),
    y: finiteNumber(expectedGeometryInput.y, "sizeTransition.expectedGeometry.y")
  };
  return { oldSize, targetSize, regions, expectedGeometry };
}

// tests/uat/visual-parity/region-comparison.ts
//
// VP-REGIONS-R1: the region/transition contract and its pixel comparator.
//
// A capture can declare named rectangles ("regions") inside its image. Each
// region is either reference-owned (compared against an approved reference
// image) or behavior-changed (allowed to differ from the historical base,
// never auto-compared). Every pixel that is not inside a declared region is
// still guarded against the historical base image (the "complement"). A case
// may also declare a size transition: its expected image dimensions move
// from an old/base size to a new target size, with an explicit pairwise
// geometry mapping (translate only, never scale) for guarded pixels and
// explicit ownership of any newly exposed or removed band of pixels.
//
// Percentages are always computed over the unmasked comparable pixel count
// for the specific comparison being reported, never over the whole image.
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

import { compareCaptureToBase, compareReferenceCapture } from "./capture.js";

export const REGION_PURPOSES = ["reference-owned", "behavior-changed"] as const;
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
  // Reference-owned only: the corresponding rect in the reference image, when it
  // differs from `rect`. Defaults to `rect`.
  readonly referenceRect?: PixelRect;
  // Whole-image reference ownership: the single region covers the entire image,
  // compares to the reference in full, and binds no complement (there is none).
  readonly fullImage?: boolean;
}

export interface RegionSetDeclaration {
  readonly imageSize: { readonly width: number; readonly height: number };
  readonly regions: readonly RegionDeclaration[];
}

export interface TransitionRegion {
  readonly id: string;
  readonly kind: "translate" | "removed-band" | "new-band";
  readonly purpose: RegionPurpose;
  // translate/removed-band: rect in the old/base image.
  readonly baseRect?: PixelRect;
  // translate/new-band: rect in the new/target (head) image.
  readonly headRect?: PixelRect;
  // translate, reference-owned only: rect in the reference image.
  readonly referenceRect?: PixelRect;
}

export interface SizeTransitionDeclaration {
  readonly oldSize: { readonly width: number; readonly height: number };
  readonly targetSize: { readonly width: number; readonly height: number };
  readonly regions: readonly TransitionRegion[];
}

function fail(message: string): never {
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

// Rects that are pairwise disjoint, individually in bounds, and whose areas sum
// to exactly the bounding area must tile it exactly: coverage cannot exceed the
// bound (disjoint + in-bounds), so equal total area rules out any gap.
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
    const referenceRect =
      record.referenceRect === undefined
        ? undefined
        : rect(record.referenceRect, `${label}.referenceRect`);
    if (referenceRect && regionPurpose !== "reference-owned")
      fail(`${label}.referenceRect is only valid for reference-owned regions`);
    return { id, purpose: regionPurpose, rect: regionRect, referenceRect, fullImage };
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
    } else {
      if (!headRect || baseRect) fail(`${label} new-band requires only headRect`);
      if (!rectInBounds(headRect, targetSize.width, targetSize.height))
        fail(`${label}.headRect is out of bounds`);
    }
    if (referenceRect && (kind !== "translate" || regionPurpose !== "reference-owned"))
      fail(`${label}.referenceRect is only valid for reference-owned translate regions`);
    return { id, kind, purpose: regionPurpose, baseRect, headRect, referenceRect };
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
  return { oldSize, targetSize, regions };
}

// --- pixel accounting -------------------------------------------------

function maskGrid(width: number, height: number, masks: readonly PixelRect[]): Uint8Array {
  const grid = new Uint8Array(width * height);
  for (const m of masks) {
    const x0 = Math.max(0, Math.floor(m.x));
    const y0 = Math.max(0, Math.floor(m.y));
    const x1 = Math.min(width, Math.ceil(m.x + m.width));
    const y1 = Math.min(height, Math.ceil(m.y + m.height));
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) grid[y * width + x] = 1;
  }
  return grid;
}

function paintIdentical(a: PNG, b: PNG, x: number, y: number): void {
  const i = (a.width * y + x) * 4;
  a.data[i] = 255;
  a.data[i + 1] = 0;
  a.data[i + 2] = 255;
  a.data[i + 3] = 255;
  b.data[i] = 255;
  b.data[i + 1] = 0;
  b.data[i + 2] = 255;
  b.data[i + 3] = 255;
}

function clonePng(png: PNG): PNG {
  const out = new PNG({ width: png.width, height: png.height });
  png.data.copy(out.data);
  return out;
}

export interface ComparisonOutcome {
  readonly numerator: number;
  readonly denominator: number;
  readonly percent: number;
  readonly outcome: "pass" | "fail";
}

function toOutcome(numerator: number, denominator: number, label: string): ComparisonOutcome {
  if (denominator <= 0) fail(`${label} has no comparable pixels (fully masked region cannot pass)`);
  const percent = (numerator / denominator) * 100;
  return { numerator, denominator, percent, outcome: percent <= 0.5 ? "pass" : "fail" };
}

// Compares only the pixels inside `rects` (a disjoint union) between two
// same-size images, painting everything outside them (and any masked pixel
// inside them) identically on both sides first so pixelmatch's diff count
// reflects only the target pixels. The denominator is the target area minus
// the masked pixels within it, never the whole image.
function compareWithinRects(
  a: PNG,
  b: PNG,
  rects: readonly PixelRect[],
  masks: readonly PixelRect[],
  label: string
): ComparisonOutcome {
  if (a.width !== b.width || a.height !== b.height) fail(`${label} images differ in size`);
  const width = a.width;
  const height = a.height;
  const grid = maskGrid(width, height, masks);
  const inTarget = new Uint8Array(width * height);
  for (const r of rects)
    for (let y = r.y; y < r.y + r.height; y += 1)
      for (let x = r.x; x < r.x + r.width; x += 1) inTarget[y * width + x] = 1;
  const aClone = clonePng(a);
  const bClone = clonePng(b);
  let denominator = 0;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      if (!inTarget[idx]) {
        paintIdentical(aClone, bClone, x, y);
        continue;
      }
      if (grid[idx]) {
        paintIdentical(aClone, bClone, x, y);
        continue;
      }
      denominator += 1;
    }
  const diff = new PNG({ width, height });
  const different = pixelmatch(aClone.data, bClone.data, diff.data, width, height, {
    threshold: 0.1,
    includeAA: true
  });
  return toOutcome(different, denominator, label);
}

// Compares two equal-size crops directly (used for size-transition translate
// pairs, where each pair's dimensions already match by construction).
function compareCrops(
  base: PNG,
  baseRect: PixelRect,
  head: PNG,
  headRect: PixelRect,
  masks: readonly PixelRect[],
  label: string
): ComparisonOutcome {
  if (baseRect.width !== headRect.width || baseRect.height !== headRect.height)
    fail(`${label} cannot scale: base and head rect dimensions must match`);
  const width = baseRect.width;
  const height = baseRect.height;
  const grid = maskGrid(head.width, head.height, masks);
  const aCrop = new PNG({ width, height });
  const bCrop = new PNG({ width, height });
  PNG.bitblt(base, aCrop, baseRect.x, baseRect.y, width, height, 0, 0);
  PNG.bitblt(head, bCrop, headRect.x, headRect.y, width, height, 0, 0);
  let denominator = width * height;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      if (grid[(headRect.y + y) * head.width + (headRect.x + x)]) {
        paintIdentical(aCrop, bCrop, x, y);
        denominator -= 1;
      }
    }
  const diff = new PNG({ width, height });
  const different = pixelmatch(aCrop.data, bCrop.data, diff.data, width, height, {
    threshold: 0.1,
    includeAA: true
  });
  return toOutcome(different, denominator, label);
}

export interface RegionComparisonResult {
  readonly id: string;
  readonly purpose: RegionPurpose;
  readonly comparedAgainst: "reference" | "base" | "none";
  readonly result?: ComparisonOutcome;
}

export interface RegionSetComparisonReport {
  readonly regions: readonly RegionComparisonResult[];
  // Absent exactly when a fullImage region binds no complement.
  readonly complement?: ComparisonOutcome;
}

// Compares a declared region set on same-size images: each reference-owned
// region against its reference, each behavior-changed region against nothing
// (recorded, never compared), and the exact complement (every remaining
// unmasked pixel) against the historical base.
export function compareRegionSet(
  declaration: RegionSetDeclaration,
  capture: PNG,
  base: PNG | null,
  references: ReadonlyMap<string, PNG>,
  masks: readonly PixelRect[]
): RegionSetComparisonReport {
  if (
    capture.width !== declaration.imageSize.width ||
    capture.height !== declaration.imageSize.height
  )
    fail("captured image does not match the declared region set size");
  const fullImage = declaration.regions.find((r) => r.fullImage);
  if (fullImage) {
    const reference = references.get(fullImage.id);
    if (!reference) fail(`missing reference bytes for region ${fullImage.id}`);
    const result = compareWithinRects(
      capture,
      reference,
      [fullImage.rect],
      masks,
      `region ${fullImage.id}`
    );
    return {
      regions: [
        { id: fullImage.id, purpose: fullImage.purpose, comparedAgainst: "reference", result }
      ]
    };
  }
  const regions: RegionComparisonResult[] = declaration.regions.map((region) => {
    if (region.purpose === "behavior-changed")
      return { id: region.id, purpose: region.purpose, comparedAgainst: "none" };
    const reference = references.get(region.id);
    if (!reference) fail(`missing reference bytes for region ${region.id}`);
    const referenceRect = region.referenceRect ?? region.rect;
    const result =
      referenceRect.x === region.rect.x &&
      referenceRect.y === region.rect.y &&
      referenceRect.width === region.rect.width &&
      referenceRect.height === region.rect.height
        ? compareWithinRects(capture, reference, [region.rect], masks, `region ${region.id}`)
        : compareCrops(
            capture,
            region.rect,
            reference,
            referenceRect,
            masks,
            `region ${region.id}`
          );
    return { id: region.id, purpose: region.purpose, comparedAgainst: "reference", result };
  });
  if (!base) return { regions };
  const owned = declaration.regions.map((r) => r.rect);
  const complement = compareWithinComplement(capture, base, owned, masks);
  return { regions, complement };
}

// The exact complement of the owned rects: every pixel not covered by any
// declared region and not masked, compared against the historical base.
function compareWithinComplement(
  capture: PNG,
  base: PNG,
  owned: readonly PixelRect[],
  masks: readonly PixelRect[]
): ComparisonOutcome {
  if (capture.width !== base.width || capture.height !== base.height)
    fail("complement compare requires equal-size capture and base images");
  const width = capture.width;
  const height = capture.height;
  const grid = maskGrid(width, height, masks);
  const ownedGrid = new Uint8Array(width * height);
  for (const r of owned)
    for (let y = r.y; y < r.y + r.height; y += 1)
      for (let x = r.x; x < r.x + r.width; x += 1) ownedGrid[y * width + x] = 1;
  const aClone = clonePng(capture);
  const bClone = clonePng(base);
  let denominator = 0;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      if (ownedGrid[idx] || grid[idx]) {
        paintIdentical(aClone, bClone, x, y);
        continue;
      }
      denominator += 1;
    }
  const diff = new PNG({ width, height });
  const different = pixelmatch(aClone.data, bClone.data, diff.data, width, height, {
    threshold: 0.1,
    includeAA: true
  });
  return toOutcome(different, denominator, "complement");
}

export interface TransitionComparisonResult {
  readonly id: string;
  readonly kind: TransitionRegion["kind"];
  readonly purpose: RegionPurpose;
  readonly comparedAgainst: "reference" | "base" | "none";
  readonly result?: ComparisonOutcome;
}

export interface SizeTransitionComparisonReport {
  readonly headSize: { readonly width: number; readonly height: number };
  readonly regions: readonly TransitionComparisonResult[];
}

// Compares a declared size transition: base/head must exactly match the
// declared old/target raster dimensions, translate pairs are compared
// directly (never scaled), reference-owned translate pairs also compare to
// their reference, and removed/new bands are recorded as owned but never
// pixel-compared (there is nothing on the other side to compare them to).
export function compareSizeTransition(
  declaration: SizeTransitionDeclaration,
  base: PNG,
  head: PNG,
  references: ReadonlyMap<string, PNG>,
  masks: readonly PixelRect[]
): SizeTransitionComparisonReport {
  if (base.width !== declaration.oldSize.width || base.height !== declaration.oldSize.height)
    fail("base image does not match the declared old size");
  if (head.width !== declaration.targetSize.width || head.height !== declaration.targetSize.height)
    fail("head image does not match the declared target size");
  const regions = declaration.regions.map((region): TransitionComparisonResult => {
    if (region.kind === "removed-band" || region.kind === "new-band")
      return { id: region.id, kind: region.kind, purpose: region.purpose, comparedAgainst: "none" };
    const baseRect = region.baseRect!;
    const headRect = region.headRect!;
    if (region.purpose === "behavior-changed")
      return { id: region.id, kind: region.kind, purpose: region.purpose, comparedAgainst: "none" };
    const result = compareCrops(base, baseRect, head, headRect, masks, `transition ${region.id}`);
    if (!region.referenceRect)
      return {
        id: region.id,
        kind: region.kind,
        purpose: region.purpose,
        comparedAgainst: "base",
        result
      };
    const reference = references.get(region.id);
    if (!reference) fail(`missing reference bytes for transition region ${region.id}`);
    const referenceResult = compareCrops(
      head,
      headRect,
      reference,
      region.referenceRect,
      masks,
      `transition ${region.id} reference`
    );
    if (referenceResult.outcome !== "pass")
      return {
        id: region.id,
        kind: region.kind,
        purpose: region.purpose,
        comparedAgainst: "reference",
        result: referenceResult
      };
    return {
      id: region.id,
      kind: region.kind,
      purpose: region.purpose,
      comparedAgainst: "base",
      result
    };
  });
  return { headSize: declaration.targetSize, regions };
}

// --- selected-execution entry points: read declared paths, run the same
// exported comparator, and reduce to a single pass/fail outcome for the spec
// to record. These are the only functions the selected test loop calls; they
// never reimplement comparison logic. ---

function aggregateOutcome(
  results: readonly { readonly result?: ComparisonOutcome }[],
  complement?: ComparisonOutcome
): "pass" | "fail" {
  const outcomes = results.flatMap((r) => (r.result ? [r.result.outcome] : []));
  if (complement) outcomes.push(complement.outcome);
  return outcomes.every((o) => o === "pass") ? "pass" : "fail";
}

export interface DeclaredRegionRunResult {
  readonly outcome: "pass" | "fail";
  readonly report: RegionSetComparisonReport;
  readonly baseSha256: string | null;
  readonly referenceSha256?: string;
}

// Reference-owned regions in one regionSet all draw from the same declared
// reference image (its sub-rects, via each region's referenceRect); there is
// one reference identity per case, not one per region.
export function runDeclaredRegionComparison(
  declaration: RegionSetDeclaration,
  capturePath: string,
  basePath: string | null,
  referencePath: string | null
): DeclaredRegionRunResult {
  const capture = PNG.sync.read(readFileSync(capturePath));
  const base = basePath ? PNG.sync.read(readFileSync(basePath)) : null;
  const references = new Map<string, PNG>();
  if (referencePath) {
    if (!existsSync(referencePath)) fail(`missing declared reference: ${referencePath}`);
    const referencePng = PNG.sync.read(readFileSync(referencePath));
    for (const region of declaration.regions)
      if (region.purpose === "reference-owned") references.set(region.id, referencePng);
  }
  const report = compareRegionSet(declaration, capture, base, references, []);
  return {
    outcome: aggregateOutcome(report.regions, report.complement),
    report,
    baseSha256: basePath ? sha256File(basePath) : null,
    referenceSha256: referencePath ? sha256File(referencePath) : undefined
  };
}

export interface DeclaredSizeTransitionRunResult {
  readonly outcome: "pass" | "fail";
  readonly report: SizeTransitionComparisonReport;
  readonly baseSha256: string;
  readonly referenceSha256?: string;
}

// One declared reference image supplies every translate region's
// referenceRect crop for this transition, same as runDeclaredRegionComparison.
export function runDeclaredSizeTransition(
  declaration: SizeTransitionDeclaration,
  basePath: string,
  headPath: string,
  referencePath: string | null
): DeclaredSizeTransitionRunResult {
  const base = PNG.sync.read(readFileSync(basePath));
  const head = PNG.sync.read(readFileSync(headPath));
  const references = new Map<string, PNG>();
  if (referencePath) {
    if (!existsSync(referencePath)) fail(`missing declared reference: ${referencePath}`);
    const referencePng = PNG.sync.read(readFileSync(referencePath));
    for (const region of declaration.regions)
      if (region.referenceRect) references.set(region.id, referencePng);
  }
  const report = compareSizeTransition(declaration, base, head, references, []);
  return {
    outcome: aggregateOutcome(report.regions),
    report,
    baseSha256: sha256File(basePath),
    referenceSha256: referencePath ? sha256File(referencePath) : undefined
  };
}

// Builds the one comparison object the selected test loop records for a case
// that declared regions or a sizeTransition, so the spec keeps only a call
// site and never inlines this branching.
export function buildRegionOrTransitionComparison(
  declaration: {
    readonly base?: string;
    readonly reference?: string;
    readonly regions?: RegionSetDeclaration;
    readonly sizeTransition?: SizeTransitionDeclaration;
  },
  expectedBase: string | null,
  outRoot: string,
  maskedPath: string,
  controls: { readonly zeroPercent: number; readonly changedPercent: number }
): {
  readonly outcome: "pass" | "fail";
  readonly expectedBase: string;
  readonly expectedReference?: string;
  readonly baseSha256?: string;
  readonly referenceSha256?: string;
  readonly zeroControlPercent: number;
  readonly changedControlPercent: number;
  readonly regionReport?: RegionSetComparisonReport;
  readonly transitionReport?: SizeTransitionComparisonReport;
} {
  if (expectedBase === null)
    fail("parity case selection: declared base without PARITY_EXPECTED_BASE");
  if (!declaration.base)
    fail("parity case selection: regions/sizeTransition require a declared base");
  const baseAbsolute = join(outRoot, declaration.base);
  if (!existsSync(baseAbsolute))
    fail(`parity case selection: missing declared baseline ${declaration.base}`);
  const referenceAbsolute = declaration.reference ? join(outRoot, declaration.reference) : null;
  if (declaration.sizeTransition) {
    const transition = runDeclaredSizeTransition(
      declaration.sizeTransition,
      baseAbsolute,
      maskedPath,
      referenceAbsolute
    );
    return {
      outcome: transition.outcome,
      expectedBase,
      expectedReference: declaration.reference,
      baseSha256: transition.baseSha256,
      ...(transition.referenceSha256 ? { referenceSha256: transition.referenceSha256 } : {}),
      zeroControlPercent: controls.zeroPercent,
      changedControlPercent: controls.changedPercent,
      transitionReport: transition.report
    };
  }
  const region = runDeclaredRegionComparison(
    declaration.regions!,
    maskedPath,
    baseAbsolute,
    referenceAbsolute
  );
  return {
    outcome: region.outcome,
    expectedBase,
    expectedReference: declaration.reference,
    ...(region.baseSha256 ? { baseSha256: region.baseSha256 } : {}),
    ...(region.referenceSha256 ? { referenceSha256: region.referenceSha256 } : {}),
    zeroControlPercent: controls.zeroPercent,
    changedControlPercent: controls.changedPercent,
    regionReport: region.report
  };
}

// Chooses which comparison a case actually runs (regions/transition, legacy
// base+reference, or a bare control) and returns the diff paths that go with
// it. This is the one entry point the spec calls per capture; it exists so
// the spec file itself stays under the file-size gate.
export function resolveEntryComparison(
  declaration: {
    readonly role?: string;
    readonly base?: string;
    readonly reference?: string;
    readonly regions?: RegionSetDeclaration;
    readonly sizeTransition?: SizeTransitionDeclaration;
  },
  expectedBase: string | null,
  outRoot: string,
  maskedPath: string,
  controls: { readonly zeroPercent: number; readonly changedPercent: number },
  mockupDiffPath: string
): {
  readonly comparison: {
    readonly outcome: "pass" | "fail" | "control" | "not-applicable";
    readonly expectedBase?: string;
    readonly expectedReference?: string;
    readonly baseSha256?: string;
    readonly referenceSha256?: string;
    readonly zeroControlPercent: number;
    readonly changedControlPercent: number;
    readonly regionReport?: RegionSetComparisonReport;
    readonly transitionReport?: SizeTransitionComparisonReport;
  };
  readonly diffPath: string;
  readonly referenceDiffPath?: string;
} {
  if (declaration.sizeTransition || declaration.regions)
    return {
      comparison: buildRegionOrTransitionComparison(
        declaration,
        expectedBase,
        outRoot,
        maskedPath,
        controls
      ),
      diffPath: mockupDiffPath
    };
  if (!declaration.base)
    return {
      comparison: {
        outcome: "control",
        zeroControlPercent: controls.zeroPercent,
        changedControlPercent: controls.changedPercent
      },
      diffPath: mockupDiffPath
    };
  if (expectedBase === null) fail("declared base without PARITY_EXPECTED_BASE");
  if (declaration.role === "owned-region/reference" && !declaration.reference)
    fail("owned-region/reference needs a reference identity");
  const baseAbsolute = join(outRoot, declaration.base);
  if (!existsSync(baseAbsolute)) fail(`missing declared baseline ${declaration.base}`);
  const baseDiffPath = mockupDiffPath.replace(/\.diff\.png$/, ".base.diff.png");
  const baseDiffPercent = compareCaptureToBase(maskedPath, baseAbsolute, baseDiffPath);
  const comparison = {
    outcome: (baseDiffPercent <= 0.5 ? "pass" : "fail") as "pass" | "fail",
    expectedBase,
    expectedReference: declaration.reference,
    baseSha256: sha256File(baseAbsolute),
    zeroControlPercent: controls.zeroPercent,
    changedControlPercent: controls.changedPercent
  };
  if (!declaration.reference) return { comparison, diffPath: baseDiffPath };
  const referenceDiffPath = mockupDiffPath.replace(/\.diff\.png$/, ".reference.diff.png");
  const reference = compareReferenceCapture(
    maskedPath,
    join(outRoot, declaration.reference),
    referenceDiffPath
  );
  return {
    comparison: { ...comparison, referenceSha256: reference.sha256 },
    diffPath: baseDiffPath,
    referenceDiffPath
  };
}

// --- provenance: recompute from actual bytes on disk, never trust a claim ---

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export interface RegionRunRecord {
  readonly caseId: string;
  readonly captureSha256: string;
  readonly baseSha256: string | null;
  readonly referenceSha256: Record<string, string>;
  readonly report: RegionSetComparisonReport;
}

// Reads the declared bytes from disk, re-runs the comparison, and returns a
// record whose hashes and outcomes are bound to the actual files. This is the
// only way a region run record should be produced.
export function buildRegionRunRecord(
  caseId: string,
  declaration: RegionSetDeclaration,
  capturePath: string,
  basePath: string | null,
  referencePaths: ReadonlyMap<string, string>,
  masks: readonly PixelRect[]
): RegionRunRecord {
  if (!existsSync(capturePath)) fail(`missing capture: ${capturePath}`);
  const capture = PNG.sync.read(readFileSync(capturePath));
  const base = basePath ? PNG.sync.read(readFileSync(basePath)) : null;
  const references = new Map<string, PNG>();
  const referenceSha256: Record<string, string> = {};
  for (const [id, path] of referencePaths) {
    if (!existsSync(path)) fail(`missing reference for region ${id}: ${path}`);
    references.set(id, PNG.sync.read(readFileSync(path)));
    referenceSha256[id] = sha256File(path);
  }
  const report = compareRegionSet(declaration, capture, base, references, masks);
  return {
    caseId,
    captureSha256: sha256File(capturePath),
    baseSha256: basePath ? sha256File(basePath) : null,
    referenceSha256,
    report
  };
}

// Validates a previously recorded region run against the actual bytes on
// disk right now: recomputes the comparison from scratch and requires every
// hash and outcome to match exactly. A claimed "pass" that disagrees with a
// fresh recompute (forged, stale, or bytes that moved under it) is rejected,
// never trusted at face value.
export function validateRegionRunRecord(
  record: RegionRunRecord,
  declaration: RegionSetDeclaration,
  capturePath: string,
  basePath: string | null,
  referencePaths: ReadonlyMap<string, string>,
  masks: readonly PixelRect[]
): void {
  const fresh = buildRegionRunRecord(
    record.caseId,
    declaration,
    capturePath,
    basePath,
    referencePaths,
    masks
  );
  if (fresh.captureSha256 !== record.captureSha256) fail("capture bytes changed since recording");
  if (fresh.baseSha256 !== record.baseSha256) fail("base identity changed since recording");
  for (const [id, sha] of Object.entries(fresh.referenceSha256))
    if (record.referenceSha256[id] !== sha) fail(`reference bytes changed since recording: ${id}`);
  if (JSON.stringify(fresh.report) !== JSON.stringify(record.report))
    fail("recorded region comparison does not match a fresh recompute of the actual bytes");
}

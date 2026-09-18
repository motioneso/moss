// tests/uat/visual-parity/region-comparison.ts
//
// VP-REGIONS-R1/R2: the region/transition pixel comparator, artifact I/O and run accounting.
// Declaration types, parsers and rectangle validation live in region-schema.ts; this file
// imports from there and never the reverse.
//
// A capture declares named rectangles ("regions"): reference-owned (compared against an
// approved reference image) or behavior-changed (allowed to differ from the historical base,
// never auto-compared). Every pixel outside a declared region (the "complement") is still
// guarded against the historical base. A case may also declare a size transition: expected
// image dimensions move from an old/base size to a new target size, with an explicit pairwise
// geometry mapping (translate only, never scale) for guarded pixels and explicit ownership of
// any newly exposed or removed band of pixels.
//
// Percentages are always computed over the unmasked comparable pixel count for the specific
// comparison being reported, never over the whole image.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

import { compareCaptureToBase, compareReferenceCapture } from "./capture.js";
import {
  REGION_PURPOSES,
  fail,
  parseRegionSet,
  parseSizeTransition,
  rectInBounds,
  rectsOverlap,
  type PixelRect,
  type RegionDeclaration,
  type RegionPurpose,
  type RegionSetDeclaration,
  type SizeTransitionDeclaration,
  type TransitionRegion
} from "./region-schema.js";

// Re-exported so existing consumers (case-selection.ts, the unit tests) keep importing the
// schema surface from this module without knowing it now lives in region-schema.ts.
export {
  REGION_PURPOSES,
  parseRegionSet,
  parseSizeTransition,
  rectInBounds,
  rectsOverlap,
  type PixelRect,
  type RegionDeclaration,
  type RegionPurpose,
  type RegionSetDeclaration,
  type SizeTransitionDeclaration,
  type TransitionRegion
};

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

// Writes a computed diff image to disk when a path is given (creating any missing parent
// directory first); a comparison with no path still runs, only the artifact write is skipped.
function writeDiffPng(diff: PNG, diffOutPath?: string): void {
  if (!diffOutPath) return;
  mkdirSync(dirname(diffOutPath), { recursive: true });
  writeFileSync(diffOutPath, PNG.sync.write(diff));
}

// Runs pixelmatch over two already-prepared same-size images (non-target pixels pre-painted
// identical by the caller), writes the diff, and reduces the result to one outcome. Shared by
// every comparator below so the threshold/AA settings and diff-write behavior stay in one place.
function runPixelmatch(
  a: PNG,
  b: PNG,
  width: number,
  height: number,
  denominator: number,
  label: string,
  diffOutPath?: string
): ComparisonOutcome {
  const diff = new PNG({ width, height });
  const different = pixelmatch(a.data, b.data, diff.data, width, height, {
    threshold: 0.1,
    includeAA: true
  });
  writeDiffPng(diff, diffOutPath);
  return toOutcome(different, denominator, label);
}

// Compares only pixels where `isTarget` is true, painting every other pixel identically on
// both sides first so pixelmatch's diff count reflects only the target pixels.
function compareTargetPixels(
  a: PNG,
  b: PNG,
  isTarget: (x: number, y: number) => boolean,
  label: string,
  diffOutPath?: string
): ComparisonOutcome {
  if (a.width !== b.width || a.height !== b.height) fail(`${label} images differ in size`);
  const { width, height } = a;
  const aClone = clonePng(a);
  const bClone = clonePng(b);
  let denominator = 0;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      if (isTarget(x, y)) denominator += 1;
      else paintIdentical(aClone, bClone, x, y);
    }
  return runPixelmatch(aClone, bClone, width, height, denominator, label, diffOutPath);
}

// Compares only pixels inside `rects` (a disjoint union) minus any masked pixel within them;
// the denominator is the target area minus its masked pixels, never the whole image.
function compareWithinRects(
  a: PNG,
  b: PNG,
  rects: readonly PixelRect[],
  masks: readonly PixelRect[],
  label: string,
  diffOutPath?: string
): ComparisonOutcome {
  const grid = maskGrid(a.width, a.height, masks);
  const inTarget = new Uint8Array(a.width * a.height);
  for (const r of rects)
    for (let y = r.y; y < r.y + r.height; y += 1)
      for (let x = r.x; x < r.x + r.width; x += 1) inTarget[y * a.width + x] = 1;
  return compareTargetPixels(
    a,
    b,
    (x, y) => inTarget[y * a.width + x] === 1 && !grid[y * a.width + x],
    label,
    diffOutPath
  );
}

// Compares two equal-size crops directly (size-transition translate pairs, whose dimensions
// already match by construction).
function compareCrops(
  base: PNG,
  baseRect: PixelRect,
  head: PNG,
  headRect: PixelRect,
  masks: readonly PixelRect[],
  label: string,
  diffOutPath?: string
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
  return runPixelmatch(aCrop, bCrop, width, height, denominator, label, diffOutPath);
}

export interface RegionComparisonResult {
  readonly id: string;
  readonly purpose: RegionPurpose;
  readonly comparedAgainst: "reference" | "base" | "none";
  readonly result?: ComparisonOutcome;
  readonly diffPath?: string; // present exactly when `result` is present
}

export interface RegionSetComparisonReport {
  readonly regions: readonly RegionComparisonResult[];
  readonly complement?: ComparisonOutcome; // absent when a fullImage region binds no complement
  // Present exactly when `complement` is present and a diff path was supplied: the
  // complement-vs-base diff, so validation can inventory every written diff.
  readonly complementDiffPath?: string;
}

// Compares a declared region set on same-size images: each reference-owned region against its
// reference, each behavior-changed region against nothing (recorded, never compared), and the
// exact complement (every remaining unmasked pixel) against the historical base.
export interface RegionSetDiffPaths {
  readonly regions?: ReadonlyMap<string, string>;
  readonly complement?: string;
}

export function compareRegionSet(
  declaration: RegionSetDeclaration,
  capture: PNG,
  base: PNG | null,
  references: ReadonlyMap<string, PNG>,
  masks: readonly PixelRect[],
  diffPaths?: RegionSetDiffPaths
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
    const diffPath = diffPaths?.regions?.get(fullImage.id);
    const result = compareWithinRects(
      capture,
      reference,
      [fullImage.rect],
      masks,
      `region ${fullImage.id}`,
      diffPath
    );
    return {
      regions: [
        {
          id: fullImage.id,
          purpose: fullImage.purpose,
          comparedAgainst: "reference",
          result,
          ...(diffPath ? { diffPath } : {})
        }
      ]
    };
  }
  const regions: RegionComparisonResult[] = declaration.regions.map((region) => {
    if (region.purpose === "behavior-changed")
      return { id: region.id, purpose: region.purpose, comparedAgainst: "none" };
    const reference = references.get(region.id);
    if (!reference) fail(`missing reference bytes for region ${region.id}`);
    const referenceRect = region.referenceRect ?? region.rect;
    const diffPath = diffPaths?.regions?.get(region.id);
    const result =
      referenceRect.x === region.rect.x &&
      referenceRect.y === region.rect.y &&
      referenceRect.width === region.rect.width &&
      referenceRect.height === region.rect.height
        ? compareWithinRects(
            capture,
            reference,
            [region.rect],
            masks,
            `region ${region.id}`,
            diffPath
          )
        : compareCrops(
            capture,
            region.rect,
            reference,
            referenceRect,
            masks,
            `region ${region.id}`,
            diffPath
          );
    return {
      id: region.id,
      purpose: region.purpose,
      comparedAgainst: "reference",
      result,
      ...(diffPath ? { diffPath } : {})
    };
  });
  if (!base) return { regions };
  const owned = declaration.regions.map((r) => r.rect);
  const complement = compareWithinComplement(capture, base, owned, masks, diffPaths?.complement);
  return {
    regions,
    complement,
    ...(diffPaths?.complement ? { complementDiffPath: diffPaths.complement } : {})
  };
}

// The exact complement of the owned rects: every uncovered, unmasked pixel vs the base.
function compareWithinComplement(
  capture: PNG,
  base: PNG,
  owned: readonly PixelRect[],
  masks: readonly PixelRect[],
  diffOutPath?: string
): ComparisonOutcome {
  if (capture.width !== base.width || capture.height !== base.height)
    fail("complement compare requires equal-size capture and base images");
  const grid = maskGrid(capture.width, capture.height, masks);
  const ownedGrid = new Uint8Array(capture.width * capture.height);
  for (const r of owned)
    for (let y = r.y; y < r.y + r.height; y += 1)
      for (let x = r.x; x < r.x + r.width; x += 1) ownedGrid[y * capture.width + x] = 1;
  return compareTargetPixels(
    capture,
    base,
    (x, y) => !ownedGrid[y * capture.width + x] && !grid[y * capture.width + x],
    "complement",
    diffOutPath
  );
}

export interface TransitionComparisonResult {
  readonly id: string;
  readonly kind: TransitionRegion["kind"];
  readonly purpose: RegionPurpose;
  readonly comparedAgainst: "reference" | "base" | "none";
  readonly result?: ComparisonOutcome;
  readonly diffPath?: string; // present exactly when `result` is present
}

export interface SizeTransitionComparisonReport {
  readonly headSize: { readonly width: number; readonly height: number };
  readonly regions: readonly TransitionComparisonResult[];
}

// Compares a declared size transition: base/head must exactly match the declared old/target
// raster dimensions, translate pairs are compared directly (never scaled). Reference-owned
// translate pairs compare to their reference, base-guard translate pairs compare moved
// pixels base-rect to head-rect, and removed/new bands are recorded as owned but never
// pixel-compared (nothing exists on the other side to compare them to).
export function compareSizeTransition(
  declaration: SizeTransitionDeclaration,
  base: PNG,
  head: PNG,
  references: ReadonlyMap<string, PNG>,
  masks: readonly PixelRect[],
  diffPaths?: ReadonlyMap<string, string>
): SizeTransitionComparisonReport {
  if (base.width !== declaration.oldSize.width || base.height !== declaration.oldSize.height)
    fail("base image does not match the declared old size");
  if (head.width !== declaration.targetSize.width || head.height !== declaration.targetSize.height)
    fail("head image does not match the declared target size");
  const regions = declaration.regions.map((region): TransitionComparisonResult => {
    const diffPath = diffPaths?.get(region.id);
    // Removed pixels have no head or reference counterpart (parsing already rejects
    // reference-owned here), so there is nothing to compare.
    if (region.kind === "removed-band")
      return { id: region.id, kind: region.kind, purpose: region.purpose, comparedAgainst: "none" };
    if (region.kind === "new-band") {
      const headRect = region.headRect!;
      if (region.purpose === "behavior-changed")
        return {
          id: region.id,
          kind: region.kind,
          purpose: region.purpose,
          comparedAgainst: "none"
        };
      // Reference-owned new pixels have no old-image counterpart, so they compare against
      // the reference at the same target coordinates.
      const reference = references.get(region.id);
      if (!reference) fail(`missing reference bytes for transition region ${region.id}`);
      const result = compareCrops(
        head,
        headRect,
        reference,
        headRect,
        masks,
        `transition ${region.id} reference`,
        diffPath
      );
      return {
        id: region.id,
        kind: region.kind,
        purpose: region.purpose,
        comparedAgainst: "reference",
        result,
        ...(diffPath ? { diffPath } : {})
      };
    }
    // translate
    const headRect = region.headRect!;
    if (region.purpose === "behavior-changed")
      return { id: region.id, kind: region.kind, purpose: region.purpose, comparedAgainst: "none" };
    // A base-guard band moved position but must keep its pixels: compare the old/base
    // rect directly against the new/target rect and report it as a base comparison,
    // so a regression inside the moved band fails instead of passing silently.
    if (region.purpose === "base-guard") {
      const result = compareCrops(
        base,
        region.baseRect!,
        head,
        headRect,
        masks,
        `transition ${region.id} base-guard`,
        diffPath
      );
      return {
        id: region.id,
        kind: region.kind,
        purpose: region.purpose,
        comparedAgainst: "base",
        result,
        ...(diffPath ? { diffPath } : {})
      };
    }
    // parseSizeTransition already rejects a reference-owned translate region with no
    // referenceRect, so every region reaching here has one bound. It compares only to the
    // reference, never to base - the same rule compareRegionSet follows for non-transition
    // reference-owned regions.
    if (!region.referenceRect) fail(`transition region ${region.id} reference-owned but unbound`);
    const reference = references.get(region.id);
    if (!reference) fail(`missing reference bytes for transition region ${region.id}`);
    const referenceResult = compareCrops(
      head,
      headRect,
      reference,
      region.referenceRect,
      masks,
      `transition ${region.id} reference`,
      diffPath
    );
    return {
      id: region.id,
      kind: region.kind,
      purpose: region.purpose,
      comparedAgainst: "reference",
      result: referenceResult,
      ...(diffPath ? { diffPath } : {})
    };
  });
  return { headSize: declaration.targetSize, regions };
}

// --- selected-execution entry points: read declared paths, run the same exported comparator,
// and reduce to a single pass/fail outcome. The only functions the selected test loop calls. ---

function aggregateOutcome(
  results: readonly { readonly result?: ComparisonOutcome }[],
  complement?: ComparisonOutcome
): "pass" | "fail" {
  const outcomes = results.flatMap((r) => (r.result ? [r.result.outcome] : []));
  if (complement) outcomes.push(complement.outcome);
  // An empty outcome list means nothing was ever pixel-compared. `.every()` on an empty array
  // is vacuously true, so without this check zero real coverage would report a free "pass".
  if (outcomes.length === 0)
    fail(
      "declaration has no coverage: every region/transition entry is behavior-changed and " +
        "nothing was compared to base or reference"
    );
  return outcomes.every((o) => o === "pass") ? "pass" : "fail";
}

export interface DeclaredRegionRunResult {
  readonly outcome: "pass" | "fail";
  readonly report: RegionSetComparisonReport;
  readonly baseSha256: string | null;
  readonly referenceSha256?: string;
}

// Reference-owned regions in one regionSet all draw from the same declared reference image
// (its sub-rects, via each region's referenceRect); one reference identity per case, not per region.
export function runDeclaredRegionComparison(
  declaration: RegionSetDeclaration,
  capturePath: string,
  basePath: string | null,
  referencePath: string | null,
  diffPaths?: RegionSetDiffPaths
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
  const report = compareRegionSet(declaration, capture, base, references, [], diffPaths);
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

// One declared reference image supplies every translate region's referenceRect crop, same as
// runDeclaredRegionComparison.
export function runDeclaredSizeTransition(
  declaration: SizeTransitionDeclaration,
  basePath: string,
  headPath: string,
  referencePath: string | null,
  diffPaths?: ReadonlyMap<string, string>
): DeclaredSizeTransitionRunResult {
  const base = PNG.sync.read(readFileSync(basePath));
  const head = PNG.sync.read(readFileSync(headPath));
  const references = new Map<string, PNG>();
  if (referencePath) {
    if (!existsSync(referencePath)) fail(`missing declared reference: ${referencePath}`);
    const referencePng = PNG.sync.read(readFileSync(referencePath));
    for (const region of declaration.regions)
      // A translate region only needs the reference when it declared its own referenceRect;
      // a reference-owned new-band region needs it at its headRect (see compareSizeTransition).
      if (
        region.referenceRect ||
        (region.kind === "new-band" && region.purpose === "reference-owned")
      )
        references.set(region.id, referencePng);
  }
  const report = compareSizeTransition(declaration, base, head, references, [], diffPaths);
  return {
    outcome: aggregateOutcome(report.regions),
    report,
    baseSha256: sha256File(basePath),
    referenceSha256: referencePath ? sha256File(referencePath) : undefined
  };
}

// Builds the one comparison object recorded for a case that declared regions or a
// sizeTransition, so the spec keeps only a call site and never inlines this branching.
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
  controls: { readonly zeroPercent: number; readonly changedPercent: number },
  diffBasePath: string
): {
  readonly comparison: {
    readonly outcome: "pass" | "fail";
    readonly expectedBase: string;
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
  if (expectedBase === null)
    fail("parity case selection: declared base without PARITY_EXPECTED_BASE");
  if (!declaration.base)
    fail("parity case selection: regions/sizeTransition require a declared base");
  const baseAbsolute = join(outRoot, declaration.base);
  if (!existsSync(baseAbsolute))
    fail(`parity case selection: missing declared baseline ${declaration.base}`);
  const referenceAbsolute = declaration.reference ? join(outRoot, declaration.reference) : null;
  if (declaration.sizeTransition) {
    const diffPaths = new Map(
      declaration.sizeTransition.regions.map((region) => [
        region.id,
        diffBasePath.replace(/\.diff\.png$/, `.transition-${region.id}.diff.png`)
      ])
    );
    const transition = runDeclaredSizeTransition(
      declaration.sizeTransition,
      baseAbsolute,
      maskedPath,
      referenceAbsolute,
      diffPaths
    );
    // A representative real diff: the first entry actually pixel-compared, never "none".
    const compared = transition.report.regions.find((r) => r.result);
    const referenceEntry = transition.report.regions.find((r) => r.comparedAgainst === "reference");
    return {
      comparison: {
        outcome: transition.outcome,
        expectedBase,
        expectedReference: declaration.reference,
        baseSha256: transition.baseSha256,
        ...(transition.referenceSha256 ? { referenceSha256: transition.referenceSha256 } : {}),
        zeroControlPercent: controls.zeroPercent,
        changedControlPercent: controls.changedPercent,
        transitionReport: transition.report
      },
      diffPath: compared?.diffPath ?? diffBasePath,
      ...(referenceEntry?.diffPath ? { referenceDiffPath: referenceEntry.diffPath } : {})
    };
  }
  const regionDiffPaths: RegionSetDiffPaths = {
    regions: new Map(
      declaration.regions!.regions.map((region) => [
        region.id,
        diffBasePath.replace(/\.diff\.png$/, `.region-${region.id}.diff.png`)
      ])
    ),
    complement: diffBasePath.replace(/\.diff\.png$/, ".complement.diff.png")
  };
  const region = runDeclaredRegionComparison(
    declaration.regions!,
    maskedPath,
    baseAbsolute,
    referenceAbsolute,
    regionDiffPaths
  );
  // With a complement, the complement-vs-base diff is the meaningful whole-capture diff; a
  // fullImage region (no complement) uses its own vs-reference diff, the only comparison that ran.
  const diffPath = region.report.complement
    ? regionDiffPaths.complement!
    : (region.report.regions[0]?.diffPath ?? diffBasePath);
  const referenceEntry = region.report.regions.find((r) => r.comparedAgainst === "reference");
  return {
    comparison: {
      outcome: region.outcome,
      expectedBase,
      expectedReference: declaration.reference,
      ...(region.baseSha256 ? { baseSha256: region.baseSha256 } : {}),
      ...(region.referenceSha256 ? { referenceSha256: region.referenceSha256 } : {}),
      zeroControlPercent: controls.zeroPercent,
      changedControlPercent: controls.changedPercent,
      regionReport: region.report
    },
    diffPath,
    ...(referenceEntry?.diffPath ? { referenceDiffPath: referenceEntry.diffPath } : {})
  };
}

// Chooses which comparison a case actually runs (regions/transition, legacy base+reference, or
// a bare control) and returns its diff paths. The one entry point the spec calls per capture.
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
  if (declaration.sizeTransition || declaration.regions) {
    const built = buildRegionOrTransitionComparison(
      declaration,
      expectedBase,
      outRoot,
      maskedPath,
      controls,
      mockupDiffPath
    );
    return {
      comparison: built.comparison,
      diffPath: built.diffPath,
      ...(built.referenceDiffPath ? { referenceDiffPath: built.referenceDiffPath } : {})
    };
  }
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

// Every diff image a report entry points at, in declaration order, plus the region-set
// complement diff when one was written. The spec inventories exactly these paths; the
// validator requires the inventory to match this set with no missing, swapped or extra diffs.
export function reportDiffPaths(
  report: RegionSetComparisonReport | SizeTransitionComparisonReport
): readonly string[] {
  const paths: string[] = [];
  for (const entry of report.regions) if (entry.diffPath) paths.push(entry.diffPath);
  if ("complementDiffPath" in report && report.complementDiffPath)
    paths.push(report.complementDiffPath);
  return paths;
}

// The semantic form of a report: everything validation recomputes from the actual bytes
// (IDs, purpose, kind, comparedAgainst, counts, percentages, outcomes), without the
// diff-image paths, which are validated separately against the artifact inventory.
export function toSemanticReport(
  report: RegionSetComparisonReport | SizeTransitionComparisonReport
): unknown {
  return JSON.parse(
    JSON.stringify(report, (key, value: unknown) =>
      key === "diffPath" || key === "complementDiffPath" ? undefined : value
    )
  ) as unknown;
}

// --- provenance: recompute from actual bytes on disk, never trust a claim ---

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Reads every declared reference file, keyed by region id, and hashes each one. Shared by
// buildRegionRunRecord and buildTransitionRunRecord.
function loadReferences(
  referencePaths: ReadonlyMap<string, string>,
  label: string
): { references: Map<string, PNG>; referenceSha256: Record<string, string> } {
  const references = new Map<string, PNG>();
  const referenceSha256: Record<string, string> = {};
  for (const [id, path] of referencePaths) {
    if (!existsSync(path)) fail(`missing reference for ${label} ${id}: ${path}`);
    references.set(id, PNG.sync.read(readFileSync(path)));
    referenceSha256[id] = sha256File(path);
  }
  return { references, referenceSha256 };
}

export interface RegionRunRecord {
  readonly caseId: string;
  readonly captureSha256: string;
  readonly baseSha256: string | null;
  readonly referenceSha256: Record<string, string>;
  readonly report: RegionSetComparisonReport;
}

// Reads the declared bytes from disk, re-runs the comparison, and returns a record whose
// hashes and outcomes are bound to the actual files. The only way to produce a region run record.
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
  const { references, referenceSha256 } = loadReferences(referencePaths, "region");
  const report = compareRegionSet(declaration, capture, base, references, masks);
  return {
    caseId,
    captureSha256: sha256File(capturePath),
    baseSha256: basePath ? sha256File(basePath) : null,
    referenceSha256,
    report
  };
}

// Validates a previously recorded region run against the actual bytes on disk right now:
// recomputes from scratch and requires every hash and outcome to match exactly. A claimed
// "pass" that disagrees with a fresh recompute (forged, stale, or moved bytes) is rejected.
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

export interface TransitionRunRecord {
  readonly caseId: string;
  readonly captureSha256: string;
  readonly baseSha256: string;
  readonly referenceSha256: Record<string, string>;
  readonly report: SizeTransitionComparisonReport;
}

// Same shape as buildRegionRunRecord, for a declared size transition.
export function buildTransitionRunRecord(
  caseId: string,
  declaration: SizeTransitionDeclaration,
  headPath: string,
  basePath: string,
  referencePaths: ReadonlyMap<string, string>,
  masks: readonly PixelRect[]
): TransitionRunRecord {
  if (!existsSync(headPath)) fail(`missing capture: ${headPath}`);
  if (!existsSync(basePath)) fail(`missing base: ${basePath}`);
  const head = PNG.sync.read(readFileSync(headPath));
  const base = PNG.sync.read(readFileSync(basePath));
  const { references, referenceSha256 } = loadReferences(referencePaths, "transition region");
  const report = compareSizeTransition(declaration, base, head, references, masks);
  return {
    caseId,
    captureSha256: sha256File(headPath),
    baseSha256: sha256File(basePath),
    referenceSha256,
    report
  };
}

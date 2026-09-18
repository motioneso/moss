import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import {
  applyContrastingControl,
  writeComparisonControls
} from "../../tests/uat/visual-parity/capture.js";
import {
  computeHarnessDigest,
  HARNESS_FILES,
  parseCaseSelection
} from "../../tests/uat/visual-parity/case-selection.js";
import { DECLARED_SIZE_MISMATCHES } from "../../tests/uat/visual-parity/declared-size-mismatches.js";
import {
  buildRegionRunRecord,
  compareRegionSet,
  compareSizeTransition,
  parseRegionSet,
  parseSizeTransition,
  resolveEntryComparison,
  runDeclaredRegionComparison,
  sha256File,
  validateRegionRunRecord,
  type RegionSetDeclaration,
  type SizeTransitionDeclaration
} from "../../tests/uat/visual-parity/region-comparison.js";

const WIDTH = 8;
const HEIGHT = 8;
// The owned region under test: a 3x3 block starting at (1,1), leaving a
// 55-pixel complement in an 8x8 image.
const REGION_RECT = { x: 1, y: 1, width: 3, height: 3 };

function gradientPng(width: number, height: number): PNG {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const i = (width * y + x) * 4;
      png.data[i] = (x * 30) % 256;
      png.data[i + 1] = (y * 30) % 256;
      png.data[i + 2] = 128;
      png.data[i + 3] = 255;
    }
  return png;
}

function solidPng(width: number, height: number, rgba: [number, number, number, number]): PNG {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    png.data[i * 4] = rgba[0];
    png.data[i * 4 + 1] = rgba[1];
    png.data[i * 4 + 2] = rgba[2];
    png.data[i * 4 + 3] = rgba[3];
  }
  return png;
}

function setPixel(png: PNG, x: number, y: number, rgba: [number, number, number, number]): void {
  const i = (png.width * y + x) * 4;
  png.data[i] = rgba[0];
  png.data[i + 1] = rgba[1];
  png.data[i + 2] = rgba[2];
  png.data[i + 3] = rgba[3];
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "parity-region-"));
}

function writePng(dir: string, name: string, png: PNG): string {
  const path = join(dir, name);
  writeFileSync(path, PNG.sync.write(png));
  return path;
}

const BASE_REGION_SET: RegionSetDeclaration = {
  imageSize: { width: WIDTH, height: HEIGHT },
  regions: [{ id: "owned", purpose: "reference-owned", rect: REGION_RECT }]
};

describe("region declaration parsing", () => {
  it("rejects missing, unknown, duplicate, unsafe, overlapping and out-of-bounds regions", () => {
    expect(() => parseRegionSet({ imageSize: { width: 8, height: 8 }, regions: [] })).toThrow(
      "nonempty"
    );
    expect(() =>
      parseRegionSet({
        imageSize: { width: 8, height: 8 },
        regions: [{ id: "a", purpose: "unknown", rect: REGION_RECT }]
      })
    ).toThrow("purpose");
    expect(() =>
      parseRegionSet({
        imageSize: { width: 8, height: 8 },
        regions: [
          { id: "a", purpose: "reference-owned", rect: REGION_RECT },
          { id: "a", purpose: "reference-owned", rect: { x: 5, y: 5, width: 1, height: 1 } }
        ]
      })
    ).toThrow("duplicate");
    expect(() =>
      parseRegionSet({
        imageSize: { width: 8, height: 8 },
        regions: [
          { id: "a", purpose: "reference-owned", rect: REGION_RECT },
          { id: "b", purpose: "reference-owned", rect: { x: 2, y: 2, width: 2, height: 2 } }
        ]
      })
    ).toThrow("overlaps");
    expect(() =>
      parseRegionSet({
        imageSize: { width: 8, height: 8 },
        regions: [
          { id: "a", purpose: "reference-owned", rect: { x: 6, y: 6, width: 4, height: 4 } }
        ]
      })
    ).toThrow("out of bounds");
    expect(() =>
      parseRegionSet({
        imageSize: { width: 8, height: 8 },
        regions: [
          {
            id: "a",
            purpose: "reference-owned",
            rect: { x: 0, y: 0, width: Number.NaN, height: 1 }
          }
        ]
      })
    ).toThrow("finite integer");
  });
});

describe("region comparison against real fixtures", () => {
  it("passes a matching owned region while an unfinished sibling reference stays missing", () => {
    const declaration: RegionSetDeclaration = {
      imageSize: { width: WIDTH, height: HEIGHT },
      regions: [
        { id: "finished", purpose: "reference-owned", rect: REGION_RECT },
        {
          id: "unfinished",
          purpose: "reference-owned",
          rect: { x: 5, y: 5, width: 2, height: 2 }
        }
      ]
    };
    const capture = solidPng(WIDTH, HEIGHT, [10, 20, 30, 255]);
    const reference = solidPng(WIDTH, HEIGHT, [10, 20, 30, 255]);
    const references = new Map([["finished", reference]]);
    expect(() => compareRegionSet(declaration, capture, null, references, [])).toThrow(
      "missing reference bytes for region unfinished"
    );
    const onlyFinished: RegionSetDeclaration = {
      ...declaration,
      regions: [declaration.regions[0]!]
    };
    const report = compareRegionSet(onlyFinished, capture, null, references, []);
    expect(report.regions[0]!.result!.outcome).toBe("pass");
    expect(report.regions[0]!.result!.percent).toBe(0);
  });

  it("fails when an owned pixel is altered and reports the region-only denominator", () => {
    const capture = solidPng(WIDTH, HEIGHT, [10, 20, 30, 255]);
    const reference = solidPng(WIDTH, HEIGHT, [10, 20, 30, 255]);
    setPixel(reference, 2, 2, [250, 250, 250, 255]);
    const references = new Map([["owned", reference]]);
    const report = compareRegionSet(BASE_REGION_SET, capture, null, references, []);
    const result = report.regions[0]!.result!;
    expect(result.denominator).toBe(9);
    expect(result.numerator).toBe(1);
    expect(result.outcome).toBe("fail");
  });

  it("fails when a complement pixel is altered, leaving the owned region alone", () => {
    const capture = solidPng(WIDTH, HEIGHT, [10, 20, 30, 255]);
    const reference = solidPng(WIDTH, HEIGHT, [10, 20, 30, 255]);
    const base = solidPng(WIDTH, HEIGHT, [10, 20, 30, 255]);
    setPixel(base, 0, 0, [250, 250, 250, 255]);
    const references = new Map([["owned", reference]]);
    const report = compareRegionSet(BASE_REGION_SET, capture, base, references, []);
    expect(report.regions[0]!.result!.outcome).toBe("pass");
    expect(report.complement).toBeDefined();
    expect(report.complement!.denominator).toBe(WIDTH * HEIGHT - 9);
    expect(report.complement!.numerator).toBe(1);
    expect(report.complement!.outcome).toBe("fail");
  });

  it("rejects a fully masked region because an empty comparable region cannot pass", () => {
    const capture = solidPng(WIDTH, HEIGHT, [10, 20, 30, 255]);
    const reference = solidPng(WIDTH, HEIGHT, [10, 20, 30, 255]);
    const references = new Map([["owned", reference]]);
    expect(() =>
      compareRegionSet(BASE_REGION_SET, capture, null, references, [REGION_RECT])
    ).toThrow("no comparable pixels");
  });

  it("compares full-image reference ownership without any complement, even with a base difference", () => {
    const declaration: RegionSetDeclaration = {
      imageSize: { width: WIDTH, height: HEIGHT },
      regions: [
        {
          id: "whole",
          purpose: "reference-owned",
          rect: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
          fullImage: true
        }
      ]
    };
    const capture = solidPng(WIDTH, HEIGHT, [10, 20, 30, 255]);
    const reference = solidPng(WIDTH, HEIGHT, [10, 20, 30, 255]);
    const base = solidPng(WIDTH, HEIGHT, [90, 90, 90, 255]); // deliberately different from capture
    const references = new Map([["whole", reference]]);
    const report = compareRegionSet(declaration, capture, base, references, []);
    expect(report.regions[0]!.result!.outcome).toBe("pass");
    expect(report.complement).toBeUndefined();
  });

  it("writes real diff images to disk at the given paths instead of only computing them in memory", () => {
    const dir = tempDir();
    const capture = solidPng(WIDTH, HEIGHT, [10, 20, 30, 255]);
    const reference = solidPng(WIDTH, HEIGHT, [10, 20, 30, 255]);
    setPixel(reference, 2, 2, [250, 250, 250, 255]);
    const base = solidPng(WIDTH, HEIGHT, [10, 20, 30, 255]);
    setPixel(base, 0, 0, [250, 250, 250, 255]);
    const references = new Map([["owned", reference]]);
    const regionDiffPath = join(dir, "owned.diff.png");
    const complementDiffPath = join(dir, "complement.diff.png");
    const report = compareRegionSet(BASE_REGION_SET, capture, base, references, [], {
      regions: new Map([["owned", regionDiffPath]]),
      complement: complementDiffPath
    });
    // The report must point at the region diff file it claims to have
    // written, and the bytes at both given paths must actually be real,
    // correctly sized PNG diffs written to disk (not just computed in
    // memory and discarded).
    expect(report.regions[0]!.diffPath).toBe(regionDiffPath);
    // The comparator diffs the whole masked frame (painting everything
    // outside the target rect identical) rather than a cropped rect, so the
    // written diff image is full-frame sized.
    const regionDiffPng = PNG.sync.read(readFileSync(regionDiffPath));
    expect(regionDiffPng.width).toBe(WIDTH);
    expect(regionDiffPng.height).toBe(HEIGHT);
    const complementDiffPng = PNG.sync.read(readFileSync(complementDiffPath));
    expect(complementDiffPng.width).toBe(WIDTH);
    expect(complementDiffPng.height).toBe(HEIGHT);
  });

  it("gives an all-behavior-changed declaration no coverage and fails it instead of a vacuous pass", () => {
    const dir = tempDir();
    const declaration: RegionSetDeclaration = {
      imageSize: { width: WIDTH, height: HEIGHT },
      regions: [
        {
          id: "whole",
          purpose: "behavior-changed",
          rect: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
          behaviorEvidence: "manually verified: full redesign"
        }
      ]
    };
    const capturePath = writePng(dir, "capture.png", solidPng(WIDTH, HEIGHT, [10, 20, 30, 255]));
    // No base at all: the one declared region covers the whole image and is
    // behavior-changed, so there is no complement to fall back on either.
    // Every single entry is behavior-changed and nothing was ever
    // pixel-compared. That must fail loudly, not report a free "pass"
    // because there was nothing to check.
    expect(() => runDeclaredRegionComparison(declaration, capturePath, null, null)).toThrow(
      "no coverage"
    );
  });
});

describe("region run record provenance", () => {
  function fixture() {
    const dir = tempDir();
    const capture = solidPng(WIDTH, HEIGHT, [10, 20, 30, 255]);
    const base = solidPng(WIDTH, HEIGHT, [10, 20, 30, 255]);
    const reference = solidPng(WIDTH, HEIGHT, [10, 20, 30, 255]);
    const capturePath = writePng(dir, "capture.png", capture);
    const basePath = writePng(dir, "base.png", base);
    const referencePath = writePng(dir, "reference.png", reference);
    return { dir, capturePath, basePath, referencePath };
  }

  it("rejects a forged recorded pass that disagrees with a fresh recompute", () => {
    const { capturePath, basePath, referencePath } = fixture();
    const references = new Map([["owned", referencePath]]);
    const record = buildRegionRunRecord(
      "case-a",
      BASE_REGION_SET,
      capturePath,
      basePath,
      references,
      []
    );
    const forged = {
      ...record,
      report: {
        ...record.report,
        regions: [
          {
            ...record.report.regions[0]!,
            result: { numerator: 0, denominator: 9, percent: 0, outcome: "pass" as const }
          }
        ],
        complement: { numerator: 5, denominator: 55, percent: 9, outcome: "fail" as const }
      }
    };
    expect(() =>
      validateRegionRunRecord(forged, BASE_REGION_SET, capturePath, basePath, references, [])
    ).toThrow("does not match a fresh recompute");
  });

  it("rejects a wrong base identity when the base bytes change after recording", () => {
    const { capturePath, basePath, referencePath } = fixture();
    const references = new Map([["owned", referencePath]]);
    const record = buildRegionRunRecord(
      "case-a",
      BASE_REGION_SET,
      capturePath,
      basePath,
      references,
      []
    );
    writeFileSync(basePath, PNG.sync.write(solidPng(WIDTH, HEIGHT, [1, 2, 3, 255])));
    expect(() =>
      validateRegionRunRecord(record, BASE_REGION_SET, capturePath, basePath, references, [])
    ).toThrow("base identity changed");
  });

  it("rejects changed source bytes and changed reference bytes after recording", () => {
    const { capturePath, basePath, referencePath } = fixture();
    const references = new Map([["owned", referencePath]]);
    const record = buildRegionRunRecord(
      "case-a",
      BASE_REGION_SET,
      capturePath,
      basePath,
      references,
      []
    );
    writeFileSync(capturePath, PNG.sync.write(solidPng(WIDTH, HEIGHT, [9, 9, 9, 255])));
    expect(() =>
      validateRegionRunRecord(record, BASE_REGION_SET, capturePath, basePath, references, [])
    ).toThrow("capture bytes changed");

    const { capturePath: cap2, basePath: base2, referencePath: ref2 } = fixture();
    const refs2 = new Map([["owned", ref2]]);
    const record2 = buildRegionRunRecord("case-b", BASE_REGION_SET, cap2, base2, refs2, []);
    writeFileSync(ref2, PNG.sync.write(solidPng(WIDTH, HEIGHT, [9, 9, 9, 255])));
    expect(() => validateRegionRunRecord(record2, BASE_REGION_SET, cap2, base2, refs2, [])).toThrow(
      "reference bytes changed"
    );
  });

  it("rejects x-only and y-only geometry drift against a recorded run", () => {
    // Gradient fixtures with one reference pixel (4,2) deliberately deviated,
    // sitting just outside the original 3x3 rect but inside an x- or y-shifted
    // one: shifting the declared rect changes whether that deviation lands
    // inside the owned comparison, so drift is guaranteed to surface.
    const dir = tempDir();
    const capturePath = writePng(dir, "capture.png", gradientPng(WIDTH, HEIGHT));
    const basePath = writePng(dir, "base.png", gradientPng(WIDTH, HEIGHT));
    const reference = gradientPng(WIDTH, HEIGHT);
    setPixel(reference, 4, 2, [255, 255, 255, 255]); // lands inside an x-shifted rect only
    setPixel(reference, 2, 4, [255, 255, 255, 255]); // lands inside a y-shifted rect only
    const referencePath = writePng(dir, "reference.png", reference);
    const references = new Map([["owned", referencePath]]);
    const record = buildRegionRunRecord(
      "case-a",
      BASE_REGION_SET,
      capturePath,
      basePath,
      references,
      []
    );
    const shiftedX: RegionSetDeclaration = {
      imageSize: BASE_REGION_SET.imageSize,
      regions: [{ id: "owned", purpose: "reference-owned", rect: { ...REGION_RECT, x: 2 } }]
    };
    expect(() =>
      validateRegionRunRecord(record, shiftedX, capturePath, basePath, references, [])
    ).toThrow("does not match a fresh recompute");
    const shiftedY: RegionSetDeclaration = {
      imageSize: BASE_REGION_SET.imageSize,
      regions: [{ id: "owned", purpose: "reference-owned", rect: { ...REGION_RECT, y: 2 } }]
    };
    expect(() =>
      validateRegionRunRecord(record, shiftedY, capturePath, basePath, references, [])
    ).toThrow("does not match a fresh recompute");
  });

  it("accepts a genuine recorded run that recomputes identically from disk", () => {
    const { capturePath, basePath, referencePath } = fixture();
    const references = new Map([["owned", referencePath]]);
    const record = buildRegionRunRecord(
      "case-a",
      BASE_REGION_SET,
      capturePath,
      basePath,
      references,
      []
    );
    expect(record.captureSha256).toBe(sha256File(capturePath));
    expect(() =>
      validateRegionRunRecord(record, BASE_REGION_SET, capturePath, basePath, references, [])
    ).not.toThrow();
  });
});

describe("size transitions", () => {
  const TRANSITION: SizeTransitionDeclaration = parseSizeTransition({
    oldSize: { width: 8, height: 8 },
    targetSize: { width: 8, height: 10 },
    regions: [
      {
        id: "translated",
        kind: "translate",
        purpose: "behavior-changed",
        behaviorEvidence: "manually verified: content shifts down, no pixel change expected",
        baseRect: { x: 0, y: 0, width: 8, height: 8 },
        headRect: { x: 0, y: 0, width: 8, height: 8 }
      },
      {
        id: "grown",
        kind: "new-band",
        purpose: "behavior-changed",
        behaviorEvidence: "manually verified: new band is intentional new content",
        headRect: { x: 0, y: 8, width: 8, height: 2 }
      }
    ],
    expectedGeometry: { x: 0, y: 0 }
  });

  it("accepts a correct size transition and rejects a wrong target size", () => {
    const base = solidPng(8, 8, [1, 2, 3, 255]);
    const head = solidPng(8, 10, [1, 2, 3, 255]);
    const report = compareSizeTransition(TRANSITION, base, head, new Map(), []);
    expect(report.headSize).toEqual({ width: 8, height: 10 });
    const wrongSizeHead = solidPng(8, 9, [1, 2, 3, 255]);
    expect(() => compareSizeTransition(TRANSITION, base, wrongSizeHead, new Map(), [])).toThrow(
      "does not match the declared target size"
    );
  });

  it("compares a reference-owned translate band only against the reference, never falling back to base", () => {
    const referenceOwnedTransition: SizeTransitionDeclaration = parseSizeTransition({
      oldSize: { width: 8, height: 8 },
      targetSize: { width: 8, height: 10 },
      regions: [
        {
          id: "translated",
          kind: "translate",
          purpose: "reference-owned",
          baseRect: { x: 0, y: 0, width: 8, height: 8 },
          headRect: { x: 0, y: 0, width: 8, height: 8 },
          referenceRect: { x: 0, y: 0, width: 8, height: 8 }
        },
        {
          id: "grown",
          kind: "new-band",
          purpose: "behavior-changed",
          behaviorEvidence: "manually verified: new band is intentional new content",
          headRect: { x: 0, y: 8, width: 8, height: 2 }
        }
      ],
      expectedGeometry: { x: 0, y: 0 }
    });
    const base = solidPng(8, 8, [1, 2, 3, 255]);
    // The head differs from base (so a base comparison would fail) but
    // matches the reference exactly (so a reference comparison passes). A
    // reference-owned region must be judged against the reference only.
    const head = solidPng(8, 10, [9, 9, 9, 255]);
    const reference = solidPng(8, 8, [9, 9, 9, 255]);
    const references = new Map([["translated", reference]]);
    const report = compareSizeTransition(referenceOwnedTransition, base, head, references, []);
    const translated = report.regions.find((r) => r.id === "translated")!;
    expect(translated.comparedAgainst).toBe("reference");
    expect(translated.result!.outcome).toBe("pass");
  });

  it("rejects a reference-owned translate region that has no referenceRect, instead of silently comparing it to base", () => {
    // A region labeled reference-owned but missing a referenceRect has no
    // reference bytes to check against at all. The old behavior silently
    // compared it to base instead, so a region declared "must match the
    // approved reference" could pass without ever touching reference bytes.
    expect(() =>
      parseSizeTransition({
        oldSize: { width: 8, height: 8 },
        targetSize: { width: 8, height: 10 },
        regions: [
          {
            id: "translated",
            kind: "translate",
            purpose: "reference-owned",
            baseRect: { x: 0, y: 0, width: 8, height: 8 },
            headRect: { x: 0, y: 0, width: 8, height: 8 }
            // referenceRect deliberately omitted
          },
          {
            id: "grown",
            kind: "new-band",
            purpose: "behavior-changed",
            behaviorEvidence: "manually verified: new band is intentional new content",
            headRect: { x: 0, y: 8, width: 8, height: 2 }
          }
        ],
        expectedGeometry: { x: 0, y: 0 }
      })
    ).toThrow("reference-owned translate requires referenceRect");
  });

  it("rejects an uncovered or removed band that leaves the old image partly unaccounted", () => {
    expect(() =>
      parseSizeTransition({
        oldSize: { width: 8, height: 8 },
        targetSize: { width: 8, height: 10 },
        regions: [
          {
            id: "translated",
            kind: "translate",
            purpose: "behavior-changed",
            behaviorEvidence: "manually verified",
            // covers only 6 of 8 rows: the old image is left partly unaccounted
            baseRect: { x: 0, y: 0, width: 8, height: 6 },
            headRect: { x: 0, y: 0, width: 8, height: 6 }
          }
        ]
      })
    ).toThrow("coverage is not exhaustive");
  });

  it("rejects a translate pair that tries to scale instead of only translate", () => {
    expect(() =>
      parseSizeTransition({
        oldSize: { width: 8, height: 8 },
        targetSize: { width: 8, height: 10 },
        regions: [
          {
            id: "translated",
            kind: "translate",
            purpose: "behavior-changed",
            baseRect: { x: 0, y: 0, width: 8, height: 8 },
            headRect: { x: 0, y: 0, width: 8, height: 10 }
          }
        ]
      })
    ).toThrow("cannot scale");
  });

  it("requires an expected capture position so the spec has something real to check the captured geometry against", () => {
    expect(() =>
      parseSizeTransition({
        oldSize: { width: 8, height: 8 },
        targetSize: { width: 8, height: 10 },
        regions: [
          {
            id: "translated",
            kind: "translate",
            purpose: "behavior-changed",
            behaviorEvidence: "manually verified",
            baseRect: { x: 0, y: 0, width: 8, height: 8 },
            headRect: { x: 0, y: 0, width: 8, height: 8 }
          },
          {
            id: "grown",
            kind: "new-band",
            purpose: "behavior-changed",
            behaviorEvidence: "manually verified",
            headRect: { x: 0, y: 8, width: 8, height: 2 }
          }
        ]
        // expectedGeometry deliberately omitted
      })
    ).toThrow("expectedGeometry must be an object");
  });
});

describe("threading real diff files end to end through resolveEntryComparison", () => {
  it("writes a real reference diff file and returns its own path, never the unrelated whole-image mockup diff", () => {
    const dir = tempDir();
    const declaration = {
      role: "owned-region/reference",
      base: "base.png",
      reference: "reference.png",
      regions: BASE_REGION_SET
    };
    const capture = solidPng(WIDTH, HEIGHT, [10, 20, 30, 255]);
    const base = solidPng(WIDTH, HEIGHT, [10, 20, 30, 255]);
    const reference = solidPng(WIDTH, HEIGHT, [10, 20, 30, 255]);
    setPixel(reference, 2, 2, [250, 250, 250, 255]);
    writePng(dir, "base.png", base);
    writePng(dir, "reference.png", reference);
    const maskedPath = writePng(dir, "masked.png", capture);
    const mockupDiffPath = join(dir, "unrelated-mockup.diff.png");
    const resolved = resolveEntryComparison(
      declaration,
      "e".repeat(40),
      dir,
      maskedPath,
      { zeroPercent: 0, changedPercent: 1 },
      mockupDiffPath
    );
    // The old bug returned the unrelated whole-image mockup diff path
    // unconditionally and never returned a referenceDiffPath at all.
    expect(resolved.referenceDiffPath).toBeDefined();
    expect(resolved.referenceDiffPath).not.toBe(mockupDiffPath);
    expect(resolved.diffPath).not.toBe(mockupDiffPath);
    const referenceDiffPng = PNG.sync.read(readFileSync(resolved.referenceDiffPath!));
    expect(referenceDiffPng.width).toBe(WIDTH);
    expect(referenceDiffPng.height).toBe(HEIGHT);
  });
});

describe("legacy debt behavior without any transition declared", () => {
  it("keeps existing cases with neither regions nor sizeTransition unaffected", () => {
    const manifest = parseCaseSelection({
      version: 1,
      cases: [{ dir: "today", name: "legacy.png", role: "measurement" }],
      guards: [{ route: "tasks", path: "/tasks", width: 1440, role: "base-guard" }]
    });
    expect(manifest.cases[0]!.regions).toBeUndefined();
    expect(manifest.cases[0]!.sizeTransition).toBeUndefined();
    expect(DECLARED_SIZE_MISMATCHES.length).toBeGreaterThan(0);
  });

  it("includes the new region-comparison module in the harness digest with no blind spot", () => {
    expect(HARNESS_FILES).toContain("tests/uat/visual-parity/region-comparison.ts");
    expect(computeHarnessDigest()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("changed-control regression: contrasting control at an opaque pixel", () => {
  it("skips a transparent leading pixel and mutates the first opaque one instead", () => {
    const png = solidPng(4, 4, [0, 0, 0, 0]);
    setPixel(png, 3, 3, [200, 10, 10, 255]);
    applyContrastingControl(png);
    const i = (4 * 3 + 3) * 4;
    expect(png.data[i + 3]).toBe(255); // alpha preserved
    expect([png.data[i], png.data[i + 1], png.data[i + 2]]).toEqual([255, 255, 255]);
    // the transparent leading pixel is untouched
    expect(png.data[0]).toBe(0);
    expect(png.data[3]).toBe(0);
  });

  it("throws an explicit unsupported-control failure for an all-transparent image, never a false pass", () => {
    const png = solidPng(4, 4, [0, 0, 0, 0]);
    expect(() => applyContrastingControl(png)).toThrow("no opaque pixel");
  });

  it("proves the weather-icon regression: a contrasting control is now provably non-zero", () => {
    // Regression evidence: the pre-fix control mutation only ever touched byte
    // index 0 of the buffer (pixel (0,0)'s red channel), which stays
    // transparent in this fixture, so the old code produced changedPercent 0
    // for this exact opaque pixel. Raw before/after receipts are saved at
    // evidence/product-proof-regions/weather-regression-failing-before.log.
    const dir = tempDir();
    const png = solidPng(4, 4, [0, 0, 0, 0]);
    setPixel(png, 2, 2, [32, 59, 44, 255]); // real weather-icon opaque pixel color
    const capturePath = writePng(dir, "weather.png", png);
    const before = createHash("sha256").update(readFileSync(capturePath)).digest("hex");
    const result = writeComparisonControls(capturePath, dir, "weather");
    expect(result.zeroPercent).toBe(0);
    expect(result.changedPercent).toBeGreaterThan(0);
    // the source capture on disk is never mutated by writing its control
    expect(createHash("sha256").update(readFileSync(capturePath)).digest("hex")).toBe(before);
  });
});

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { PNG } from "pngjs";
import { MOCKUPS } from "../../tests/uat/visual-parity/mockups.js";
import {
  HARNESS_FILES,
  computeHarnessDigest,
  parseCaseSelection,
  resolveCaseSelectionManifest,
  validateRunManifest,
  type SelectedGuard
} from "../../tests/uat/visual-parity/case-selection.js";
import {
  reportDiffPaths,
  resolveEntryComparison
} from "../../tests/uat/visual-parity/region-comparison.js";

const guards: readonly SelectedGuard[] = [
  { route: "tasks", path: "/tasks", width: 1440, role: "base-guard" },
  { route: "tasks", path: "/tasks", width: 375, role: "base-guard" }
];
const selectedCase = { dir: MOCKUPS[0]!.dir, name: MOCKUPS[0]!.name, role: "measurement" as const };
const PINNED_OPTIONS = (root: string, head = "a".repeat(40)) => ({
  artifactRoot: root,
  expectedHead: head,
  expectedBase: null as string | null,
  expectedHarnessFiles: HARNESS_FILES,
  expectedFixture: { seedDate: "2026-09-17", timeZone: "America/Los_Angeles" }
});

describe("visual parity region seam", () => {
  // Writer-to-validator seam (VP-REGIONS-R3): every fixture below runs the real
  // declaration parser plus resolveEntryComparison to write actual reports and
  // diff files, then feeds that exact output into validateRunManifest. No test
  // builds both sides with a path-less helper.
  type SeamSelection = Parameters<typeof validateRunManifest>[0];
  type SeamManifest = Parameters<typeof validateRunManifest>[1];
  type SeamCapture = SeamManifest["captures"][number];

  function seamGuardCapture(
    root: string,
    record: (rel: string, bytes: Buffer | string) => { path: string; sha256: string },
    name: string,
    route: "tasks",
    width: 375 | 1440
  ) {
    return {
      identity: `guard:${route}@${width}`,
      route,
      width,
      crop: { x: 0, y: 0, width, height: 850 },
      readiness: ["route"],
      populatedWidgets: [route, "Chat"],
      artifacts: {
        raw: record(`raw/${name}.png`, `${name}\n`),
        capture: record(`captures/${name}.png`, `${name}\n`),
        controls: [record(`controls/${name}.control.png`, `${name}\n`)]
      },
      elapsedMs: 1
    };
  }

  function writerRegionCase(input: {
    role?: "owned-region/reference" | "base-guard";
    regionsJson?: unknown;
    sizeTransitionJson?: unknown;
    captureBytes: Buffer;
    baseBytes: Buffer;
    referenceBytes?: Buffer;
    baseRel?: string;
    referenceRel?: string;
    expectedBase?: string;
  }): {
    root: string;
    selection: SeamSelection;
    manifest: SeamManifest;
    capture: SeamCapture;
    check: (value: SeamManifest) => void;
    expectedBase: string;
  } {
    const expectedBase = input.expectedBase ?? "e".repeat(40);
    const baseRel = input.baseRel ?? "refs/region-base.png";
    const referenceRel = input.referenceRel ?? "refs/region-ref.png";
    const root = mkdtempSync(join(tmpdir(), "parity-seam-"));
    writeFileSync(join(root, "selection.json"), "{}");
    writeFileSync(join(root, "manifest.json"), "{}");
    writeFileSync(join(root, "timings.json"), "{}");
    const record = (rel: string, bytes: Buffer | string) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), bytes);
      return {
        path: rel,
        sha256: createHash("sha256").update(bytes).digest("hex")
      };
    };
    const raw = record("raw/region-a.png", input.captureBytes);
    const masked = record("captures/region-a.png", input.captureBytes);
    record(baseRel, input.baseBytes);
    if (input.referenceBytes) record(referenceRel, input.referenceBytes);
    const parsed = parseCaseSelection({
      version: 1,
      cases: [
        {
          dir: MOCKUPS[0]!.dir,
          name: MOCKUPS[0]!.name,
          role: input.role ?? "owned-region/reference",
          reference: input.referenceBytes ? referenceRel : undefined,
          base: baseRel,
          ...(input.regionsJson === undefined ? {} : { regions: input.regionsJson }),
          ...(input.sizeTransitionJson === undefined
            ? {}
            : { sizeTransition: input.sizeTransitionJson })
        }
      ],
      guards
    });
    const selection = resolveCaseSelectionManifest(parsed, { mockups: MOCKUPS });
    const resolved = resolveEntryComparison(
      selection.cases[0]!,
      expectedBase,
      root,
      join(root, masked.path),
      { zeroPercent: 0, changedPercent: 1 },
      join(root, "diffs/region-a.diff.png")
    );
    const comparison = resolved.comparison;
    const report = comparison.regionReport ?? comparison.transitionReport!;
    const diffRecord = (absolute: string) => ({
      path: relative(root, absolute),
      sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex")
    });
    const region = MOCKUPS[0]!.region;
    if (region.kind !== "clip") throw new Error("test needs a clip entry first");
    const capture: SeamCapture = {
      identity: `${MOCKUPS[0]!.dir}/${MOCKUPS[0]!.name}`,
      viewport: { width: 1440, height: 1000 },
      crop: { x: region.x, y: region.y, width: region.w, height: region.h },
      masks: [],
      readiness: ["today", "fonts"],
      populatedWidgets: ["Today", "Chat"],
      artifacts: {
        raw,
        masked,
        diff: diffRecord(resolved.diffPath),
        controls: [record("controls/region-a.changed.png", "controls\n")],
        ...(resolved.referenceDiffPath
          ? { referenceDiff: diffRecord(resolved.referenceDiffPath) }
          : {}),
        regionDiffs: reportDiffPaths(report).map(diffRecord)
      },
      elapsedMs: 1,
      comparison: {
        outcome: comparison.outcome as "pass" | "fail",
        expectedBase: comparison.expectedBase,
        expectedReference: comparison.expectedReference,
        baseSha256: comparison.baseSha256,
        referenceSha256: comparison.referenceSha256,
        zeroControlPercent: comparison.zeroControlPercent,
        changedControlPercent: comparison.changedControlPercent,
        ...(comparison.regionReport ? { regionReport: comparison.regionReport } : {}),
        ...(comparison.transitionReport ? { transitionReport: comparison.transitionReport } : {})
      }
    };
    const manifest: SeamManifest = {
      schema: 1 as const,
      head: "a".repeat(40),
      expectedBase,
      harnessDigest: computeHarnessDigest(),
      artifactRoot: "HEAD/ATTEMPT",
      fixture: { seedDate: "2026-09-17", timeZone: "America/Los_Angeles" },
      timings: { setupMs: 1, preflightMs: 1, captureMs: 1, compareMs: 1, teardownMs: 1 },
      selection: [capture.identity],
      guards: ["guard:tasks@1440", "guard:tasks@375"],
      captures: [capture],
      guardCaptures: [
        seamGuardCapture(root, record, "tasks-1440", "tasks", 1440),
        seamGuardCapture(root, record, "tasks-375", "tasks", 375)
      ]
    };
    const check = (value: SeamManifest) =>
      validateRunManifest(selection, value, {
        ...PINNED_OPTIONS(root),
        expectedBase
      });
    return { root, selection, manifest, capture, check, expectedBase };
  }

  const paint4x4 = (
    complementRgba: [number, number, number, number],
    regionRgba: [number, number, number, number]
  ): Buffer => {
    const png = new PNG({ width: 4, height: 4 });
    for (let y = 0; y < 4; y += 1)
      for (let x = 0; x < 4; x += 1) {
        const i = (4 * y + x) * 4;
        const rgba = x < 2 && y < 2 ? regionRgba : complementRgba;
        png.data[i] = rgba[0];
        png.data[i + 1] = rgba[1];
        png.data[i + 2] = rgba[2];
        png.data[i + 3] = rgba[3];
      }
    return PNG.sync.write(png);
  };

  const OWNED_REGION_JSON = {
    imageSize: { width: 4, height: 4 },
    regions: [
      { id: "owned", purpose: "reference-owned", rect: { x: 0, y: 0, width: 2, height: 2 } },
      {
        id: "note",
        purpose: "behavior-changed",
        behaviorEvidence: "lane ticket NOTE-1: sidebar copy is intentionally new",
        rect: { x: 2, y: 2, width: 2, height: 2 }
      }
    ]
  };

  function ownedRegionBytes() {
    // Complement matches base everywhere; the owned block differs from base but
    // matches the reference, proving the pass came from the reference bytes.
    const captureBytes = paint4x4([10, 20, 30, 255], [40, 50, 60, 255]);
    const baseBytes = paint4x4([10, 20, 30, 255], [99, 98, 97, 255]);
    const referenceBytes = paint4x4([1, 1, 1, 255], [40, 50, 60, 255]);
    return { captureBytes, baseBytes, referenceBytes };
  }

  it("accepts a writer-built region report with reference, complement and behavior entries", () => {
    const { manifest, capture, check } = writerRegionCase({
      regionsJson: OWNED_REGION_JSON,
      ...ownedRegionBytes()
    });
    expect(() => check(manifest)).not.toThrow();
    expect(capture.comparison.outcome).toBe("pass");
    const report = capture.comparison.regionReport!;
    expect(report.regions.find((r) => r.id === "owned")!.comparedAgainst).toBe("reference");
    expect(report.regions.find((r) => r.id === "note")!.comparedAgainst).toBe("none");
    expect(report.complement!.outcome).toBe("pass");
    expect(report.complementDiffPath).toBeDefined();
    // Every recorded diff is inventoried: one owned, one complement.
    expect(capture.artifacts.regionDiffs).toHaveLength(2);
  });

  it("accepts reference provenance under the base-guard outer role", () => {
    const { manifest, check } = writerRegionCase({
      role: "base-guard",
      regionsJson: OWNED_REGION_JSON,
      ...ownedRegionBytes()
    });
    expect(() => check(manifest)).not.toThrow();
  });

  it("rejects measurement cases that declare region acceptance at the parser", () => {
    for (const declaration of [
      { regions: OWNED_REGION_JSON },
      {
        sizeTransition: {
          oldSize: { width: 8, height: 8 },
          targetSize: { width: 8, height: 10 },
          expectedGeometry: { x: 0, y: 0 },
          regions: [
            {
              id: "moved",
              kind: "translate",
              purpose: "base-guard",
              baseRect: { x: 0, y: 0, width: 8, height: 8 },
              headRect: { x: 0, y: 2, width: 8, height: 8 }
            },
            {
              id: "exposed",
              kind: "new-band",
              purpose: "behavior-changed",
              behaviorEvidence: "manual",
              headRect: { x: 0, y: 0, width: 8, height: 2 }
            }
          ]
        }
      }
    ])
      expect(() =>
        parseCaseSelection({
          version: 1,
          cases: [{ ...selectedCase, ...declaration }],
          guards
        })
      ).toThrow("measurement cannot declare regions/sizeTransition acceptance");
  });

  it("rejects forged region results that disagree with a fresh recompute", () => {
    const { manifest, capture, check } = writerRegionCase({
      regionsJson: OWNED_REGION_JSON,
      ...ownedRegionBytes()
    });
    const recorded = capture.comparison.regionReport!;
    const forged = {
      ...recorded,
      regions: recorded.regions.map((entry) =>
        entry.id === "owned"
          ? { ...entry, result: { ...entry.result!, numerator: 9999, outcome: "fail" as const } }
          : entry
      )
    };
    expect(() =>
      check({
        ...manifest,
        captures: [{ ...capture, comparison: { ...capture.comparison, regionReport: forged } }]
      })
    ).toThrow("does not match a fresh recompute of the actual bytes");
    const { regionReport: _dropped, ...withoutReport } = capture.comparison;
    expect(() =>
      check({
        ...manifest,
        captures: [{ ...capture, comparison: withoutReport as typeof capture.comparison }]
      })
    ).toThrow("region comparison report not recorded");
  });

  it("rejects changed base or reference bytes after recording", () => {
    const first = writerRegionCase({ regionsJson: OWNED_REGION_JSON, ...ownedRegionBytes() });
    writeFileSync(join(first.root, "refs/region-base.png"), "forged-base\n");
    expect(() => first.check(first.manifest)).toThrow("declared baseline bytes changed");
    const second = writerRegionCase({ regionsJson: OWNED_REGION_JSON, ...ownedRegionBytes() });
    const retouched = PNG.sync.read(readFileSync(join(second.root, "refs/region-ref.png")));
    retouched.data[(4 * 3 + 3) * 4] = 200;
    writeFileSync(join(second.root, "refs/region-ref.png"), PNG.sync.write(retouched));
    expect(() => second.check(second.manifest)).toThrow("declared reference bytes changed");
  });

  it("rejects unbound base or reference hashes and a mismatched run baseline", () => {
    const { manifest, capture, check } = writerRegionCase({
      regionsJson: OWNED_REGION_JSON,
      ...ownedRegionBytes()
    });
    const { baseSha256: _b, ...noBaseHash } = capture.comparison;
    expect(() =>
      check({
        ...manifest,
        captures: [{ ...capture, comparison: noBaseHash as typeof capture.comparison }]
      })
    ).toThrow("capture base bytes unbound");
    const { referenceSha256: _r, ...noRefHash } = capture.comparison;
    expect(() =>
      check({
        ...manifest,
        captures: [{ ...capture, comparison: noRefHash as typeof capture.comparison }]
      })
    ).toThrow("capture reference bytes unbound");
    expect(() =>
      check({
        ...manifest,
        captures: [
          {
            ...capture,
            comparison: { ...capture.comparison, expectedBase: "f".repeat(40) }
          }
        ]
      })
    ).toThrow("capture baseline differs from run baseline");
  });

  it("rejects missing, swapped, duplicated or extra region diffs", () => {
    const missing = writerRegionCase({ regionsJson: OWNED_REGION_JSON, ...ownedRegionBytes() });
    const ownedDiff = missing.capture.artifacts.regionDiffs!.find((d) =>
      d.path.includes("region-owned")
    )!;
    writeFileSync(join(missing.root, ownedDiff.path), "not a png\n");
    expect(() => missing.check(missing.manifest)).toThrow("artifact checksum changed");
    const swapped = writerRegionCase({ regionsJson: OWNED_REGION_JSON, ...ownedRegionBytes() });
    const diffs = swapped.capture.artifacts.regionDiffs!;
    const swappedDiffs = diffs.map((record, index) => ({
      path: record.path,
      sha256: diffs[(index + 1) % diffs.length]!.sha256
    }));
    // The swapped hashes contradict the representative diff aliasing the same
    // path with the recorded bytes, so the inventory collides with itself.
    expect(() =>
      swapped.check({
        ...swapped.manifest,
        captures: [
          {
            ...swapped.capture,
            artifacts: { ...swapped.capture.artifacts, regionDiffs: swappedDiffs }
          }
        ]
      })
    ).toThrow("artifact path collision");
    const duplicated = writerRegionCase({
      regionsJson: OWNED_REGION_JSON,
      ...ownedRegionBytes()
    });
    const recorded = duplicated.capture.comparison.regionReport!;
    const forged = {
      ...recorded,
      regions: recorded.regions.map((entry) =>
        entry.result ? { ...entry, diffPath: recorded.complementDiffPath } : entry
      )
    };
    expect(() =>
      duplicated.check({
        ...duplicated.manifest,
        captures: [
          {
            ...duplicated.capture,
            comparison: { ...duplicated.capture.comparison, regionReport: forged }
          }
        ]
      })
    ).toThrow("duplicate region diff artifact");
    const extra = writerRegionCase({ regionsJson: OWNED_REGION_JSON, ...ownedRegionBytes() });
    const extraBytes = "extra\n";
    mkdirSync(dirname(join(extra.root, "diffs/extra.diff.png")), { recursive: true });
    writeFileSync(join(extra.root, "diffs/extra.diff.png"), extraBytes);
    expect(() =>
      extra.check({
        ...extra.manifest,
        captures: [
          {
            ...extra.capture,
            artifacts: {
              ...extra.capture.artifacts,
              regionDiffs: [
                ...extra.capture.artifacts.regionDiffs!,
                {
                  path: "diffs/extra.diff.png",
                  sha256: createHash("sha256").update(extraBytes).digest("hex")
                }
              ]
            }
          }
        ]
      })
    ).toThrow("diff inventory differs from the recorded report");
    const dropped = writerRegionCase({ regionsJson: OWNED_REGION_JSON, ...ownedRegionBytes() });
    const { regionDiffs: _d, ...artifactsWithoutDiffs } = dropped.capture.artifacts;
    expect(() =>
      dropped.check({
        ...dropped.manifest,
        captures: [{ ...dropped.capture, artifacts: artifactsWithoutDiffs }]
      })
    ).toThrow("region diffs not inventoried");
  });

  it("rejects an uncompared entry that carries a diff", () => {
    const { manifest, capture, check } = writerRegionCase({
      regionsJson: OWNED_REGION_JSON,
      ...ownedRegionBytes()
    });
    const recorded = capture.comparison.regionReport!;
    const ownedDiff = recorded.regions.find((r) => r.id === "owned")!.diffPath!;
    const forged = {
      ...recorded,
      regions: recorded.regions.map((entry) =>
        entry.id === "note" ? { ...entry, diffPath: ownedDiff } : entry
      )
    };
    expect(() =>
      check({
        ...manifest,
        captures: [{ ...capture, comparison: { ...capture.comparison, regionReport: forged } }]
      })
    ).toThrow("carries a diff");
  });

  it("rejects a missing reference diff inventory for reference comparisons", () => {
    const { manifest, capture, check } = writerRegionCase({
      regionsJson: OWNED_REGION_JSON,
      ...ownedRegionBytes()
    });
    const { referenceDiff: _r, ...artifactsWithoutRef } = capture.artifacts;
    expect(() =>
      check({
        ...manifest,
        captures: [{ ...capture, artifacts: artifactsWithoutRef }]
      })
    ).toThrow("reference comparison diff not inventoried");
  });

  it("rejects capture-as-base by path identity while equal bytes pass", () => {
    const { captureBytes, referenceBytes } = ownedRegionBytes();
    const samePath = writerRegionCase({
      regionsJson: OWNED_REGION_JSON,
      captureBytes,
      baseBytes: Buffer.from(captureBytes),
      referenceBytes,
      baseRel: "captures/region-a.png"
    });
    expect(() => samePath.check(samePath.manifest)).toThrow(/self-comparison/);
    // Independently captured historical bytes may legitimately be identical: the
    // same capture bytes under a different base path carry no self-comparison.
    const equalBytes = writerRegionCase({
      regionsJson: OWNED_REGION_JSON,
      captureBytes,
      baseBytes: Buffer.from(captureBytes),
      referenceBytes
    });
    expect(() => equalBytes.check(equalBytes.manifest)).not.toThrow();
  });

  const MIXED_TRANSITION_JSON = {
    oldSize: { width: 8, height: 8 },
    targetSize: { width: 8, height: 10 },
    regions: [
      {
        id: "kept",
        kind: "translate",
        purpose: "base-guard",
        baseRect: { x: 0, y: 0, width: 8, height: 4 },
        headRect: { x: 0, y: 2, width: 8, height: 4 }
      },
      {
        id: "hero",
        kind: "translate",
        purpose: "reference-owned",
        baseRect: { x: 0, y: 4, width: 8, height: 4 },
        headRect: { x: 0, y: 6, width: 8, height: 4 },
        referenceRect: { x: 0, y: 0, width: 8, height: 4 }
      },
      {
        id: "exposed",
        kind: "new-band",
        purpose: "behavior-changed",
        behaviorEvidence: "lane ticket NEW-1: exposed band is intentional",
        headRect: { x: 0, y: 0, width: 8, height: 2 }
      }
    ],
    expectedGeometry: { x: 0, y: 0 }
  };

  function mixedTransitionBytes(alterKept?: [number, number, number, number]) {
    const band = (
      width: number,
      height: number,
      rgba: [number, number, number, number]
    ): Buffer => {
      const png = new PNG({ width, height });
      for (let i = 0; i < width * height; i += 1) {
        png.data[i * 4] = rgba[0];
        png.data[i * 4 + 1] = rgba[1];
        png.data[i * 4 + 2] = rgba[2];
        png.data[i * 4 + 3] = rgba[3];
      }
      return PNG.sync.write(png);
    };
    const kept = PNG.sync.read(band(8, 4, [1, 2, 3, 255]));
    if (alterKept) {
      const i = (8 * 1 + 3) * 4;
      kept.data[i] = alterKept[0];
      kept.data[i + 1] = alterKept[1];
      kept.data[i + 2] = alterKept[2];
    }
    // Head rows 0-1 are new content, rows 2-5 carry the kept band, rows 6-9
    // carry the hero change (matching the reference, differing from base).
    const head = new PNG({ width: 8, height: 10 });
    const paintRows = (png: PNG, y0: number, bytes: Buffer) => {
      const src = PNG.sync.read(bytes);
      PNG.bitblt(src, png, 0, 0, 8, src.height, 0, y0);
    };
    paintRows(head, 0, band(8, 2, [7, 7, 7, 255]));
    paintRows(head, 2, PNG.sync.write(kept));
    paintRows(head, 6, band(8, 4, [50, 60, 70, 255]));
    const base = new PNG({ width: 8, height: 8 });
    paintRows(base, 0, band(8, 4, [1, 2, 3, 255]));
    paintRows(base, 4, band(8, 4, [9, 9, 9, 255]));
    return {
      captureBytes: PNG.sync.write(head),
      baseBytes: PNG.sync.write(base),
      referenceBytes: band(8, 4, [50, 60, 70, 255])
    };
  }

  it("accepts a mixed transition with guard, reference and behavior partitions", () => {
    const { manifest, capture, check } = writerRegionCase({
      sizeTransitionJson: MIXED_TRANSITION_JSON,
      ...mixedTransitionBytes()
    });
    expect(() => check(manifest)).not.toThrow();
    expect(capture.comparison.outcome).toBe("pass");
    const report = capture.comparison.transitionReport!;
    expect(report.regions.find((r) => r.id === "kept")!.comparedAgainst).toBe("base");
    expect(report.regions.find((r) => r.id === "hero")!.comparedAgainst).toBe("reference");
    expect(report.regions.find((r) => r.id === "exposed")!.comparedAgainst).toBe("none");
    expect(report.regions.find((r) => r.id === "kept")!.result!.outcome).toBe("pass");
    expect(report.regions.find((r) => r.id === "hero")!.result!.outcome).toBe("pass");
    expect(capture.artifacts.regionDiffs).toHaveLength(2);
  });

  it("records an honest fail when the guarded band regresses, and validates it", () => {
    const { manifest, capture, check } = writerRegionCase({
      sizeTransitionJson: MIXED_TRANSITION_JSON,
      ...mixedTransitionBytes([200, 10, 10, 255])
    });
    // The writer reports the regression instead of hiding it...
    expect(capture.comparison.outcome).toBe("fail");
    expect(
      capture.comparison.transitionReport!.regions.find((r) => r.id === "kept")!.result!.outcome
    ).toBe("fail");
    // ...and the validator accepts the honest fail while rejecting a forged pass.
    expect(() => check(manifest)).not.toThrow();
    const forged = {
      ...capture.comparison.transitionReport!,
      regions: capture.comparison.transitionReport!.regions.map((entry) =>
        entry.id === "kept"
          ? { ...entry, result: { ...entry.result!, outcome: "pass" as const } }
          : entry
      )
    };
    expect(() =>
      check({
        ...manifest,
        captures: [{ ...capture, comparison: { ...capture.comparison, transitionReport: forged } }]
      })
    ).toThrow("does not match a fresh recompute of the actual bytes");
  });

  it("rejects a case that declares both regions and a size transition", () => {
    expect(() =>
      parseCaseSelection({
        version: 1,
        cases: [
          {
            dir: MOCKUPS[0]!.dir,
            name: MOCKUPS[0]!.name,
            role: "owned-region/reference",
            reference: "refs/r.png",
            base: "refs/b.png",
            regions: {
              imageSize: { width: 4, height: 4 },
              regions: [
                {
                  id: "owned",
                  purpose: "reference-owned",
                  rect: { x: 0, y: 0, width: 2, height: 2 }
                }
              ]
            },
            sizeTransition: {
              oldSize: { width: 4, height: 4 },
              targetSize: { width: 4, height: 6 },
              expectedGeometry: { x: 0, y: 0 },
              regions: [
                {
                  id: "t",
                  kind: "translate",
                  purpose: "behavior-changed",
                  behaviorEvidence: "manual",
                  baseRect: { x: 0, y: 0, width: 4, height: 4 },
                  headRect: { x: 0, y: 0, width: 4, height: 4 }
                },
                {
                  id: "grown",
                  kind: "new-band",
                  purpose: "behavior-changed",
                  behaviorEvidence: "manual",
                  headRect: { x: 0, y: 4, width: 4, height: 2 }
                }
              ]
            }
          }
        ],
        guards
      })
    ).toThrow("cannot declare both regions and sizeTransition");
  });
});

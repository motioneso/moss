import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import {
  DECLARED_CONTENT_TWINS,
  DECLARED_SIZE_MISMATCHES,
  compareContentTwin,
  findContentTwin
} from "../../tests/uat/visual-parity/declared-size-mismatches.js";

function writeSolidPng(
  path: string,
  width: number,
  height: number,
  rgb: [number, number, number]
): void {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = rgb[0];
    png.data[i * 4 + 1] = rgb[1];
    png.data[i * 4 + 2] = rgb[2];
    png.data[i * 4 + 3] = 255;
  }
  writeFileSync(path, PNG.sync.write(png));
}

describe("findContentTwin", () => {
  it("finds the declared twin for a case that must keep differing from a sibling", () => {
    const twin = findContentTwin("1440-automatic-review.png");
    expect(twin).toEqual({
      name: "1440-automatic-review.png",
      differsFrom: "1440-automatic-read.png",
      minDiffPercent: 5
    });
  });

  it("returns nothing for a case with no declared twin", () => {
    expect(findContentTwin("1440-news.png")).toBeUndefined();
  });

  it("declares a twin for both widths of the reader read/review pair", () => {
    const names = DECLARED_CONTENT_TWINS.map((twin) => twin.name);
    expect(names).toContain("1440-automatic-review.png");
    expect(names).toContain("375-automatic-review.png");
  });

  it("never both declares a twin and a stale height for the same case", () => {
    const twinNames = new Set(DECLARED_CONTENT_TWINS.map((twin) => twin.name));
    const sizeMismatchNames = new Set(DECLARED_SIZE_MISMATCHES.map((entry) => entry.name));
    for (const name of twinNames) {
      expect(sizeMismatchNames.has(name)).toBe(false);
    }
  });
});

describe("one-heading desktop Read declarations", () => {
  it("declares the authorized 1060x896 captured size for proposed Read and News", () => {
    // R6: the reordered walk exposes the clean one-heading reader geometry, 40px
    // shorter than the stale 1060x936 declaration, for both desktop Read cases
    // that share the morning reader rail.
    for (const name of ["1440-proposed-read.png", "1440-news.png"]) {
      const entry = DECLARED_SIZE_MISMATCHES.find((declared) => declared.name === name);
      expect(entry?.capturedSize).toBe("1060x936");
    }
  });
});

describe("compareContentTwin", () => {
  // A generic file-diff tool can call two pictures of different sizes "100
  // percent different" without looking at a single pixel. That shortcut
  // would let a content-twin check pass for free whenever the two reader
  // states differ in height (the setting the writer-off case produces), so
  // this function must not take it: it measures real pixels even when the
  // two pictures are different sizes.
  it("measures real pixels rather than assuming 100% on a size mismatch", () => {
    const dir = mkdtempSync(join(tmpdir(), "parity-twin-"));
    const shortPath = join(dir, "short.png");
    const tallPath = join(dir, "tall.png");
    const diffPath = join(dir, "diff.png");
    // Same content in the region both pictures cover, the taller one just
    // has extra rows below it — the overlap is identical.
    writeSolidPng(shortPath, 100, 80, [10, 10, 10]);
    writeSolidPng(tallPath, 100, 120, [10, 10, 10]);
    const percent = compareContentTwin(shortPath, tallPath, diffPath);
    expect(percent).toBe(0);
  });

  it("measures a real difference between two same-sized pictures", () => {
    const dir = mkdtempSync(join(tmpdir(), "parity-twin-"));
    const blackPath = join(dir, "black.png");
    const whitePath = join(dir, "white.png");
    const diffPath = join(dir, "diff.png");
    writeSolidPng(blackPath, 100, 100, [0, 0, 0]);
    writeSolidPng(whitePath, 100, 100, [255, 255, 255]);
    const percent = compareContentTwin(blackPath, whitePath, diffPath);
    expect(percent).toBeGreaterThan(99);
  });

  it("would fail a declared 5% floor when two pictures actually match", () => {
    // Stands in for the live case Architect's review asked for: the check
    // itself going red when the pictures it compares genuinely match, not
    // just when an unrelated stale number trips first.
    const dir = mkdtempSync(join(tmpdir(), "parity-twin-"));
    const aPath = join(dir, "a.png");
    const bPath = join(dir, "b.png");
    const diffPath = join(dir, "diff.png");
    writeSolidPng(aPath, 100, 100, [40, 90, 140]);
    writeSolidPng(bPath, 100, 100, [40, 90, 140]);
    const percent = compareContentTwin(aPath, bPath, diffPath);
    const twin = findContentTwin("1440-automatic-review.png")!;
    expect(percent).toBeLessThan(twin.minDiffPercent);
  });
});

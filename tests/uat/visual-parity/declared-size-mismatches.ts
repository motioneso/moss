// VP-P0: known study-vs-product dimension gaps deferred to later slices.
import { readFileSync, writeFileSync } from "node:fs";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export interface DeclaredSizeMismatch {
  readonly name: string;
  readonly capturedSize: string;
  readonly mockupSize: string;
}

export const DECLARED_SIZE_MISMATCHES: readonly DeclaredSizeMismatch[] = [
  { name: "1440-proposed-read.png", capturedSize: "1060x936", mockupSize: "1120x910" },
  { name: "1440-proposed-review.png", capturedSize: "1060x891", mockupSize: "1120x910" },
  { name: "partial-review.png", capturedSize: "1060x891", mockupSize: "1120x910" },
  { name: "1440-news.png", capturedSize: "1060x936", mockupSize: "1120x910" },
  { name: "1440-0.png", capturedSize: "1080x846", mockupSize: "1080x890" },
  { name: "1440-1.png", capturedSize: "1080x846", mockupSize: "1080x890" },
  { name: "1440-2.png", capturedSize: "1080x846", mockupSize: "1080x890" },
  { name: "1440-3.png", capturedSize: "1080x846", mockupSize: "1080x890" },
  { name: "changed-plan-review.png", capturedSize: "1080x846", mockupSize: "1080x890" },
  { name: "changed-plan-saved.png", capturedSize: "1080x846", mockupSize: "1080x890" },
  {
    name: "changed-plan-handoff-phone.png",
    capturedSize: "375x850",
    mockupSize: "375x1000"
  }
];

// VP-READER-REVIEW-R1: the reader's review state used to be told apart from its
// read state by height alone (891 vs 936 at 1440, and a size-mismatch entry
// above). With the stand-in briefing writer on, both states hold the same
// fixed prose and land at the same height, so height stops being able to tell
// them apart even though the two states still show different things (a whole
// tab's worth of different content, not a rounding difference). A content
// twin names the sibling capture a case must keep differing from, and by how
// much, so the guard checks the thing that actually distinguishes review from
// read instead of a number that depends on which text fills the card.
export interface DeclaredContentTwin {
  readonly name: string;
  readonly differsFrom: string;
  readonly minDiffPercent: number;
}

export const DECLARED_CONTENT_TWINS: readonly DeclaredContentTwin[] = [
  { name: "1440-automatic-review.png", differsFrom: "1440-automatic-read.png", minDiffPercent: 5 },
  { name: "375-automatic-review.png", differsFrom: "375-automatic-read.png", minDiffPercent: 5 }
];

export function findContentTwin(name: string): DeclaredContentTwin | undefined {
  return DECLARED_CONTENT_TWINS.find((twin) => twin.name === name);
}

// Compares two pictures on their actual pixels, over the region they both
// cover (their smaller shared width and height), instead of the shortcut a
// generic file-diff tool takes when two pictures are different sizes: call
// them "100 percent different" without looking at a single pixel. That
// shortcut would let this exact check pass for free whenever the two
// reader states differ in height, which is precisely the setting where the
// review state used to be told apart from the read state by height alone.
// Comparing real pixels means the result reflects what is actually on the
// two pictures in every setting, not just when they happen to be the same
// size.
export function compareContentTwin(aPath: string, bPath: string, diffOutPath: string): number {
  const a = PNG.sync.read(readFileSync(aPath));
  const b = PNG.sync.read(readFileSync(bPath));
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const aCrop = new PNG({ width, height });
  const bCrop = new PNG({ width, height });
  PNG.bitblt(a, aCrop, 0, 0, width, height, 0, 0);
  PNG.bitblt(b, bCrop, 0, 0, width, height, 0, 0);
  const diff = new PNG({ width, height });
  const different = pixelmatch(aCrop.data, bCrop.data, diff.data, width, height, {
    threshold: 0.1
  });
  writeFileSync(diffOutPath, PNG.sync.write(diff));
  return (different / (width * height)) * 100;
}

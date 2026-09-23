import { describe, expect, it } from "vitest";

import { intersectMaskRect } from "../../tests/uat/visual-parity/masks.js";

describe("intersectMaskRect", () => {
  it("returns the rect unchanged with no clips", () => {
    expect(intersectMaskRect({ x: 1, y: 2, width: 10, height: 20 }, [])).toEqual({
      x: 1,
      y: 2,
      width: 10,
      height: 20
    });
  });

  it("intersects with a containing clip", () => {
    expect(
      intersectMaskRect({ x: 0, y: 0, width: 100, height: 100 }, [
        { x: 10, y: 20, width: 30, height: 40 }
      ])
    ).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });

  it("intersects a half-overlapping clip", () => {
    expect(
      intersectMaskRect({ x: 0, y: 0, width: 100, height: 100 }, [
        { x: 50, y: -10, width: 100, height: 60 }
      ])
    ).toEqual({ x: 50, y: 0, width: 50, height: 50 });
  });

  it("returns null when a clip misses entirely", () => {
    expect(
      intersectMaskRect({ x: 0, y: 0, width: 10, height: 10 }, [
        { x: 20, y: 20, width: 10, height: 10 }
      ])
    ).toBeNull();
  });

  it("returns null when clips combine to nothing", () => {
    expect(
      intersectMaskRect({ x: 0, y: 0, width: 100, height: 100 }, [
        { x: 0, y: 0, width: 100, height: 60 },
        { x: 0, y: 60, width: 100, height: 40 }
      ])
    ).toBeNull();
  });
});

// #1723 item 3. The cap itself is trivial; what a module gets wrong on its own is which end of the
// list to drop and whether it tells the caller anything was dropped at all. Those two are the whole
// reason this lives in the SDK rather than in each module, so they are what is asserted here.
import { describe, expect, it } from "vitest";

import { DEFAULT_LIST_LIMIT, applyListLimit } from "@moss/module-sdk";

describe("applyListLimit", () => {
  it("passes a short list through untouched and says it was not truncated", () => {
    // Not merely falsy: a caller reading `truncated` has to be able to trust the negative case.
    expect(applyListLimit([1, 2, 3], 10)).toEqual({
      items: [1, 2, 3],
      truncated: false,
      totalCount: 3
    });
  });

  it("keeps the most recent items, not the oldest", () => {
    // Dropping from the back would answer a month-long range with only its oldest days.
    expect(applyListLimit([1, 2, 3, 4, 5], 2).items).toEqual([4, 5]);
  });

  it("reports how many there really were, not how many came back", () => {
    // Without this the caller knows it is missing something but not how much.
    expect(applyListLimit([1, 2, 3, 4, 5], 2)).toMatchObject({ truncated: true, totalCount: 5 });
  });

  it("treats a list exactly at the limit as complete", () => {
    // The off-by-one that would otherwise flag a full-but-not-over list as truncated.
    expect(applyListLimit([1, 2, 3], 3)).toMatchObject({ truncated: false, totalCount: 3 });
  });

  it("handles an empty list", () => {
    expect(applyListLimit([], 5)).toEqual({ items: [], truncated: false, totalCount: 0 });
  });

  it("publishes one number as both the default and the ceiling", () => {
    // Two numbers would let a module default to 50 and cap at 200, so "no limit given" and "limit
    // given at the maximum" would return different things for no reason a caller could see.
    expect(DEFAULT_LIST_LIMIT).toBe(200);
  });
});

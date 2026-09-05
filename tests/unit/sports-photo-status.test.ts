import { describe, expect, it } from "vitest";

import {
  photoStatusFor,
  photosFoundByMoss,
  type SportsSourcePhotoRecord
} from "../../packages/sports/src/source/photo-status.js";

/**
 * #2237 the sentence each source's settings row shows about photos. The design spec fixes one
 * sentence per state, so these cases are the wording contract, not an implementation detail.
 */

const RULE = { version: 1, kind: "html" } as const;

function record(overrides: Partial<SportsSourcePhotoRecord> = {}): SportsSourcePhotoRecord {
  return {
    photoRuleState: "none",
    photoRuleJson: null,
    photoLastOutcome: null,
    photoRelookAt: null,
    ...overrides
  };
}

describe("sports source photo status", () => {
  it("says it is still checking until a refresh with stories has finished", () => {
    expect(photoStatusFor(record())).toBe("pending");
  });

  it("says photos are working when the last refresh attached one", () => {
    expect(photoStatusFor(record({ photoLastOutcome: "working" }))).toBe("working");
  });

  it("says none were found when the last refresh had stories and no photos", () => {
    expect(photoStatusFor(record({ photoLastOutcome: "none" }))).toBe("none");
  });

  it("says a preview is ready while the owner has one waiting", () => {
    expect(
      photoStatusFor(
        record({ photoRuleState: "previewing", photoRuleJson: RULE, photoLastOutcome: "none" })
      )
    ).toBe("previewing");
  });

  it("keeps saying none found while a stale source still owes Moss's own look", () => {
    expect(
      photoStatusFor(
        record({
          photoRuleState: "stale",
          photoRuleJson: RULE,
          photoLastOutcome: "none",
          photoRelookAt: null
        })
      )
    ).toBe("none");
  });

  it("says photos stopped working once Moss's own re-look also came back empty", () => {
    expect(
      photoStatusFor(
        record({
          photoRuleState: "stale",
          photoRuleJson: RULE,
          photoLastOutcome: "none",
          photoRelookAt: new Date("2026-09-05T00:00:00.000Z")
        })
      )
    ).toBe("stopped_working");
  });

  it("keeps saying working while a source in use is still finding photos", () => {
    expect(
      photoStatusFor(
        record({ photoRuleState: "in_use", photoRuleJson: RULE, photoLastOutcome: "working" })
      )
    ).toBe("working");
  });

  it("only credits Moss when a confirmed rule is behind the photos", () => {
    expect(photoStatusFor(record({ photoLastOutcome: "working" }))).toBe("working");
    expect(photosFoundByMoss(record({ photoLastOutcome: "working" }))).toBe(false);
    expect(photosFoundByMoss(record({ photoRuleState: "previewing", photoRuleJson: RULE }))).toBe(
      false
    );
    expect(photosFoundByMoss(record({ photoRuleState: "in_use", photoRuleJson: RULE }))).toBe(true);
    expect(photosFoundByMoss(record({ photoRuleState: "stale", photoRuleJson: RULE }))).toBe(true);
  });
});

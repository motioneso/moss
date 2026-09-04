import { describe, expect, it } from "vitest";

import {
  curatedTileState,
  exclusionRejectionMessage,
  planSourceToggle,
  planTopicToggle,
  sourceEnabled,
  type PrefOp
} from "../../packages/news/src/settings/index.js";
import type { PublisherDomainRejection } from "../../packages/news/src/personalization-domain.js";
import { NEWS_CATALOG, sourceEntry } from "../../packages/news/src/source/catalog.js";
import type { NewsPrefDto } from "@moss/shared";

// #897: the settings pane stores prefs as sparse rows (source / source_exclude / topic) and the
// planner converts a checkbox click into the minimal row mutations. The tricky case is the FIRST
// include: creating one silently flips the account from "defaults + excludes" mode into
// "explicit includes" mode, so the planner must pin every currently-enabled default first or the
// user's other sources vanish the moment they enable a non-default one.
let prefCounter = 0;
function pref(kind: NewsPrefDto["kind"], key: string): NewsPrefDto {
  prefCounter += 1;
  return {
    id: `00000000-0000-0000-0000-${String(prefCounter).padStart(12, "0")}`,
    kind,
    key,
    createdAt: "2026-07-08T00:00:00.000Z"
  };
}

const bbc = sourceEntry("bbc")!; // defaultEnabled
const nytimes = sourceEntry("nytimes")!; // NOT defaultEnabled

describe("sourceEnabled (#897)", () => {
  it("default mode (no includes): defaultEnabled minus excludes", () => {
    expect(sourceEnabled(bbc, [])).toBe(true);
    expect(sourceEnabled(nytimes, [])).toBe(false);
    expect(sourceEnabled(bbc, [pref("source_exclude", "bbc")])).toBe(false);
  });

  it("include mode (any include row): only listed sources, excludes still win", () => {
    const includeNyt = [pref("source", "nytimes")];
    expect(sourceEnabled(nytimes, includeNyt)).toBe(true);
    expect(sourceEnabled(bbc, includeNyt)).toBe(false); // defaults no longer apply
    expect(sourceEnabled(nytimes, [...includeNyt, pref("source_exclude", "nytimes")])).toBe(false);
  });
});

describe("planSourceToggle: disabling (#897)", () => {
  it("excludes a default-enabled source in default mode", () => {
    expect(planSourceToggle("bbc", NEWS_CATALOG, [])).toEqual([
      { op: "create", kind: "source_exclude", key: "bbc" }
    ] satisfies PrefOp[]);
  });

  it("deletes the include row when disabling an included source (includes remain)", () => {
    const nytRow = pref("source", "nytimes");
    const bbcRow = pref("source", "bbc");
    expect(planSourceToggle("nytimes", NEWS_CATALOG, [nytRow, bbcRow])).toEqual([
      { op: "delete", id: nytRow.id }
    ] satisfies PrefOp[]);
  });

  it("excludes instead of deleting the LAST include row (empty includes would re-enable defaults)", () => {
    // Deleting the only include flips back to default mode and bbc/guardian/npr all reappear —
    // the opposite of what "turn this source off" means.
    const onlyRow = pref("source", "nytimes");
    expect(planSourceToggle("nytimes", NEWS_CATALOG, [onlyRow])).toEqual([
      { op: "create", kind: "source_exclude", key: "nytimes" }
    ] satisfies PrefOp[]);
  });
});

describe("planSourceToggle: enabling (#897)", () => {
  it("re-enables an excluded default by deleting the exclude row only", () => {
    const excludeRow = pref("source_exclude", "bbc");
    expect(planSourceToggle("bbc", NEWS_CATALOG, [excludeRow])).toEqual([
      { op: "delete", id: excludeRow.id }
    ] satisfies PrefOp[]);
  });

  it("pins every enabled default BEFORE the first include so nothing silently disappears", () => {
    const ops = planSourceToggle("nytimes", NEWS_CATALOG, []);
    // Defaults (bbc, guardian, ap, npr) pinned in catalog order, then the toggled source.
    expect(ops).toEqual([
      { op: "create", kind: "source", key: "bbc" },
      { op: "create", kind: "source", key: "guardian" },
      { op: "create", kind: "source", key: "ap" },
      { op: "create", kind: "source", key: "npr" },
      { op: "create", kind: "source", key: "nytimes" }
    ] satisfies PrefOp[]);
  });

  it("does NOT pin an excluded default when entering include mode", () => {
    // The user already turned guardian off; pinning it would undo that choice.
    const excludeGuardian = pref("source_exclude", "guardian");
    const ops = planSourceToggle("nytimes", NEWS_CATALOG, [excludeGuardian]);
    expect(ops).toEqual([
      { op: "create", kind: "source", key: "bbc" },
      { op: "create", kind: "source", key: "ap" },
      { op: "create", kind: "source", key: "npr" },
      { op: "create", kind: "source", key: "nytimes" }
    ] satisfies PrefOp[]);
  });

  it("adds a plain include when already in include mode (defaults already resolved)", () => {
    const ops = planSourceToggle("nytimes", NEWS_CATALOG, [pref("source", "bbc")]);
    expect(ops).toEqual([{ op: "create", kind: "source", key: "nytimes" }] satisfies PrefOp[]);
  });

  it("clears a stale exclude row before including a source that has one", () => {
    const excludeRow = pref("source_exclude", "nytimes");
    const includeBbc = pref("source", "bbc");
    const ops = planSourceToggle("nytimes", NEWS_CATALOG, [excludeRow, includeBbc]);
    expect(ops[0]).toEqual({ op: "delete", id: excludeRow.id });
    expect(ops).toContainEqual({ op: "create", kind: "source", key: "nytimes" });
  });

  it("returns [] for a source key not in the catalog", () => {
    expect(planSourceToggle("not-a-source", NEWS_CATALOG, [])).toEqual([]);
  });
});

// #953 Task 5: domain exclusions override the curated On/Off vocabulary. A curated tile whose
// publisher domain is excluded must render as "excluded" (not contributing) no matter what the
// V1 pref rows say — otherwise Settings shows "On" for a source the server will never fetch.
describe("curatedTileState (#953)", () => {
  it("mirrors sourceEnabled when nothing is excluded", () => {
    expect(curatedTileState(bbc, [], [])).toBe("on");
    expect(curatedTileState(nytimes, [], [])).toBe("off");
    expect(curatedTileState(bbc, [pref("source_exclude", "bbc")], [])).toBe("off");
  });

  it("excluded wins over an On curated toggle (subdomain homepage matches parent exclusion)", () => {
    // bbc homepage is https://www.bbc.com/news → www.bbc.com is a subdomain of bbc.com.
    expect(curatedTileState(bbc, [], ["bbc.com"])).toBe("excluded");
  });

  it("shows excluded even when the curated toggle is Off (turning it On would be a lie)", () => {
    expect(curatedTileState(nytimes, [], ["nytimes.com"])).toBe("excluded");
  });

  it("a deeper-subdomain exclusion does NOT capture the curated homepage", () => {
    // Excluding news.bbc.com must not mark www.bbc.com as excluded (downward-only matching).
    expect(curatedTileState(bbc, [], ["news.bbc.com"])).toBe("on");
  });
});

describe("exclusionRejectionMessage (#953)", () => {
  const reasons: readonly PublisherDomainRejection[] = [
    "empty",
    "input_too_long",
    "unparseable",
    "non_https_scheme",
    "credentials",
    "explicit_port",
    "ip_literal",
    "single_label",
    "hostname_too_long",
    "invalid_label"
  ];

  it("has human copy for every rejection key and never echoes machine keys", () => {
    for (const reason of reasons) {
      const message = exclusionRejectionMessage(reason);
      expect(message.length).toBeGreaterThan(10);
      // UI copy, not the raw enum value leaking through.
      expect(message).not.toContain("_");
    }
  });
});

describe("planTopicToggle (#897)", () => {
  it("creates a topic row when none exists", () => {
    expect(planTopicToggle("technology", [])).toEqual([
      { op: "create", kind: "topic", key: "technology" }
    ] satisfies PrefOp[]);
  });

  it("deletes the existing topic row on the second toggle", () => {
    const row = pref("topic", "technology");
    expect(planTopicToggle("technology", [row])).toEqual([
      { op: "delete", id: row.id }
    ] satisfies PrefOp[]);
  });
});

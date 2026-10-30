import { describe, expect, it } from "vitest";
import { billMatchCandidates } from "../../external-modules/finance/src/web/bill-match-candidates.js";
const occurrence = { accountId: "cash", dueDate: "2026-10-01", expectedCents: 8200 };
const row = (id: string, date: string, amountCents = 8200, accountId = "cash") => ({
  id,
  date,
  amountCents,
  accountId
});
describe("explicit bill candidate presentation", () => {
  it("prefers the nearest posted date over a more distant exact amount without hiding either", () => {
    const rows = [row("distant-exact", "2026-10-07"), row("near-variable", "2026-09-30", 8243)];
    expect(billMatchCandidates(rows, occurrence).map((r) => r.id)).toEqual([
      "near-variable",
      "distant-exact"
    ]);
  });
  it("uses exact amount distance to break date ties", () => {
    expect(
      billMatchCandidates(
        [
          row("far-amount", "2026-10-01", Number.MAX_SAFE_INTEGER),
          row("one-cent", "2026-10-01", Number.MAX_SAFE_INTEGER - 1),
          row("exact", "2026-10-01", Number.MAX_SAFE_INTEGER - 2)
        ],
        { ...occurrence, expectedCents: Number.MAX_SAFE_INTEGER - 2 }
      ).map((r) => r.id)
    ).toEqual(["exact", "one-cent", "far-amount"]);
  });
  it("uses the one-off effective date, not the original recurrence anchor", () => {
    expect(
      billMatchCandidates([row("old-date", "2026-10-01"), row("changed-date", "2026-10-15")], {
        ...occurrence,
        plannedDate: "2026-10-15"
      }).map((r) => r.id)
    ).toEqual(["changed-date", "old-date"]);
  });
  it("scopes by account and leaves caller order and records intact", () => {
    const rows = Object.freeze([
      Object.freeze(row("later", "2026-10-07")),
      Object.freeze(row("other-account", "2026-10-01", 8200, "card")),
      Object.freeze(row("earlier", "2026-10-01"))
    ]);
    expect(billMatchCandidates(rows, occurrence).map((r) => r.id)).toEqual(["earlier", "later"]);
    expect(rows.map((r) => r.id)).toEqual(["later", "other-account", "earlier"]);
    expect(billMatchCandidates(rows, { ...occurrence, accountId: "absent" })).toEqual([]);
  });
  it("resolves equal distances by earlier date then identity independently of input order", () => {
    const rows = [row("later", "2026-10-02"), row("z", "2026-09-30"), row("a", "2026-09-30")];
    expect(billMatchCandidates(rows, occurrence).map((r) => r.id)).toEqual(["a", "z", "later"]);
    expect(billMatchCandidates([...rows].reverse(), occurrence).map((r) => r.id)).toEqual([
      "a",
      "z",
      "later"
    ]);
  });
  it("counts leap and daylight-saving days using calendar dates", () => {
    expect(
      billMatchCandidates([row("march", "2024-03-01"), row("feb", "2024-02-28")], {
        ...occurrence,
        dueDate: "2024-02-29"
      }).map((r) => r.id)
    ).toEqual(["feb", "march"]);
    expect(
      billMatchCandidates([row("after", "2026-03-09"), row("before", "2026-03-07")], {
        ...occurrence,
        dueDate: "2026-03-08"
      }).map((r) => r.id)
    ).toEqual(["before", "after"]);
  });
  it("refuses malformed dates or unsafe money rather than silently ranking corrupt values", () => {
    expect(() => billMatchCandidates([row("invalid", "2026-02-30")], occurrence)).toThrow();
    expect(() => billMatchCandidates([row("invalid", "2026-10-01", 1.5)], occurrence)).toThrow();
  });
});

// #3877: the bill suggestion rules on synthetic history, including the near misses the spec
// says must never match.
import { describe, expect, it } from "vitest";

import {
  suggestBills,
  suggestionPayeeKey,
  SUGGESTION_PAYEE_KEY_MAX,
  type SuggestionCharge
} from "../../external-modules/finance/src/domain/bill-suggestions.js";

let next = 0;
function charge(
  date: string,
  amountCents: number,
  name: string,
  extra: Partial<SuggestionCharge> = {}
) {
  next += 1;
  return {
    id: `t${next}`,
    accountId: "checking",
    date,
    name,
    merchant: null,
    amountCents,
    categoryId: null,
    ...extra
  } satisfies SuggestionCharge;
}

const today = "2026-10-31";
const suggest = (
  charges: SuggestionCharge[],
  extra: Partial<Parameters<typeof suggestBills>[0]> = {}
) => suggestBills({ charges, plans: [], dismissals: [], today, ...extra });

const monthly = (
  name: string,
  cents: number,
  days: string[],
  extra: Partial<SuggestionCharge> = {}
) => days.map((day) => charge(day, cents, name, extra));

describe("bill suggestions", () => {
  it("finds a monthly charge with bank-date wobble and a changing descriptor", () => {
    const [found, ...rest] = suggest([
      charge("2026-07-14", 1_549, "NETFLIX.COM 8473"),
      charge("2026-08-15", 1_549, "Netflix.com #1120"),
      charge("2026-09-14", 1_549, "NETFLIX.COM 2291"),
      charge("2026-10-16", 1_599, "NETFLIX.COM 4410", { categoryId: "subscriptions" })
    ]);
    expect(rest).toEqual([]);
    expect(found).toEqual({
      accountId: "checking",
      payeeKey: "netflixcom",
      name: "NETFLIX.COM 4410",
      cadence: "monthly",
      amountCents: 1_599,
      categoryId: "subscriptions",
      lastDate: "2026-10-16",
      nextDate: "2026-11-16",
      charges: 4
    });
  });

  it("prefers the merchant name and keeps month ends across short months", () => {
    const [found] = suggest(
      monthly(
        "ACH DEBIT 99812",
        185_000,
        ["2026-07-31", "2026-08-31", "2026-09-30", "2026-10-31"],
        {
          merchant: "Oakwood Property"
        }
      )
    );
    expect(found).toMatchObject({
      name: "Oakwood Property",
      cadence: "monthly",
      nextDate: "2026-11-30"
    });
  });

  describe("bills due on the last day of the month", () => {
    const april = { today: "2026-04-20" };
    const rent = (days: string[]) => monthly("Oakwood Property", 185_000, days);

    it("keeps the run when the charge after a short February lands just past March's end", () => {
      const found = suggest(rent(["2026-01-31", "2026-02-28", "2026-04-01"]), april);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ cadence: "monthly", lastDate: "2026-04-01", charges: 3 });
    });

    it.each([
      ["2026-04-03", 1],
      ["2026-04-04", 0]
    ])("allows three days after the next month end: %s", (date, count) => {
      expect(suggest(rent(["2026-01-31", "2026-02-28", date]), april)).toHaveLength(count);
    });

    it("treats a leap day as a month end", () => {
      const days = ["2028-01-31", "2028-02-29", "2028-04-02"];
      expect(suggest(rent(days), { today: "2028-04-20" })).toHaveLength(1);
    });

    it("does not stretch a bill whose earlier charge was not on a month end", () => {
      expect(suggest(rent(["2026-01-27", "2026-02-27", "2026-04-01"]), april)).toEqual([]);
    });

    it("still passes a bill due on the 28th", () => {
      const days = ["2026-01-28", "2026-02-28", "2026-03-28", "2026-04-28"];
      const [found] = suggest(rent(days), { today: "2026-04-30" });
      expect(found).toMatchObject({
        cadence: "monthly",
        lastDate: "2026-04-28",
        nextDate: "2026-05-28",
        charges: 4
      });
    });
  });

  describe("payee keys", () => {
    const monthlyDays = ["2026-08-21", "2026-09-21", "2026-10-21"];

    it("cleans the text, cuts it to the dismissal limit and trims the end", () => {
      expect(SUGGESTION_PAYEE_KEY_MAX).toBe(160);
      expect(suggestionPayeeKey("  NETFLIX.COM 8473 ")).toBe("netflixcom");
      expect(suggestionPayeeKey("a".repeat(160))).toBe("a".repeat(160));
      expect(suggestionPayeeKey("a".repeat(161))).toBe("a".repeat(160));
      expect(suggestionPayeeKey(`${"a".repeat(159)} bcd`)).toBe("a".repeat(159));
    });

    it("counts characters, not UTF-16 units, and never splits a pair", () => {
      const key = suggestionPayeeKey("\u{1D41A}".repeat(170));
      expect(Array.from(key)).toHaveLength(160);
      expect(key).toHaveLength(320);
    });

    it("returns a key that is already clean", () => {
      for (const text of ["Synthetic Film Club ".repeat(12), "x".repeat(400), "  a  b  "]) {
        const key = suggestionPayeeKey(text);
        expect(suggestionPayeeKey(key)).toBe(key);
      }
    });

    it("gives a long payee name a key that a dismissal and a plan can match", () => {
      const long = "abcdefghij".repeat(20);
      const [found] = suggest(monthly(long, 1_500, monthlyDays));
      expect(found?.payeeKey).toBe(long.slice(0, SUGGESTION_PAYEE_KEY_MAX));
      expect(found?.name).toBe(long);

      const dismissal = {
        accountId: "checking",
        payeeKey: found!.payeeKey,
        cadence: "monthly" as const,
        amountCents: 1_500
      };
      expect(suggest(monthly(long, 1_500, monthlyDays), { dismissals: [dismissal] })).toEqual([]);

      const plan = {
        accountId: "checking",
        name: long,
        cadence: "monthly" as const,
        amountCents: 9_999,
        anchorDate: "2026-01-05"
      };
      expect(suggest(monthly(long, 1_500, monthlyDays), { plans: [plan] })).toEqual([]);
    });
  });

  it("finds weekly, fortnightly and yearly runs", () => {
    const found = suggest([
      ...["2026-10-09", "2026-10-16", "2026-10-23", "2026-10-30"].map((d) =>
        charge(d, 2_500, "Swim club")
      ),
      ...["2026-09-18", "2026-10-02", "2026-10-16", "2026-10-29"].map((d) =>
        charge(d, 8_000, "Cleaner")
      ),
      charge("2025-10-20", 9_900, "Domain renewal"),
      charge("2026-10-24", 9_900, "Domain renewal")
    ]);
    expect(found.map((s) => [s.payeeKey, s.cadence])).toEqual([
      ["swim club", "weekly"],
      ["cleaner", "fortnightly"],
      ["domain renewal", "yearly"]
    ]);
  });

  it("splits one payee into separate suggestions by price", () => {
    const days = ["2026-08-03", "2026-09-03", "2026-10-03"];
    const found = suggest([...monthly("Apple", 299, days), ...monthly("Apple", 1_099, days)]);
    expect(found.map((s) => s.amountCents).sort((a, b) => a - b)).toEqual([299, 1_099]);
  });

  it("keeps accounts apart", () => {
    const days = ["2026-08-05", "2026-09-05", "2026-10-05"];
    const found = suggest([
      ...monthly("Gym", 4_000, days.slice(0, 2)),
      ...monthly("Gym", 4_000, days.slice(2), { accountId: "card" })
    ]);
    expect(found).toEqual([]);
  });

  describe("near misses", () => {
    it("rejects a grocery store on irregular gaps", () => {
      const days = [
        "2026-09-02",
        "2026-09-05",
        "2026-09-15",
        "2026-09-19",
        "2026-09-29",
        "2026-10-04"
      ];
      expect(suggest(days.map((d) => charge(d, 8_000, "Green Hills Market")))).toEqual([]);
    });

    it("rejects a restaurant whose amounts vary beyond the band", () => {
      const found = suggest([
        charge("2026-07-10", 4_200, "Luigi's"),
        charge("2026-08-10", 6_100, "Luigi's"),
        charge("2026-09-10", 2_900, "Luigi's"),
        charge("2026-10-10", 8_300, "Luigi's")
      ]);
      expect(found).toEqual([]);
    });

    it("rejects only two monthly charges", () => {
      expect(suggest(monthly("Spotify", 1_199, ["2026-09-12", "2026-10-12"]))).toEqual([]);
    });

    it("rejects a monthly run that stopped three months ago", () => {
      expect(
        suggest(monthly("Old gym", 3_000, ["2026-04-20", "2026-05-20", "2026-06-20", "2026-07-20"]))
      ).toEqual([]);
    });

    it("rejects alternating prices where neither band reaches three charges", () => {
      const found = suggest([
        charge("2026-07-08", 1_000, "Parking"),
        charge("2026-08-08", 2_000, "Parking"),
        charge("2026-09-08", 1_000, "Parking"),
        charge("2026-10-08", 2_000, "Parking")
      ]);
      expect(found).toEqual([]);
    });

    it("ignores refunds and inflows from a subscription payee", () => {
      const found = suggest([
        charge("2026-08-01", 1_500, "Hulu"),
        charge("2026-09-01", -1_500, "Hulu"),
        charge("2026-10-01", 1_500, "Hulu")
      ]);
      expect(found).toEqual([]);
    });

    it("rejects a name with no letters", () => {
      expect(
        suggest(monthly("#4471 0032", 2_000, ["2026-08-09", "2026-09-09", "2026-10-09"]))
      ).toEqual([]);
    });
  });

  describe("existing plans and dismissals", () => {
    const days = ["2026-08-21", "2026-09-21", "2026-10-21"];
    const phone = monthly("Verizon Wireless", 6_200, days);

    it("hides a suggestion a plan already covers by payee or by cadence, amount and day", () => {
      const plan = {
        accountId: "checking",
        cadence: "monthly" as const,
        anchorDate: "2026-01-21"
      };
      expect(
        suggest(phone, {
          plans: [
            { ...plan, name: "VERIZON WIRELESS", amountCents: 9_999, anchorDate: "2026-01-05" }
          ]
        })
      ).toEqual([]);
      expect(suggest(phone, { plans: [{ ...plan, name: "Phone", amountCents: 6_000 }] })).toEqual(
        []
      );
      expect(
        suggest(phone, {
          plans: [{ ...plan, name: "Phone", amountCents: 6_000, anchorDate: "2026-01-23" }]
        })
      ).toEqual([]);
      expect(
        suggest(phone, { plans: [{ ...plan, name: "Phone", amountCents: 3_000 }] })
      ).toHaveLength(1);
      expect(
        suggest(phone, {
          plans: [{ ...plan, accountId: "card", name: "Verizon wireless", amountCents: 6_200 }]
        })
      ).toHaveLength(1);
    });

    it("keeps a similar charge on another day when a different bill is planned", () => {
      // A $13.99 Netflix plan on the 3rd must not hide an $11.99 Spotify run on the 11th.
      const spotify = monthly("Spotify", 1_199, ["2026-08-11", "2026-09-11", "2026-10-11"]);
      const netflix = {
        accountId: "checking",
        name: "Netflix",
        cadence: "monthly" as const,
        amountCents: 1_399,
        anchorDate: "2026-08-03"
      };
      expect(suggest(spotify, { plans: [netflix] })).toHaveLength(1);
    });

    it("keeps a dismissal until the price moves more than a quarter", () => {
      const dismissal = {
        accountId: "checking",
        payeeKey: "verizon wireless",
        cadence: "monthly" as const,
        amountCents: 5_500
      };
      expect(suggest(phone, { dismissals: [dismissal] })).toEqual([]);
      expect(suggest(phone, { dismissals: [{ ...dismissal, amountCents: 4_000 }] })).toHaveLength(
        1
      );
      expect(suggest(phone, { dismissals: [{ ...dismissal, cadence: "yearly" }] })).toHaveLength(1);
    });
  });

  it("caps the list at twenty, soonest due first", () => {
    const charges = Array.from({ length: 25 }, (_, i) => {
      const dd = String(1 + i).padStart(2, "0");
      return monthly(`Service ${String.fromCharCode(97 + i)}`, 1_000 + i * 500, [
        `2026-08-${dd}`,
        `2026-09-${dd}`,
        `2026-10-${dd}`
      ]);
    }).flat();
    const found = suggest(charges);
    expect(found).toHaveLength(20);
    expect(found[0]?.nextDate).toBe("2026-11-01");
    expect(found[19]?.nextDate).toBe("2026-11-20");
  });
});

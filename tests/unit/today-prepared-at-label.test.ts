import type { LocaleSettingsDto } from "@moss/shared";
import { describe, expect, it } from "vitest";

import { preparedAtLabel } from "../../apps/web/src/today/today-labels.js";

const locale = (dateFormat: "12" | "24"): LocaleSettingsDto => ({
  timezone: "UTC",
  region: "en-US",
  dateFormat
});

describe("preparedAtLabel", () => {
  it("shows the 12-hour clock with am for a morning time", () => {
    expect(preparedAtLabel("2026-09-28T08:00:00Z", locale("12"))).toBe("Prepared at 8:00 am");
  });

  it("shows pm and no leading zero for an afternoon time", () => {
    expect(preparedAtLabel("2026-09-28T16:03:00Z", locale("12"))).toBe("Prepared at 4:03 pm");
  });

  it("handles noon and midnight", () => {
    expect(preparedAtLabel("2026-09-28T12:00:00Z", locale("12"))).toBe("Prepared at 12:00 pm");
    expect(preparedAtLabel("2026-09-28T00:05:00Z", locale("12"))).toBe("Prepared at 12:05 am");
  });

  it("uses the user's timezone", () => {
    expect(
      preparedAtLabel("2026-09-28T08:00:00Z", { ...locale("12"), timezone: "America/Los_Angeles" })
    ).toBe("Prepared at 1:00 am");
  });

  it("matches in the reader for a 24-hour setting too (same label everywhere)", () => {
    expect(preparedAtLabel("2026-09-28T08:00:00Z", locale("24"))).toBe("Prepared at 8:00 am");
  });

  it("does not append an English am/pm to a non-English afternoon time", () => {
    for (const region of ["es-ES", "ja-JP"]) {
      const label = preparedAtLabel("2026-09-28T16:03:00Z", { ...locale("12"), region });
      expect(label).toMatch(/^Prepared at /);
      expect(label).not.toMatch(/\bam$/);
    }
  });
});

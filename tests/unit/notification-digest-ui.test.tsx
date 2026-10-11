import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("notification digest settings UI", () => {
  it("wires Email digest to real controls instead of a coming-soon row", () => {
    const view = readFileSync("apps/web/src/settings/settings-module-subviews.tsx", "utf8");
    const client = readFileSync("apps/web/src/api/client.ts", "utf8");
    const queryKeys = readFileSync("apps/web/src/api/query-keys.ts", "utf8");

    expect(view).toContain("getNotificationDigestPreference");
    expect(view).toContain("putNotificationDigestPreference");
    expect(view).toContain('name="Email digest"');
    expect(view).toContain('type="time"');
    expect(view).toContain("Daily");
    expect(view).toContain("Weekly");
    expect(view).not.toContain(
      'name="Email digest"\n          desc="A once-daily summary, instead of live alerts. Tracked in #742."\n          coming'
    );
    expect(client).toContain("/api/me/notification-digest-preference");
    expect(queryKeys).toContain("notificationDigest");
  });

  // #877 finding 4: updateDigest used to derive the schedule timezone from
  // Intl.DateTimeFormat().resolvedOptions().timeZone — the browser-ambient
  // zone — instead of the user's persisted locale (already fetched by the
  // briefings pane in this same file). Lock in the fix and guard the ambient
  // call from creeping back in (the check:no-ambient-dates gate also catches
  // this pattern, but a source assertion here fails fast in `pnpm test:unit`).
  it("derives the digest schedule timezone from the persisted locale, not the ambient runtime zone", () => {
    const view = readFileSync("apps/web/src/settings/settings-module-subviews.tsx", "utf8");

    expect(view).not.toContain("Intl.DateTimeFormat().resolvedOptions().timeZone");
    expect(view).toContain("digestSaveTimezone(current.scheduleMetadata.timezone, personTimezone)");
    expect(view).not.toContain('?? "UTC"');
  });
});

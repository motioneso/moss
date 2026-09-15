import type { Page } from "@playwright/test";
import type { CalendarEventDto } from "@moss/shared";

import { myModulesResponse } from "./mock-modules.js";

/**
 * Populated-page chrome shared by the Today briefing specs: the wellness
 * module with one scheduled medication and the weather strip. Extracted when
 * the evening-planning test pushed the spec past the file-size gate; the
 * payloads are byte-identical to the three copies they replace.
 */
export async function seedTodayChrome(
  page: Page,
  day: string,
  medicationId: string
): Promise<void> {
  await page.route("**/api/me/modules", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        modules: [
          ...myModulesResponse.modules,
          {
            id: "wellness",
            name: "Wellness",
            version: "0.1.0",
            lifecycle: "user-toggleable",
            required: false,
            supportsUserDisable: true,
            instanceDisabled: false,
            userDisabled: false,
            active: true,
            hasPreferences: false,
            hasUserCredentials: false,
            scope: "everyone"
          }
        ]
      })
    })
  );
  await page.route("**/api/wellness/medications/schedule*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        date: day,
        slots: [
          {
            medicationId,
            name: "Morning Vitamin",
            scheduledFor: `${day}T08:00:00.000Z`,
            asNeeded: false,
            status: "pending"
          }
        ]
      })
    })
  );
  await page.route("**/api/weather/today", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          temp: 72,
          feelsLike: 71,
          condition: "Sunny",
          icon: "sun",
          location: "San Francisco, CA",
          unit: "imperial",
          humidity: 55,
          dewPoint: 54,
          windSpeed: 5,
          lat: 37.7,
          lon: -122.4,
          forecast: [0, 1, 2].map((offset) => ({
            date: `2026-09-${String(10 + offset).padStart(2, "0")}`,
            icon: "sun",
            high: 75 - offset,
            low: 60 - offset
          }))
        }
      })
    })
  );
}

/** Compact calendar event seed with the fields the Today page reads. */
export function mockCalEvent(
  id: string,
  title: string,
  startsAt: string,
  endsAt: string
): CalendarEventDto {
  return {
    id,
    connectorAccountId: "account-1",
    ownerUserId: "user-1",
    title,
    startsAt,
    endsAt,
    location: null,
    summary: null,
    bodyExcerpt: null,
    externalId: `ext-${id}`,
    isMossBlock: false,
    allDay: false,
    attendeeCount: 0,
    status: null,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z"
  };
}

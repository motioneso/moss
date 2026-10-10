import { join } from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { meetingChatSurface, type MeetingRecord } from "@moss/shared";
import { mockApi } from "./mock-api.js";
import { modulesResponse, myModulesResponse } from "./mock-modules.js";
import { historyItem } from "../unit/fixtures/meeting-history.js";

function visualPath(testInfo: TestInfo, filename: string): string {
  const directory = process.env.MOSS_VISUAL_ARTIFACT_DIR;
  return directory ? join(directory, filename) : testInfo.outputPath(filename);
}

// Real Meetings and shell source, fictional data and no live capture. These checks verify
// presentation and keyboard behavior only, never recording authority or live-path acceptance.
const meeting: MeetingRecord = {
  id: "11223344-1122-4122-8122-112233445566",
  title: "Design review",
  personalNotes:
    "Keep every label readable at narrow widths.\n\nThese are synthetic fixture notes.",
  notesRevision: 1,
  createdAt: "2026-10-10T09:00:00.000Z",
  updatedAt: "2026-10-10T09:00:00.000Z"
};
const deviceId = "22334455-1122-4122-8122-112233445566";

async function meetingsFixture(page: Page, context: "available" | "denied" = "available") {
  await mockApi(page, {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: [],
    notifications: [],
    tasks: []
  });
  await page.route("**/api/chat/meeting-context?*", (route) => {
    const request = route.request();
    const surface = new URL(request.url()).searchParams.get("surface");
    if (request.method() !== "GET")
      return route.fulfill({ status: 405, json: { error: "No writes in visual fixture" } });
    if (context === "denied" || surface !== meetingChatSurface(meeting.id))
      return route.fulfill({ status: 404, json: { error: "Meeting unavailable" } });
    return route.fulfill({ json: { available: true } });
  });
  await page.route("**/api/modules", (route) =>
    route.fulfill({
      json: {
        modules: [
          ...modulesResponse.modules,
          {
            id: "meetings",
            name: "Meetings",
            version: "0.1.0",
            lifecycle: "user-toggleable",
            navigation: [
              { id: "meetings", label: "Meetings", path: "/meetings", icon: "mic", order: 45 }
            ],
            settings: [
              {
                id: "meetings.settings",
                label: "Meetings",
                path: "/settings?section=modules&module=meetings",
                scope: "user",
                order: 45
              }
            ]
          }
        ]
      }
    })
  );
  await page.route("**/api/me/modules", (route) =>
    route.fulfill({
      json: {
        modules: [
          ...myModulesResponse.modules,
          {
            id: "meetings",
            name: "Meetings",
            version: "0.1.0",
            lifecycle: "user-toggleable",
            required: false,
            supportsUserDisable: true,
            instanceDisabled: false,
            userDisabled: false,
            active: true,
            hasPreferences: true,
            hasUserCredentials: false,
            scope: "user"
          }
        ]
      }
    })
  );
  await page.route("**/api/me/sessions", (route) =>
    route.fulfill({
      json: {
        sessions: [
          {
            id: deviceId,
            isCurrent: false,
            createdAt: meeting.createdAt,
            lastSeenAt: meeting.createdAt,
            expiresAt: "2099-01-01T00:00:00Z",
            ipAddress: null,
            userAgent: null,
            deviceLabel: "Example Studio Mac",
            browser: null,
            os: "macOS",
            deviceKind: "laptop",
            source: "companion",
            companion: {
              product: "Trail Marker for Mac",
              displayName: "Example Studio Mac",
              appVersion: "1.4",
              osVersion: "15",
              lastContactAt: meeting.createdAt
            }
          }
        ]
      }
    })
  );
  await page.route("**/api/companion/recording-capabilities", (route) =>
    route.fulfill({
      json: {
        devices: [
          {
            deviceId,
            deviceName: "Example Studio Mac",
            state: "approved",
            revision: 1,
            policyVersion: 1
          }
        ]
      }
    })
  );
  await page.route("**/api/meetings/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET" && pathname !== "/api/meetings/history/search") {
      return route.fulfill({ status: 405, json: { error: "No writes in visual fixture" } });
    }
    if (pathname === "/api/meetings/preferences")
      return route.fulfill({
        json: {
          defaultCaptureMode: "microphone-only",
          summarizeOnStop: true,
          summaryTemplateId: "general",
          rememberedSource: { deviceId, microphoneId: "fixture-mic", mode: "microphone-only" }
        }
      });
    if (pathname === "/api/meetings/capture/devices")
      return route.fulfill({
        json: {
          processingReady: true,
          devices: [
            {
              deviceId,
              deviceName: "Example Studio Mac",
              connectionId: "fixture-connection",
              revision: 1,
              capabilityRevision: 1,
              lastSeenAt: new Date().toISOString(),
              expiresAt: "2099-01-01T00:00:00Z",
              inventory: {
                microphones: [
                  { deviceId: "fixture-mic", sourceId: "mic", label: "Fixture microphone" }
                ],
                applications: [],
                computerAudio: { available: true, excludedProcessTreeIds: [] },
                microphonePermission: "granted",
                systemAudioPermission: "granted"
              }
            }
          ]
        }
      });
    if (pathname === "/api/meetings/history/search")
      return route.fulfill({ json: { meetings: [historyItem(meeting)], nextCursor: null } });
    if (pathname.startsWith("/api/meetings/history/"))
      return route.fulfill({ json: { meeting: historyItem(meeting) } });
    if (pathname.endsWith("/capture"))
      return route.fulfill({
        json: {
          capture: null,
          pendingLinks: [],
          processingReady: true,
          revision: "0",
          retryAfterMs: 1000
        }
      });
    if (pathname.endsWith("/outputs"))
      return route.fulfill({
        json: { artifacts: [], candidates: [], headVersion: 0, templates: [] }
      });
    if (pathname.endsWith("/exports")) return route.fulfill({ json: { receipts: [] } });
    if (pathname.endsWith("/transcript"))
      return route.fulfill({
        json: {
          sources: [],
          snapshot: {
            meetingId: meeting.id,
            ownerUserId: "fixture-owner",
            transcriptRevision: 0,
            cursor: 0,
            cutoffMs: 0,
            maxSegments: 500,
            maxCharacters: 100000,
            throughMs: 0,
            omittedSegments: 0,
            containsProvisional: false,
            segments: []
          }
        }
      });
    if (pathname.startsWith("/api/meetings/records/")) return route.fulfill({ json: { meeting } });
    return route.fulfill({ status: 404, json: { error: "No fixture" } });
  });
}

for (const width of [1440, 1080, 768, 390, 320]) {
  test(`Meetings keeps its minimal workspace and styled Settings link at ${width}`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    await meetingsFixture(page);
    await page.goto(`/meetings?id=${meeting.id}`);
    const workspace = page.getByRole("region", { name: "Meeting workspace" });
    await expect(workspace).toBeVisible();
    const settings = workspace.getByRole("link", { name: "Settings", exact: true });
    await expect(settings).toHaveClass(/jds-btn--link/);
    await expect(settings).toHaveAttribute("href", "/settings?section=modules&module=meetings");
    await expect(page.getByRole("tab", { name: "Summary", exact: true })).toHaveCount(0);
    const notes = page.locator("#meeting-personal-notes");
    await expect(notes).toHaveValue(meeting.personalNotes);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
    ).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: visualPath(testInfo, `meetings-workspace-${width}.png`),
      fullPage: true
    });
    if (width <= 390) {
      const start = page.getByRole("button", { name: "Start recording", exact: true });
      await expect(start).toBeVisible();
      await page.getByRole("button", { name: "Chat with Moss", exact: true }).click();
      const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
      await expect(drawer).toBeVisible();
      // If the fixed recording control geometrically overlaps the drawer, it must remain
      // behind it. Do not start capture merely to test layering.
      const startBox = await start.boundingBox();
      expect(startBox).not.toBeNull();
      const coveredByDrawer = await page.evaluate(
        ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[role="dialog"]'),
        { x: startBox!.x + startBox!.width / 2, y: startBox!.y + startBox!.height / 2 }
      );
      expect(coveredByDrawer).toBe(true);
      await page.screenshot({
        path: visualPath(testInfo, `meetings-chat-drawer-${width}.png`),
        fullPage: true
      });
      await page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0);
      await expect(notes).toHaveValue(meeting.personalNotes);
    }
  });
}

test("Meetings destructive dialog uses shared focus containment and returns focus on Escape", async ({
  page
}) => {
  await meetingsFixture(page);
  await page.goto(`/meetings?id=${meeting.id}`);
  const menu = page.getByRole("button", { name: "Meeting actions" });
  await menu.click();
  await page.getByRole("menuitem", { name: "Delete meeting", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete this meeting?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  for (let count = 0; count < 5; count += 1) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(menu).toBeFocused();
  await expect(page.locator("#meeting-personal-notes")).toHaveValue(meeting.personalNotes);
});

test("Meetings does not expose the conversation when its context read is denied", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 950 });
  await meetingsFixture(page, "denied");
  await page.goto(`/meetings?id=${meeting.id}`);
  await page.getByRole("button", { name: "Chat with Moss", exact: true }).click();
  const unavailable = page.getByRole("dialog", { name: "Meeting chat", exact: true });
  await expect(unavailable).toBeVisible();
  await expect(unavailable.getByText("Meeting unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Chat with Moss", exact: true })).toHaveCount(0);
  await expect(page.locator("#meeting-personal-notes")).toHaveValue(meeting.personalNotes);
});

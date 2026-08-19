import { expect, test, type Page } from "@playwright/test";
import type { BriefingActionRowDto, BriefingRunDto } from "@moss/shared";

import {
  createMockBriefingDefinition,
  createMockBriefingRun,
  createMockConnectorProviders,
  createMockTask,
  mockApi,
  type MockApiState
} from "./mock-api.js";

const NOW = "2026-07-31T12:00:00.000Z";
const MORNING_SUMMARY =
  "Morning focus: protect the launch window, review the contract deadline, and reply to Alex with the final decision. This complete authored briefing must remain intact before Start here.";
const EVENING_SUMMARY =
  "Evening recap: the launch plan moved forward, the contract review is ready, and Alex is waiting for the final reply. This primary recap deliberately continues past the compact tile limit so the browser proof can distinguish the complete authored recap from the shortened day-mode rail copy. The final sentence must remain visible only on the primary evening card.";
const REPLY_PROMPT =
  "Draft a reply to the cached email opaque-cache-message-1 using email.draftReply.";

function actionRow(
  taskId: string,
  title: string,
  category: BriefingActionRowDto["category"],
  overrides: Partial<BriefingActionRowDto> = {}
): BriefingActionRowDto {
  return {
    taskId,
    title,
    explanation: `Why ${title} needs attention`,
    category,
    status: "suggested",
    primaryAction:
      category === "needs_reply"
        ? { kind: "reply", cacheMessageId: `opaque-cache-message-${taskId.at(-1)}` }
        : { kind: "view", href: `https://example.test/source/${taskId}` },
    source: category === "needs_action" ? "calendar" : "email",
    sourceLabel: category === "needs_action" ? "Calendar" : "Gmail",
    sourceRef: category === "needs_reply" ? "subject:launch-decision" : `source:${taskId}`,
    sourceHref: category === "needs_reply" ? null : `https://example.test/source/${taskId}`,
    dueAt: "2026-08-01T17:00:00.000Z",
    computedAt: NOW,
    resurfaceReason: null,
    ...overrides
  };
}

function run(
  id: string,
  definitionId: string,
  briefingType: "morning" | "evening",
  summaryText: string,
  rows: readonly BriefingActionRowDto[]
): BriefingRunDto {
  return createMockBriefingRun(id, definitionId, summaryText, {
    briefingType,
    createdAt: NOW,
    structuredPayload: { version: 1, actionRows: rows, catchUp: null }
  });
}

async function reloadToday(page: Page): Promise<void> {
  await page.reload();
  await expect(page.locator(".cmd-wrap")).toBeVisible();
}

test("morning and evening prose and action rows render accept dismiss view reply and stay suppressed", async ({
  page
}) => {
  await page.clock.setFixedTime(new Date(NOW));

  const morningRows = [
    actionRow("task-action-1", "Book the launch room", "needs_action"),
    actionRow("task-info-1", "Review the contract deadline", "time_sensitive_info"),
    actionRow("task-reply-1", "Reply to Alex about launch", "needs_reply")
  ];
  const eveningRows = [
    actionRow("task-evening-action", "Confirm tomorrow's room", "needs_action"),
    actionRow("task-evening-info", "Read tomorrow's weather alert", "time_sensitive_info"),
    actionRow("task-evening-reply", "Reply to the evening handoff", "needs_reply", {
      primaryAction: { kind: "reply", cacheMessageId: "opaque-evening-message" },
      sourceRef: "subject:evening-handoff"
    })
  ];

  const morningDefinition = createMockBriefingDefinition("briefing-morning", "Morning", {
    briefingType: "morning",
    cadence: "daily",
    scheduleMetadata: { targetTime: "07:00", timezone: "UTC" }
  });
  const eveningDefinition = createMockBriefingDefinition("briefing-evening", "Evening", {
    briefingType: "evening",
    cadence: "daily",
    scheduleMetadata: { targetTime: "23:59", timezone: "UTC" }
  });
  const state: MockApiState = {
    authenticated: true,
    onboardingStatus: {
      role: "founder",
      state: "completed",
      steps: {
        cliAuth: {
          done: true,
          providers: [{ kind: "anthropic", cliPresent: true, installState: "ready" }]
        },
        connectors: { done: false }
      }
    },
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: [
      ...morningRows.map((row) => createMockTask(row.taskId, row.title, { status: "suggested" })),
      ...eveningRows.map((row) => createMockTask(row.taskId, row.title, { status: "suggested" }))
    ],
    briefingDefinitions: [morningDefinition, eveningDefinition],
    briefingRuns: {
      [morningDefinition.id]: [
        run("morning-run-1", morningDefinition.id, "morning", MORNING_SUMMARY, morningRows)
      ],
      [eveningDefinition.id]: [
        run("evening-run-1", eveningDefinition.id, "evening", EVENING_SUMMARY, eveningRows)
      ]
    }
  };
  await mockApi(page, state);
  await page
    .context()
    .route("https://example.test/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<title>Source</title>" })
    );

  let releaseMorningRuns: () => void = () => undefined;
  const morningRunsGate = new Promise<void>((resolve) => {
    releaseMorningRuns = resolve;
  });
  await page.route("**/api/briefings/definitions/briefing-morning/runs", async (route) => {
    await morningRunsGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runs: state.briefingRuns?.[morningDefinition.id] ?? [] })
    });
  });

  const chatTurnTexts: string[] = [];
  let releaseReplyStream: () => void = () => undefined;
  const replyTurnReceived = new Promise<void>((resolve) => {
    releaseReplyStream = resolve;
  });
  await page.route("**/api/chat/turn", async (route) => {
    const body = route.request().postDataJSON() as { readonly text: string };
    chatTurnTexts.push(body.text);
    releaseReplyStream();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ reply: "Draft ready for confirmation" })
    });
  });

  let streamServed = false;
  await page.route("**/api/chat/stream*", async (route) => {
    if (streamServed) return;
    await replyTurnReceived;
    streamServed = true;
    const actionRequest = JSON.stringify({
      kind: "action_request",
      text: "Draft reply to Alex?",
      actionRequestId: "draft-reply-action-1",
      toolName: "email.draftReply",
      summary: "Draft reply to Alex?",
      preview: {
        to: "alex@example.test",
        subject: "Re: Launch decision",
        body: "The launch decision is approved."
      }
    });
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
      body: `data: ${actionRequest}\n\n`
    });
  });

  let gmailDraftCalls = 0;
  await page.route("**/api/email/drafts**", async (route) => {
    gmailDraftCalls += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
  });

  await page.goto("/today");
  await expect(page.getByText("Gathering your morning briefing…")).toBeVisible();
  await expect(page.getByText("Checking what needs you…")).toBeVisible();
  releaseMorningRuns();

  const morningProse = page.getByText(MORNING_SUMMARY, { exact: true });
  await expect(morningProse).toBeVisible();
  const startHere = page.getByText("Start here", { exact: true });
  await expect(startHere).toBeVisible();
  expect(
    await morningProse.evaluate(
      (node, startNode) =>
        Boolean(node.compareDocumentPosition(startNode as Node) & Node.DOCUMENT_POSITION_FOLLOWING),
      await startHere.elementHandle()
    )
  ).toBe(true);

  const compactSummary = `${EVENING_SUMMARY.replace(/\s+/g, " ").trim().slice(0, 217).trimEnd()}...`;
  await expect(page.getByText(compactSummary, { exact: true })).toBeVisible();
  await expect(page.getByText(EVENING_SUMMARY, { exact: true })).toHaveCount(0);

  const needsYou = page.locator("section.jds-brief").filter({ hasText: "Needs you" });
  await expect(needsYou.getByText("3 need you", { exact: true })).toBeVisible();
  for (const row of morningRows) {
    await expect(
      needsYou.locator(".loose-row").filter({ hasText: row.title }).locator(".loose-row__title")
    ).toHaveText(row.title);
  }
  await expect(needsYou.getByRole("link", { name: "View" })).toHaveCount(2);

  // A missing/broken stylesheet leaves the .loose-row* classes present but unstyled — assert the
  // computed layout, not just the class attribute, so #1429 (undefined CSS classes) can't recur.
  await expect(needsYou.locator(".loose-row").first()).toHaveCSS("display", "flex");
  await expect(needsYou.locator(".loose-row").nth(1)).toHaveCSS("border-top-width", "1px");

  const actionEntry = needsYou.locator(".loose-row").filter({ hasText: morningRows[0]!.title });
  const [sourcePage] = await Promise.all([
    page.waitForEvent("popup"),
    actionEntry.getByRole("link", { name: "View" }).click()
  ]);
  await expect.poll(() => sourcePage.url()).toBe(morningRows[0]!.sourceHref);
  await sourcePage.close();

  await actionEntry.getByRole("button", { name: "Accept" }).click();
  await expect(actionEntry.getByText("Accepted", { exact: true })).toBeVisible();
  expect(state.tasks.find((task) => task.id === morningRows[0]!.taskId)?.status).toBe("todo");

  const replyEntry = needsYou.locator(".loose-row").filter({ hasText: morningRows[2]!.title });
  await replyEntry.getByRole("button", { name: "Reply", exact: true }).click();
  await expect.poll(() => chatTurnTexts).toEqual([REPLY_PROMPT]);
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer).toBeVisible();
  const confirmation = drawer.getByRole("region", { name: "Action request" });
  await expect(confirmation).toContainText("Draft reply to Alex?");
  await expect(confirmation).toContainText("alex@example.test");
  await expect(confirmation.getByRole("button", { name: "Approve" })).toBeVisible();
  expect(gmailDraftCalls).toBe(0);

  await replyEntry.getByRole("button", { name: "Dismiss" }).click();
  await expect(replyEntry.getByText("Dismissed", { exact: true })).toBeVisible();

  const secondReply = actionRow(
    "task-reply-2",
    "Reply to Alex's independent follow-up",
    "needs_reply",
    { primaryAction: { kind: "reply", cacheMessageId: "opaque-cache-message-2" } }
  );
  state.tasks = [
    ...state.tasks,
    createMockTask(secondReply.taskId, secondReply.title, { status: "suggested" })
  ];
  state.briefingRuns![morningDefinition.id] = [
    run("morning-run-2", morningDefinition.id, "morning", MORNING_SUMMARY, [
      morningRows[0]!,
      morningRows[1]!,
      secondReply
    ])
  ];
  await reloadToday(page);
  const secondReplyEntry = page.locator(".loose-row").filter({ hasText: secondReply.title });
  await secondReplyEntry.getByRole("button", { name: "Dismiss" }).click();
  await expect(secondReplyEntry.getByText("Dismissed", { exact: true })).toBeVisible();

  state.briefingRuns![morningDefinition.id] = [
    run("morning-run-suppressed", morningDefinition.id, "morning", MORNING_SUMMARY, [
      morningRows[0]!,
      morningRows[1]!
    ])
  ];
  await reloadToday(page);
  await expect(
    page
      .locator(".loose-row")
      .filter({ hasText: morningRows[2]!.title })
      .locator(".loose-row__title")
  ).toHaveCount(0);
  await expect(
    page.locator(".loose-row").filter({ hasText: secondReply.title }).locator(".loose-row__title")
  ).toHaveCount(0);

  const resurfacedReply = actionRow(
    "task-reply-3",
    "Reply to Alex after the newer message",
    "needs_reply",
    {
      primaryAction: { kind: "reply", cacheMessageId: "opaque-cache-message-3" },
      resurfaceReason: "relevant_context"
    }
  );
  state.tasks = [
    ...state.tasks,
    createMockTask(resurfacedReply.taskId, resurfacedReply.title, { status: "suggested" })
  ];
  state.briefingRuns![morningDefinition.id] = [
    run("morning-run-resurfaced", morningDefinition.id, "morning", MORNING_SUMMARY, [
      morningRows[0]!,
      morningRows[1]!,
      resurfacedReply
    ])
  ];
  await reloadToday(page);
  await expect(
    page
      .locator(".loose-row")
      .filter({ hasText: resurfacedReply.title })
      .locator(".loose-row__title")
  ).toBeVisible();

  state.briefingRuns![morningDefinition.id] = [
    run("morning-run-empty", morningDefinition.id, "morning", "", [])
  ];
  await reloadToday(page);
  await expect(page.getByText("Your morning briefing is not ready yet.")).toBeVisible();
  await expect(page.getByText("You're caught up — nothing is waiting on you.")).toBeVisible();

  const staleRow = actionRow("task-stale", "Review the stale connector result", "needs_action", {
    computedAt: "2026-07-28T12:00:00.000Z"
  });
  state.tasks = [
    ...state.tasks,
    createMockTask(staleRow.taskId, staleRow.title, { status: "suggested" })
  ];
  state.briefingRuns![morningDefinition.id] = [
    run("morning-run-stale", morningDefinition.id, "morning", MORNING_SUMMARY, [staleRow])
  ];
  await reloadToday(page);
  await expect(page.getByText("Some sources are over a day old: Calendar.")).toBeVisible();

  state.briefingDefinitions = [
    morningDefinition,
    { ...eveningDefinition, scheduleMetadata: { targetTime: "00:00", timezone: "UTC" } }
  ];
  await reloadToday(page);
  await expect(page.getByText(EVENING_SUMMARY, { exact: true })).toBeVisible();
  await expect(page.getByText(compactSummary, { exact: true })).toHaveCount(0);
  const eveningNeedsYou = page.locator("section.jds-brief").filter({ hasText: "Needs you" });
  await expect(eveningNeedsYou.getByText("3 need you", { exact: true })).toBeVisible();
  for (const row of eveningRows) {
    await expect(
      eveningNeedsYou
        .locator(".loose-row")
        .filter({ hasText: row.title })
        .locator(".loose-row__title")
    ).toBeVisible();
  }
});

import { expect, test, type Page } from "@playwright/test";
import { localDay, type ChatMessageDto, type TaskDto, type VisualReplyV1 } from "@moss/shared";
import {
  bringUpRealChatProvider,
  discoverCheapestChatModel,
  requireUatBaseURL,
  requireUatProjectName
} from "./real-chat-signin.js";
import { installUatRealChatAuth } from "../real-chat-env.js";
import { buildUatComposeArgs } from "../compose-args.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import {
  readTaskSummarySnapshot,
  taskDueState
} from "../../../packages/tasks/src/summary/contract.js";

export const uatLevel = { level: "bare", without: [] } as const;
test.use({ trace: "off", screenshot: "off", video: "off" });
test.beforeEach(async ({ page }) => {
  page.on("requestfailed", (request) => {
    const path = new URL(request.url()).pathname;
    if (["/api/chat/turn", "/api/chat/stream"].includes(path))
      console.log(
        `[tasks-network-failure] ${JSON.stringify({
          time: new Date().toISOString(),
          path,
          method: request.method(),
          error: request.failure()?.errorText.slice(0, 512)
        })}`
      );
  });
});
// Frozen before installed acceptance. No visual instructions or retries in this matrix.
const prompts = [
  "What needs doing today?",
  "Catch me up on my tasks for today.",
  "Which tasks need attention today?",
  "What's overdue on my task list?",
  "Help me see my open work for today.",
  "What tasks are waiting without a due date?",
  "Which of my tasks are coming up after today?",
  "What have I completed?",
  "Give me an overview of my tasks and their current states.",
  "What should I tackle from my tasks today?",
  "Which tasks are past their due date?",
  "Show me my undated work.",
  "What's still on my plate for today?",
  "Catch me up on upcoming tasks.",
  "Which tasks have I already finished?",
  "How is today's task list looking?",
  "Help me prioritize the tasks that need doing today.",
  "What open tasks have slipped past their due dates?",
  "Summarize the work I still need to do today.",
  "What's the current state of all my tasks?"
];
async function drawer(page: Page) {
  const chat = page.getByRole("dialog", { name: "Chat with Moss" });
  if (!(await chat.isVisible())) await page.getByRole("button", { name: "Chat with Moss" }).click();
  await expect(chat.getByLabel("Message Moss")).toBeVisible();
  return chat;
}
async function turn(page: Page, prompt: string) {
  const chat = await drawer(page);
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/chat/turn" && r.request().method() === "POST",
    { timeout: 180_000 }
  );
  await chat.getByLabel("Message Moss").fill(prompt);
  const started = Date.now();
  await chat.getByLabel("Message Moss").press("Enter");
  try {
    const saved = await response;
    expect(saved.ok()).toBe(true);
    return { saved: await saved.json(), elapsedMs: Date.now() - started };
  } catch (error) {
    // Diagnostic only: history cannot substitute for the required successful POST response.
    try {
      const privacy = await (
        await page.request.get("/api/chat/privacy?surface=drawer", { timeout: 10_000 })
      ).json();
      const history: { messages: ChatMessageDto[] } = await (
        await page.request.get(`/api/chat/threads/${privacy.threadId}/messages?surface=drawer`, {
          timeout: 10_000
        })
      ).json();
      console.log(
        `[tasks-failed-turn-history] ${JSON.stringify({
          prompt,
          elapsedMs: Date.now() - started,
          messages: history.messages.slice(-4).map((message) => ({
            id: message.id,
            role: message.role,
            body: message.body,
            visualReply: message.visualReply,
            activity: message.activity
              .filter((entry) => entry.kind === "tool")
              .map((entry) => ({ toolName: entry.toolName, outcome: entry.outcome }))
          }))
        })}`
      );
    } catch {
      console.log("[tasks-failed-turn-history] unavailable; original failure retained");
    }
    throw error;
  }
}
async function captureTask(page: Page, title: string, due: string | null, done = false) {
  const capture = page.getByRole("textbox", { name: "Task title", exact: true });
  await capture.fill(title);
  const created = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/tasks" && r.request().method() === "POST"
  );
  await capture.press("Enter");
  expect((await created).status()).toBe(201);
  await page
    .getByRole("button", { name: `Open ${title}`, exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Task details" });
  if (due) await dialog.getByLabel("Due date", { exact: true }).fill(due);
  await dialog.getByLabel("Priority", { exact: true }).selectOption({ label: "High" });
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toHaveCount(0);
  if (done) {
    const completed = page.waitForResponse(
      (r) =>
        /\/api\/tasks\/[^/]+$/.test(new URL(r.url()).pathname) && r.request().method() === "PATCH"
    );
    await page
      .locator("label.jds-check")
      .filter({ has: page.getByRole("checkbox", { name: `Complete ${title}`, exact: true }) })
      .first()
      .click();
    expect((await completed).ok()).toBe(true);
  }
}

test("real Tasks questions keep source identity, due state and immutable read-only cards (#3659)", async ({
  page
}) => {
  test.setTimeout(2_400_000);
  expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("1");
  await page.goto(requireUatBaseURL());
  await page.getByLabel("Name", { exact: true }).fill("Task Summary Owner");
  await page.getByLabel("Email", { exact: true }).fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Create account" }).click();
  await page.getByRole("button", { name: "Skip setup" }).click();
  await page.getByRole("button", { name: "Skip anyway" }).click();
  await expect(page.getByRole("button", { name: /^Account menu(?:,|$)/ })).toBeVisible();
  const { user } = await (await page.request.get("/api/me")).json();
  const project = requireUatProjectName();
  const signupAuth = installUatRealChatAuth(project, user.id, (args) =>
    buildUatComposeArgs(project, args)
  );
  expect(signupAuth).toBeDefined();
  try {
    await bringUpRealChatProvider(page);
    const model = await discoverCheapestChatModel(page);
    // Actual Settings lock on Your assistant, using the discovered economy route for this newly
    // signed-up owner.
    await page.goto("/settings?section=assistant");
    const lock = page.getByLabel("Locked chat model", { exact: true });
    await expect(lock).toBeEnabled();
    await lock.selectOption(model.id);
    await expect(lock).toHaveValue(model.id);
    await expect
      .poll(async () => {
        const route = await (await page.request.get("/api/ai/capability-route/chat")).json();
        return route.route.model.id;
      })
      .toBe(model.id);
    const locale = await (await page.request.get("/api/me/locale")).json();
    const zone: string = locale.locale.timezone;
    expect(zone).toBe("America/Los_Angeles");
    await page.goto("/settings?section=profile");
    const locationSearch = page.getByLabel("Search for a weather location");
    await expect(locationSearch).toBeEnabled();
    await locationSearch.fill("San Diego");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(
      page.getByText("San Diego, California, United States", { exact: true })
    ).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Use this place" }).first().click();
    await expect(
      page.getByText("Weather location saved: San Diego, California, United States.")
    ).toBeVisible();
    const today = localDay(new Date(), zone);
    const shift = (n: number) =>
      new Date(Date.parse(`${today}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    await page.goto("/tasks");
    await captureTask(page, "Draft the proposal outline", today);
    await captureTask(page, "Send workshop notes", shift(-1));
    await captureTask(page, "Prepare garden supplies", shift(2));
    await captureTask(page, "Sort the reference notebook", null);
    await captureTask(page, "Review the finished checklist", today, true);
    const sourceResponse = await page.request.get("/api/tasks");
    expect(sourceResponse.ok()).toBe(true);
    const source: TaskDto[] = (await sourceResponse.json()).tasks;
    expect(source).toHaveLength(5);
    console.log(
      `[tasks-source] ${JSON.stringify({ model: model.providerModelId, zone, today, source })}`
    );
    const results: {
      index: number;
      prompt: string;
      reply: string;
      visual: boolean;
      useful: boolean;
      elapsedMs: number;
      promptBytes: number;
      replyBytes: number;
      visualBytes: number;
      assistantMessageId: string;
    }[] = [];
    let firstEnvelope: VisualReplyV1 | undefined;
    for (const [index, prompt] of prompts.entries()) {
      const { saved, elapsedMs } = await turn(page, prompt);
      const envelope: VisualReplyV1 | undefined = saved.visualReply;
      const visual = envelope?.blocks[0]?.kind === "tasks.summary";
      const useful =
        typeof saved.reply === "string" &&
        saved.reply.trim().length >= 40 &&
        /task|proposal|workshop|garden|notebook|checklist|overdue|completed|undated|due/i.test(
          saved.reply
        );
      results.push({
        index: index + 1,
        prompt,
        reply: saved.reply,
        visual,
        useful,
        elapsedMs,
        promptBytes: Buffer.byteLength(prompt),
        replyBytes: Buffer.byteLength(saved.reply),
        visualBytes: Buffer.byteLength(JSON.stringify(envelope ?? null)),
        assistantMessageId: saved.assistantMessageId
      });
      // Full, untruncated answers are retained for manual semantic review, separately from fallback.
      console.log(`[tasks-answer] ${JSON.stringify(results.at(-1))}`);
      if (!visual) continue;
      const summary = readTaskSummarySnapshot(envelope!.snapshots[0]);
      expect.soft(summary).not.toBeNull();
      if (!summary) continue;
      expect.soft(summary.timeZone).toBe(zone);
      expect.soft(summary.localDate).toBe(today);
      expect.soft(summary.truncated).toBe(false);
      console.log(`[tasks-snapshot] ${JSON.stringify({ index: index + 1, summary })}`);
      const scopeRows = source.filter(
        (item) =>
          summary.scope === "all" ||
          (summary.scope === "completed"
            ? item.status === "done"
            : item.status === "todo" &&
              (summary.scope === "today"
                ? taskDueState(item.status, item.dueAt, today, zone) !== "upcoming"
                : taskDueState(item.status, item.dueAt, today, zone) === summary.scope))
      );
      expect.soft(summary.items.map((t) => t.id).sort()).toEqual(scopeRows.map((t) => t.id).sort());
      for (const item of summary.items) {
        const actual = source.find((t) => t.id === item.id)!;
        expect.soft(item).toMatchObject({
          title: actual.title,
          status: actual.status,
          priority: actual.priority,
          dueAt: actual.dueAt,
          completedAt: actual.completedAt,
          updatedAt: actual.updatedAt,
          recurring: false,
          dueState: taskDueState(actual.status, actual.dueAt, today, zone)
        });
      }
      const slot = (await drawer(page)).getByLabel("Visual reply").last();
      await expect(slot.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
      await expect(slot.getByLabel("Task summary").locator("li")).toHaveCount(summary.items.length);
      await expect(slot.getByText(/Source retrieved/)).toContainText(summary.retrievedAt);
      expect(await slot.locator(".tasks-summary").locator("button,input,a").count()).toBe(0);
      if (!firstEnvelope) {
        firstEnvelope = envelope;
        for (const theme of ["forest", "sage", "canyon", "teal", "dusk"])
          for (const mode of ["light", "dark"]) {
            await page.evaluate(
              ({ theme, mode }) => {
                document.documentElement.dataset.theme = theme;
                document.documentElement.dataset.colorMode = mode;
              },
              { theme, mode }
            );
            await page.setViewportSize({ width: 390, height: 844 });
            expect(await slot.evaluate((n) => n.scrollWidth <= n.clientWidth)).toBe(true);
            const bounds = await slot.boundingBox();
            expect(bounds!.x).toBeGreaterThanOrEqual(0);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
          }
        await page.setViewportSize({ width: 1280, height: 900 });
        const privacy = await (await page.request.get("/api/chat/privacy?surface=drawer")).json();
        await page.reload();
        await drawer(page);
        const history = await (
          await page.request.get(`/api/chat/threads/${privacy.threadId}/messages?surface=drawer`)
        ).json();
        expect(
          history.messages.find((m: ChatMessageDto) => m.id === saved.assistantMessageId)
            .visualReply
        ).toEqual(envelope);
        console.log(
          "[tasks-lifecycle] immutable reload, drawer/390px and all ten named theme/mode combinations passed"
        );
      }
    }
    console.log(`[tasks-gate] ${JSON.stringify({ model: model.providerModelId, results })}`);
    const privacy = await (await page.request.get("/api/chat/privacy?surface=drawer")).json();
    const history: { messages: ChatMessageDto[] } = await (
      await page.request.get(`/api/chat/threads/${privacy.threadId}/messages?surface=drawer`)
    ).json();
    console.log(
      `[tasks-usage] ${JSON.stringify(
        results.map((r) => ({
          index: r.index,
          usage: history.messages.find((m) => m.id === r.assistantMessageId)?.usage ?? null,
          activity: history.messages
            .find((m) => m.id === r.assistantMessageId)
            ?.activity.filter((e) => e.kind === "tool")
            .map((e) => ({ toolName: e.toolName, outcome: e.outcome }))
        }))
      )}`
    );
    expect.soft(results.filter((r) => r.visual).length).toBeGreaterThanOrEqual(19);
    expect.soft(results.every((r) => r.useful)).toBe(true);
    for (const prompt of [
      "Text only: what needs doing today?",
      "No visual. Tell me my overdue work in one sentence.",
      "Reply in plain text only: what is two plus two?",
      "Say hello in one short sentence."
    ]) {
      const { saved } = await turn(page, prompt);
      expect(saved.visualReply).toBeUndefined();
      expect(saved.reply.trim()).not.toBe("");
      console.log(`[tasks-prose-control] ${JSON.stringify({ prompt, reply: saved.reply })}`);
    }
    const composed = await turn(
      page,
      'Arrange these pottery workshop facts into two useful titled visual sections, keeping a short answer too.\n```json\n{"material":"Clay","hours":6,"ready":true}\n```'
    );
    console.log(`[tasks-preservation-composition] ${JSON.stringify(composed.saved)}`);
    expect(composed.saved.visualReply?.blocks[0]?.kind).toBe("composition");
    const sportsFollow = await page.request.post("/api/sports/follows", {
      data: { competitionKey: "eng.1", teamKey: "liv" }
    });
    expect(sportsFollow.ok()).toBe(true);
    const sports = await turn(page, "How did Liverpool do in their last match?");
    console.log(`[tasks-preservation-sports] ${JSON.stringify(sports.saved)}`);
    expect.soft(sports.saved.visualReply?.blocks[0]?.kind).toBe("sports.result");
    const weather = await turn(page, "Will I need a jacket tonight?");
    console.log(`[tasks-preservation-weather] ${JSON.stringify(weather.saved)}`);
    expect(weather.saved.visualReply?.blocks[0]?.kind).toBe("weather.forecast");
    console.log(
      `[tasks-preservation] ${JSON.stringify({ composed: composed.saved, sports: sports.saved, weather: weather.saved })}`
    );
    expect((await (await page.request.get("/api/tasks")).json()).tasks).toEqual(source);
  } finally {
    await signupAuth?.cleanup();
  }
});

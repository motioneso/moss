import { expect, test, type Page, type Locator } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { buildUatComposeArgs } from "../provisioner.js";
import { parseVisualProgram, type VisualReplyV1 } from "@moss/shared";
import { bringUpRealChatModel, signInUatAdmin, requireUatProjectName } from "./real-chat-signin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;

test.beforeEach(async ({ page }) => {
  page.on("console", (message) => {
    if (message.type() === "error")
      console.log(`[visual-browser-error] ${message.text().slice(0, 1500)}`);
  });
  page.on("pageerror", (error) => console.log(`[visual-page-error] ${error.message}`));
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).pathname.startsWith("/assets/"))
      console.log(
        `[visual-asset-failure] ${new URL(request.url()).pathname} ${request.failure()?.errorText}`
      );
  });
});

const visualCases = [
  ["Show a visual summary of my project", { project: "Garden", hours: 6, ready: true }],
  ["Arrange my packing facts visually", { bag: "Daypack", kilograms: 4, checked: false }],
  ["Make two titled visual sections for my workshop", { material: "Pine", boards: 3, tool: "Saw" }],
  ["Use a compact visual for my study notes", { subject: "Botany", pages: 18, complete: false }],
  ["Group my recipe facts in a visual", { dish: "Soup", servings: 4, minutes: 25 }],
  [
    "Show my reading facts as titled sections",
    { book: "My notebook", chapters: 7, finished: true }
  ],
  ["Present a visual of this budget", { category: "Seeds", dollars: 24, approved: true }],
  ["Visualize my practice session", { instrument: "Piano", minutes: 30, focus: "Scales" }],
  ["Make a visual for this walk", { route: "Park loop", kilometers: 2, planned: true }],
  ["Show a visual of these shipment facts", { parcel: "Books", items: 5, arrived: false }],
  ["Put my meeting preparation in visual sections", { topic: "Club", people: 8, room: "Library" }],
  ["Arrange my sewing facts visually", { fabric: "Cotton", meters: 2, color: "Blue" }],
  ["Use a visual summary for this experiment", { trial: "A", temperature: 21, passed: true }],
  [
    "Show two visual sections for my photo session",
    { location: "Studio", frames: 36, light: "Window" }
  ],
  [
    "Show my zero and unknown values accurately in a visual",
    { remaining: 0, confirmed: false, estimate: null }
  ],
  [
    "Make a new titled visual arrangement from these game facts",
    { game: "Chess", players: 2, timed: true }
  ],
  ["Arrange my supplies into a novel visual", { pencils: 3, paper: "A4", available: true }],
  ["Visualize these timing facts", { phase: "Warmup", seconds: 90, done: false }],
  ["Compose titled visual sections for my garden", { bed: "North", plants: 12, watered: true }],
  ["Use a visual for these dimensions", { width: 12, height: 8, unit: "cm" }]
] as const;

async function drawer(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Chat with Moss" });
  if (!(await dialog.isVisible()))
    await page.getByRole("button", { name: "Chat with Moss" }).click();
  await expect(dialog.getByLabel("Message Moss")).toBeVisible();
  return dialog;
}

function savedVisualSlot(chat: Locator, envelope: VisualReplyV1) {
  const section = parseVisualProgram(envelope.blocks[0]!.program!)![0]!;
  const fact = section.facts[0]!;
  const value = envelope.snapshots.find((snapshot) => snapshot.ref === fact.ref)!.fields[
    fact.field
  ];
  return chat.getByLabel("Visual reply").filter({
    has: chat.page().getByRole("heading", { name: section.title, exact: true }),
    hasText: `${fact.field}: ${value === null ? "Unknown" : String(value)}`
  });
}

test("real prompt to saved visual, reload, reconnect, copy and route evaluation (#3600)", async ({
  page,
  context
}) => {
  test.setTimeout(2_400_000);
  expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("1");
  await signInUatAdmin(page);
  const model = await bringUpRealChatModel(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const devtoolsRequests: string[] = [];
  page.on("request", (request) => {
    if (/devtools/i.test(request.url())) devtoolsRequests.push(new URL(request.url()).pathname);
  });
  const results: {
    index: number;
    intendedVisual: boolean;
    visual: boolean;
    useful: boolean;
    elapsedMs: number;
    usage?: unknown;
    programBytes?: number;
    fallbackBytes?: number;
  }[] = [];
  const cases = [
    ...visualCases.map(([request, fields]) => ({
      text: `${request}. Keep a useful prose answer too.\n\n\`\`\`json\n${JSON.stringify(fields)}\n\`\`\``,
      visual: true
    })),
    { text: "Reply in plain text only: what is two plus two?", visual: false },
    { text: "No visual, just one sentence: good morning.", visual: false },
    { text: "Say hello in one short sentence.", visual: false },
    { text: 'Text only. Summarize my data: {"hours":6}.', visual: false }
  ];
  let firstSaved:
    | { assistantMessageId: string; reply: string; visualReply: { fallbackText: string } }
    | undefined;
  for (const [index, input] of cases.entries()) {
    const chat = await drawer(page);
    const completed = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/chat/turn" && r.request().method() === "POST",
      { timeout: 180_000 }
    );
    await chat.getByLabel("Message Moss").fill(input.text);
    const started = Date.now();
    await chat.getByLabel("Message Moss").press("Enter");
    const response = await completed;
    expect(response.ok(), `turn ${index + 1}: HTTP ${response.status()}`).toBe(true);
    const saved = await response.json();
    const visual = Boolean(saved.visualReply);
    if (visual) {
      const envelope: VisualReplyV1 = saved.visualReply;
      const slot = savedVisualSlot(chat, envelope);
      await expect(slot.getByText("Your data", { exact: true })).toBeVisible();
      await expect(slot.getByText("Visual unavailable", { exact: true })).toHaveCount(0);
      for (const section of parseVisualProgram(envelope.blocks[0]!.program!)!) {
        await expect(slot.getByRole("heading", { name: section.title, exact: true })).toBeVisible();
        for (const fact of section.facts) {
          const value = envelope.snapshots.find((snapshot) => snapshot.ref === fact.ref)!.fields[
            fact.field
          ];
          await expect(
            slot.getByText(`${fact.field}: ${value === null ? "Unknown" : String(value)}`, {
              exact: true
            })
          ).toBeVisible();
        }
      }
    }
    const privacy = await (await page.request.get("/api/chat/privacy?surface=drawer")).json();
    const history = await (
      await page.request.get(`/api/chat/threads/${privacy.threadId}/messages?surface=drawer`)
    ).json();
    const useful =
      typeof saved.reply === "string" &&
      saved.reply.trim().length > 0 &&
      !saved.reply.includes("root = Reply");
    results.push({
      index: index + 1,
      intendedVisual: input.visual,
      visual,
      useful,
      usage: history.messages.find((m: { id: string }) => m.id === saved.assistantMessageId)?.usage,
      programBytes: visual ? Buffer.byteLength(saved.visualReply.blocks[0].program) : undefined,
      fallbackBytes: visual ? Buffer.byteLength(saved.visualReply.fallbackText) : undefined,
      elapsedMs: Date.now() - started
    });
    console.log(`[visual-route] ${JSON.stringify({ ...results.at(-1), model: model.id })}`);
    if (visual && !firstSaved) {
      firstSaved = saved;
      const slot = savedVisualSlot(chat, saved.visualReply);
      await expect(slot.getByText("Your data", { exact: true })).toBeVisible();
      await expect(slot.getByText("Not independently verified", { exact: true })).toBeVisible();
      await expect(slot.getByText("Visual unavailable", { exact: true })).toHaveCount(0);
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await slot.getByRole("button", { name: "Copy reply", exact: true }).click();
      await expect(slot.getByRole("status")).toHaveText("Reply copied");
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toContain(saved.reply);
      expect(copied).toContain(saved.visualReply.fallbackText);
      expect(copied).not.toContain("root =");
      await page.setViewportSize({ width: 390, height: 844 });
      const bounds = await slot.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.reload();
      await drawer(page);
      await expect(
        savedVisualSlot(await drawer(page), saved.visualReply).getByText("Your data", {
          exact: true
        })
      ).toBeVisible();
      console.log(
        "[visual-lifecycle] saved identity, exact render, copy and reload assertions passed"
      );
    }
  }
  console.log(`[visual-gate] ${JSON.stringify({ model: model.id, results })}`);
  await test.info().attach("visual-route-results", {
    body: JSON.stringify({ model, results }, null, 2),
    contentType: "application/json"
  });
  expect(firstSaved, "at least one real saved visual must render").toBeDefined();
  expect(
    results.filter((result) => result.intendedVisual && result.visual).length
  ).toBeGreaterThanOrEqual(19);
  expect(results.filter((result) => !result.intendedVisual).every((result) => !result.visual)).toBe(
    true
  );
  expect(results.every((result) => result.useful)).toBe(true);
  expect(pageErrors).toEqual([]);
  expect(devtoolsRequests).toEqual([]);
});

test("a real completion missed while offline hydrates after reconnect", async ({
  page,
  context
}) => {
  test.setTimeout(240_000);
  await signInUatAdmin(page);
  const chat = await drawer(page);
  const privacy = await (await page.request.get("/api/chat/privacy?surface=drawer")).json();
  const initialHistory = await (
    await page.request.get(`/api/chat/threads/${privacy.threadId}/messages?surface=drawer`)
  ).json();
  const before = initialHistory.messages.filter(
    (message: { visualReply?: unknown }) => message.visualReply
  ).length;
  await expect(chat.getByLabel("Visual reply")).toHaveCount(before);
  const dropped: string[] = [];
  page.on("requestfailed", (request) => {
    const path = new URL(request.url()).pathname;
    if (["/api/chat/turn", "/api/chat/stream"].includes(path)) dropped.push(path);
  });
  await chat
    .getByLabel("Message Moss")
    .fill(
      'First call chat.present to show all my data visually, then write 1000 words about workshop organization.\n```json\n{"project":"Offline workshop","hours":7,"ready":false}\n```'
    );
  await chat.getByLabel("Message Moss").press("Enter");
  await expect(chat.getByText("Preparing visual…", { exact: true })).toBeVisible({
    timeout: 90_000
  });
  await context.setOffline(true);
  const network = await context.newCDPSession(page);
  await network.send("Page.stopLoading");
  await expect
    .poll(() => dropped.includes("/api/chat/turn") && dropped.includes("/api/chat/stream"))
    .toBe(true);
  let saved: { id: string; visualReply: VisualReplyV1 } | undefined;
  await expect
    .poll(
      async () => {
        const history = await (
          await page.request.get(`/api/chat/threads/${privacy.threadId}/messages?surface=drawer`)
        ).json();
        saved = history.messages.find((message: { visualReply?: VisualReplyV1 }) =>
          message.visualReply?.snapshots.some(
            (snapshot) => snapshot.fields.project === "Offline workshop"
          )
        );
        return Boolean(saved);
      },
      { timeout: 150_000, intervals: [1000, 2000, 4000] }
    )
    .toBe(true);
  await expect(chat.getByLabel("Visual reply")).toHaveCount(before);
  await context.setOffline(false);
  await expect(chat.getByLabel("Visual reply")).toHaveCount(before + 1, { timeout: 45_000 });
  const slot = chat.getByLabel("Visual reply").last();
  await expect(slot.getByText("Your data", { exact: true })).toBeVisible();
  await expect(slot.getByText("Visual unavailable", { exact: true })).toHaveCount(0);
  await expect(chat.getByText("Preparing visual…", { exact: true })).toHaveCount(0);
  console.log(
    `[visual-lifecycle] missed HTTP/SSE completion recovered from saved history ${saved!.id}`
  );
});

test("real accepted proposal clears on Stop, thread switch and engine failure; private data is deleted", async ({
  page
}) => {
  test.setTimeout(600_000);
  await signInUatAdmin(page);
  await bringUpRealChatModel(page);
  let chat = await drawer(page);
  const prompt =
    'First call chat.present to show all these facts visually. After the tool succeeds, write a detailed 2000-word explanation of organizing a workshop.\n```json\n{"project":"Workshop","hours":6,"ready":true}\n```';
  const start = async () => {
    const completed = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/chat/turn" && r.request().method() === "POST",
      { timeout: 180_000 }
    );
    await chat.getByLabel("Message Moss").fill(prompt);
    await chat.getByLabel("Message Moss").press("Enter");
    await expect(chat.getByText("Preparing visual…", { exact: true })).toBeVisible({
      timeout: 90_000
    });
    return { completed };
  };
  const before = await chat.getByLabel("Visual reply").count();
  const stopped = await start();
  await chat.getByRole("button", { name: "Stop generating", exact: true }).click();
  const stopResponse = await stopped.completed;
  expect((await stopResponse.json()).visualReply).toBeUndefined();
  await expect(chat.getByText("Preparing visual…", { exact: true })).toHaveCount(0);
  await expect(chat.getByLabel("Visual reply")).toHaveCount(before);
  console.log(
    "[visual-lifecycle] Stop after accepted proposal removed pending visual and published none"
  );

  const switched = await start();
  await chat.getByRole("button", { name: "Open conversations" }).click();
  await chat.getByRole("button", { name: "New side chat", exact: true }).click();
  await switched.completed;
  await expect(chat.getByLabel("Visual reply")).toHaveCount(0);
  await expect(chat.getByText("Preparing visual…", { exact: true })).toHaveCount(0);
  console.log("[visual-lifecycle] switching to a side chat discarded the old pending visual");

  // The fault-injection scenario is independent of the new side chat's first model turn.
  // The preceding attempt after a switch listed tools but returned prose without a call.
  await chat.getByRole("button", { name: "Open conversations" }).click();
  await chat.getByRole("button", { name: "Main chat", exact: true }).click();
  const threads = await (await page.request.get("/api/chat/threads?surface=drawer")).json();
  const main = threads.threads.find((thread: { isMain: boolean }) => thread.isMain);
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/chat/privacy?surface=drawer")).json()).threadId
    )
    .toBe(main.id);
  const mainHistory = await (
    await page.request.get(`/api/chat/threads/${main.id}/messages?surface=drawer`)
  ).json();
  const baselineVisuals = mainHistory.messages.filter(
    (message: { visualReply?: unknown }) => message.visualReply
  ).length;
  await expect(chat.getByLabel("Visual reply")).toHaveCount(baselineVisuals);
  const failed = await start();
  // Fault the real third-party CLI process in this disposable container. Moss responses are unmodified.
  const killCli = `import { readdirSync, readFileSync } from "node:fs";
    let killed = 0;
    for (const pid of readdirSync("/proc").filter((p) => /^\\d+$/.test(p))) {
      try {
        const args = readFileSync("/proc/"+pid+"/cmdline", "utf8").split("\\0");
        if (args[0] === "codex" || args[0]?.endsWith("/codex") || args[1]?.endsWith("/codex.js")) {
          process.kill(Number(pid), "SIGKILL"); killed++;
        }
      } catch {}
    }
    console.log(killed);`;
  const killed = execFileSync(
    "docker",
    buildUatComposeArgs(requireUatProjectName(), [
      "exec",
      "-T",
      "jarv1s",
      "node",
      "--input-type=module",
      "-e",
      killCli
    ]),
    { encoding: "utf8" }
  ).trim();
  expect(Number(killed)).toBeGreaterThan(0);
  const failure = await failed.completed;
  const failedReply = await failure.json();
  console.log(
    `[visual-engine-failure] ${JSON.stringify({ status: failure.status(), saved: Boolean(failedReply.assistantMessageId), visual: Boolean(failedReply.visualReply), reply: failedReply.reply?.slice(0, 200) })}`
  );
  expect(failedReply.visualReply).toBeUndefined();
  expect(failedReply.assistantMessageId).toBeUndefined();
  await expect(chat.getByText("Preparing visual…", { exact: true })).toHaveCount(0);
  await expect(chat.getByLabel("Visual reply")).toHaveCount(baselineVisuals);
  console.log(
    "[visual-lifecycle] real CLI failure removed accepted visual; no response interception"
  );

  await chat.getByRole("button", { name: "More chat options" }).click();
  await chat.getByRole("menuitemcheckbox", { name: "Start private chat" }).click();
  await expect(
    chat.getByText("Private chat: not saved to history. Approved actions still keep records.", {
      exact: true
    })
  ).toBeVisible();
  const privacy = await (await page.request.get("/api/chat/privacy?surface=drawer")).json();
  const completed = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/chat/turn" && r.request().method() === "POST",
    { timeout: 180_000 }
  );
  await chat
    .getByLabel("Message Moss")
    .fill('Make a visual from my private data: {"hours":6}. Keep a useful text answer.');
  await chat.getByLabel("Message Moss").press("Enter");
  const privateResponse = await completed;
  expect(privateResponse.ok()).toBe(true);
  const privateReply = await privateResponse.json();
  expect(privateReply.reply.trim().length).toBeGreaterThan(0);
  expect(privateReply.visualReply).toBeUndefined();
  expect(privateReply.assistantMessageId).toBeUndefined();
  await expect(chat.getByLabel("Visual reply")).toHaveCount(0);
  await chat.getByRole("button", { name: "End", exact: true }).click();
  await expect
    .poll(async () =>
      (
        await page.request.get(`/api/chat/threads/${privacy.threadId}/messages?surface=drawer`)
      ).status()
    )
    .toBe(404);
  await page.reload();
  chat = await drawer(page);
  expect(
    (
      await page.request.get(`/api/chat/threads/${privacy.threadId}/messages?surface=drawer`)
    ).status()
  ).toBe(404);
  console.log(
    "[visual-lifecycle] private reply remained prose/unsaved, and reload deleted its thread"
  );
});

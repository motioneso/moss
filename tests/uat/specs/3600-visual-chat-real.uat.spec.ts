import { expect, test, type Page } from "@playwright/test";
import { bringUpRealChatModel, signInUatAdmin } from "./real-chat-signin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;

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
  ]
] as const;

async function drawer(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Chat with Moss" });
  if (!(await dialog.isVisible()))
    await page.getByRole("button", { name: "Chat with Moss" }).click();
  await expect(dialog.getByLabel("Message Moss")).toBeVisible();
  return dialog;
}

test("real prompt to saved visual, reload, reconnect, copy and route evaluation (#3600)", async ({
  page,
  context
}) => {
  test.setTimeout(2_400_000);
  expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("1");
  await signInUatAdmin(page);
  const model = await bringUpRealChatModel(page);
  const results: {
    index: number;
    intendedVisual: boolean;
    visual: boolean;
    useful: boolean;
    elapsedMs: number;
  }[] = [];
  const cases = [
    ...visualCases.map(([request, fields]) => ({
      text: `${request}. Use chat.present with the registered data, and keep a useful prose answer.\n\n\`\`\`json\n${JSON.stringify(fields)}\n\`\`\``,
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
    const useful =
      typeof saved.reply === "string" &&
      saved.reply.trim().length > 0 &&
      !saved.reply.includes("root = Reply");
    results.push({
      index: index + 1,
      intendedVisual: input.visual,
      visual,
      useful,
      elapsedMs: Date.now() - started
    });
    console.log(`[visual-route] ${JSON.stringify({ ...results.at(-1), model: model.id })}`);
    if (visual && !firstSaved) {
      firstSaved = saved;
      const slot = chat.getByLabel("Visual reply").last();
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
      await page.reload();
      await drawer(page);
      await expect(
        page.getByLabel("Visual reply").last().getByText("Your data", { exact: true })
      ).toBeVisible();
      await context.setOffline(true);
      await context.setOffline(false);
      await expect(
        page.getByLabel("Visual reply").last().getByText("Your data", { exact: true })
      ).toBeVisible();
      console.log(
        "[visual-lifecycle] saved identity, render, copy, reload, reconnect assertions passed"
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
    results.filter((result) => result.visual === result.intendedVisual).length
  ).toBeGreaterThanOrEqual(19);
  expect(results.every((result) => result.useful)).toBe(true);
});

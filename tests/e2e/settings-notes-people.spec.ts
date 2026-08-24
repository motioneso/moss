import { expect, test, type Locator, type Page } from "@playwright/test";

import { mockApi, type MockApiState } from "./mock-api.js";

const DELETE_ID = "delete-987";
const OTHER_ID = "other-987";

async function activate(control: Locator, keyboard: boolean): Promise<void> {
  if (keyboard) {
    await control.press("Enter");
  } else {
    await control.click();
  }
}

async function setup(page: Page): Promise<MockApiState> {
  const state: MockApiState = {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: [],
    notifications: [],
    tasks: [],
    notesSourcePath: null,
    notesDirectories: {
      "": [{ name: "Mapped notes", path: "/data/external-notes" }],
      "/data/external-notes": [{ name: "Work", path: "/data/external-notes/Work" }],
      "/data/external-notes/Work": []
    },
    peopleNotesFolder: null,
    peopleDirectories: {
      "": [{ name: "People", path: "People" }],
      People: [{ name: "Family", path: "People/Family" }],
      "People/Family": []
    },
    peopleRefreshResponses: [
      { discovered: 3, projected: 1, ignored: 1, candidates: 1 },
      { error: "People notes folder is unavailable" }
    ],
    people: [],
    peopleCandidates: [
      {
        id: "candidate-987",
        candidateKind: "link_identity",
        status: "pending",
        suggestedDisplayName: "Ada Example",
        reasonSummary: "Same email in two sources",
        confidence: 0.9
      }
    ]
  };
  await mockApi(page, state);

  const records = [
    {
      kind: "action_request",
      text: "Approve another action",
      actionRequestId: OTHER_ID,
      toolName: "example.write",
      summary: "Another action"
    },
    {
      kind: "action_request",
      text: "Delete quarterly-plan.md",
      actionRequestId: DELETE_ID,
      toolName: "notes.delete",
      summary: "Delete quarterly-plan.md"
    }
  ];
  let streamServed = false;
  await page.route("**/api/chat/stream*", async (route) => {
    if (streamServed) return;
    streamServed = true;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
      body: records.map((record) => `data: ${JSON.stringify(record)}\n\n`).join("")
    });
  });
  return state;
}

async function chooseNotesFolder(page: Page, keyboard = false): Promise<void> {
  const browse = page.getByRole("button", { name: "Browse…" });
  if (keyboard) {
    await browse.focus();
    await browse.press("Enter");
  } else {
    await browse.click();
  }
  await expect(page.getByPlaceholder("/data/external-notes")).toHaveCount(0);
  await expect(page.getByText("Type a path on the server", { exact: false })).toHaveCount(0);
  const root = page.locator(".vroot").filter({ hasText: "Mapped notes" });
  await activate(root, keyboard);
  const child = page.getByRole("button", { name: /Work/ });
  await activate(child, keyboard);
  const use = page.getByRole("button", { name: "Use this folder" });
  await expect(use).toBeEnabled();
  await activate(use, keyboard);
  await expect(page.locator(".vault__path")).toHaveText("/data/external-notes/Work");
}

async function reviewExactDelete(page: Page): Promise<void> {
  await expect(page.getByText("Delete quarterly-plan.md", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Review deletion" }).click();
  await expect(page.getByRole("dialog", { name: "Chat with Moss" })).toBeVisible();
  await expect(page.locator(`[data-action-request-id="${DELETE_ID}"]`)).toBeFocused();
  await expect(page.locator(`[data-action-request-id="${OTHER_ID}"]`)).not.toBeFocused();
  await page.getByRole("button", { name: "Close chat" }).click();
}

async function openPeoplePane(page: Page): Promise<void> {
  await page.goto("/settings?section=memory");
  await page
    .getByRole("group", { name: "Memory section" })
    .getByRole("button", { name: "People", exact: true })
    .click();
  await expect(page.getByText("People notes", { exact: true })).toBeVisible();
}

async function choosePeopleFamily(page: Page, keyboard = false): Promise<void> {
  const choose = page.getByRole("button", { name: "Choose folder" });
  if (keyboard) {
    await choose.focus();
    await choose.press("Enter");
  } else {
    await choose.click();
  }
  const root = page.locator(".vroot").filter({ hasText: "People" });
  await activate(root, keyboard);
  const child = page.getByRole("button", { name: /Family/ });
  await activate(child, keyboard);
  const use = page.getByRole("button", { name: "Use this folder" });
  await expect(use).toBeEnabled();
  await activate(use, keyboard);
  await expect(
    page.locator(".set-row__control").filter({ hasText: "People/Family" })
  ).toBeVisible();
}

test("desktop selects both folder domains, recovers stale People, and focuses exact deletion", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setup(page);
  await page.goto("/settings?section=sources");
  await chooseNotesFolder(page);
  await page.getByRole("button", { name: "Sync now" }).click();
  await reviewExactDelete(page);

  await openPeoplePane(page);
  await expect(page.getByLabel("Person name")).toBeDisabled();
  await choosePeopleFamily(page);
  await page.getByTitle("Refresh").click();
  await expect(page.getByText(/Discovered 3; projected 1; ignored 1; candidates 1/)).toBeVisible();
  await expect(page.getByText("Ignored files need valid People-note frontmatter.")).toBeVisible();
  await page.getByRole("button", { name: "Review matches" }).click();
  await expect(
    page.locator('div[tabindex="-1"]').filter({ hasText: "Review matches" })
  ).toBeFocused();
  await expect(page.getByLabel("Person name")).toBeEnabled();
  expect(
    await page.evaluate(() => {
      const people = [...document.querySelectorAll(".pane__cardtitle")].find(
        (item) => item.textContent === "People (0)" || item.textContent === "People"
      );
      const manual = [...document.querySelectorAll(".pane__cardtitle")].find(
        (item) => item.textContent === "Add a person manually"
      );
      return Boolean(
        people &&
        manual &&
        people.compareDocumentPosition(manual) & Node.DOCUMENT_POSITION_FOLLOWING
      );
    })
  ).toBe(true);

  await page.getByTitle("Refresh").click();
  await expect(
    page.getByText("This People folder is unavailable.", { exact: false })
  ).toBeVisible();
  await expect(page.getByText(/Discovered 3;/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Choose another folder" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear folder" }).last()).toBeVisible();
});

test("narrow keyboard flow keeps both choosers and exact deletion focus reachable", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.goto("/settings?section=sources");
  await chooseNotesFolder(page, true);
  await page.getByRole("button", { name: "Sync now" }).press("Enter");
  await reviewExactDelete(page);

  await openPeoplePane(page);
  await choosePeopleFamily(page, true);
  await page.getByTitle("Refresh").press("Enter");
  await expect(page.getByText(/Discovered 3; projected 1; ignored 1; candidates 1/)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
});

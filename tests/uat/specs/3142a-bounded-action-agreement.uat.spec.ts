import { expect, test, type Page } from "@playwright/test";
import { bringUpRealChatModel, signInUatAdmin } from "./real-chat-signin.js";
export const uatLevel = { level: "solo-admin", without: [] } as const;
async function send(page: Page, text: string) {
  await page.goto("/today");
  const composer = page.getByRole("textbox", { name: "Message Moss" });
  if (!(await composer.isVisible()))
    await page.getByRole("button", { name: "Chat with Moss" }).click();
  await expect(composer).toBeEnabled({ timeout: 120_000 });
  const response = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/chat/turn",
    { timeout: 120_000 }
  );
  await composer.fill(text);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled({
    timeout: 120_000
  });
  await composer.press("Enter");
  expect((await response).ok()).toBe(true);
  await expect(composer).toHaveValue("");
}
test("real ordinary-chat agreement stays inert and Settings exposes its exact scope", async ({
  page
}) => {
  // Cleanup owner: the installed isolated proof harness tears down its throwaway database,
  // including the created source, chat turns and inert agreement. No scope-delete API exists.
  test.setTimeout(600_000);
  expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("1");
  await signInUatAdmin(page);
  await bringUpRealChatModel(page);
  const title = `Bounded agreement proof ${Date.now()}`;
  await page.goto("/tasks");
  const capture = page.getByRole("textbox", { name: "Task title" });
  await capture.fill(title);
  const created = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/tasks"
  );
  await capture.press("Enter");
  const result = await created;
  expect(result.status()).toBe(201);
  const { task } = (await result.json()) as { task: { id: string } };
  const readScopes = async () => {
    const response = await page.request.get("/api/chat/scheduled-tasks");
    expect(response.ok()).toBe(true);
    return (await response.json()) as {
      tasks: { id: string }[];
      approvedScopes: {
        id: string;
        state: string;
        scope: { taskId: string; status: string; operation: string; dueAt: string };
      }[];
    };
  };
  const initial = await readScopes();
  const ask = async (seconds: number) => {
    await send(page, `Mark task ${title} done in ${seconds} seconds`);
    await expect(
      page.getByText("Save your agreement to mark task", { exact: false }).last()
    ).toBeVisible({ timeout: 120_000 });
  };
  await ask(600);
  await send(page, "no");
  expect((await readScopes()).approvedScopes).toHaveLength(initial.approvedScopes.length);
  await ask(600);
  await send(page, "yes but delete it instead");
  expect((await readScopes()).approvedScopes).toHaveLength(initial.approvedScopes.length);
  await ask(90);
  await page.reload();
  const afterReload = await readScopes();
  expect(afterReload.approvedScopes).toHaveLength(initial.approvedScopes.length);
  await send(page, "yes");
  await expect(
    page.getByText("Your agreement is saved, but this task is not active.", { exact: false }).last()
  ).toBeVisible();
  await send(page, "yes");
  await send(page, "yes");
  const saved = await readScopes();
  expect(saved.tasks).toEqual(initial.tasks);
  expect(saved.approvedScopes).toHaveLength(initial.approvedScopes.length + 1);
  const agreement = saved.approvedScopes.find((scope) => scope.scope.taskId === task.id)!;
  expect(agreement).toMatchObject({
    state: "not_active",
    scope: { operation: "tasks.updateStatus", taskId: task.id, status: "done" }
  });
  await page.goto("/settings?section=scheduled");
  await expect(page.getByRole("region", { name: "Approved changes - not active" })).toBeVisible();
  await page.getByRole("button", { name: `Mark ${title} done`, exact: true }).click();
  await expect(
    page.getByText("Not active. Scheduled changes aren't available yet, so no change will run.")
  ).toBeVisible();
  await expect(page.getByText(agreement.scope.dueAt, { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
  const resume = await page.request.post(`/api/chat/scheduled-tasks/${agreement.id}/resume`);
  expect(resume.status()).toBe(404);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: `Mark ${title} done`, exact: true })
  ).toBeVisible();
  const context = page.context();
  await page.close();
  expect(context.pages()).toHaveLength(0);
  const waitMs = Math.max(0, Date.parse(agreement.scope.dueAt) - Date.now()) + 2000;
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  const returned = await context.newPage();
  try {
    await returned.goto("/tasks");
    const source = await returned.request.get(`/api/tasks/${task.id}`);
    expect(source.ok()).toBe(true);
    expect((await source.json()).task.status).toBe("todo");
    console.info(
      "3142a live assertions: decline/revision/reload saved no approval; one typed yes persisted exact inert scope; Settings exposes scope without Resume/Pause; resume API refused; source task remained todo after due while UI closed."
    );
  } finally {
    await returned.close();
  }
});

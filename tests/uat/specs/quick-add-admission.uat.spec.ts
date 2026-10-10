import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

import { buildUatComposeArgs } from "../provisioner.js";
import { signInUatAdmin } from "./real-chat-signin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;

function pauseApp(paused: boolean): void {
  const project = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!project?.startsWith("uat-")) throw new Error("An isolated UAT project is required");
  execFileSync("docker", buildUatComposeArgs(project, [paused ? "pause" : "unpause", "jarv1s"]), {
    stdio: "pipe",
    timeout: 15_000
  });
}

function isTaskPost(request: { method(): string; url(): string }): boolean {
  return request.method() === "POST" && new URL(request.url()).pathname === "/api/tasks";
}

test("installed quick add retains a genuine failed draft, admits once while busy, and recovers", async ({
  page
}) => {
  test.setTimeout(90_000);
  await signInUatAdmin(page);
  const recoveryList = await page.request.post("/api/tasks/lists", {
    data: { name: "Quick-add recovery list" }
  });
  expect(recoveryList.status()).toBe(201);
  const createdList = await page.request.post("/api/tasks/lists", {
    data: { name: "Temporary quick-add list" }
  });
  expect(createdList.status()).toBe(201);
  const { list } = (await createdList.json()) as { list: { id: string } };
  await page.goto("/tasks");
  const lists = page.getByRole("navigation", { name: "Lists" });
  await lists.getByRole("button", { name: /^Temporary quick-add list/ }).click();

  // A list removed by another client genuinely fails the stale focused-list submission.
  const deleted = await page.request.delete(`/api/tasks/lists/${list.id}`, { data: {} });
  expect(deleted.ok()).toBeTruthy();
  let posts = 0;
  page.on("request", (request) => {
    if (isTaskPost(request)) posts += 1;
  });
  const title = "Quick-add recovery task";
  const nextTitle = "Quick-add next draft";
  const field = page.getByRole("textbox", { name: "Task title" });
  await field.fill(title);
  const failure = page.waitForResponse((response) => isTaskPost(response.request()));
  await field.press("Enter");
  expect((await failure).status()).toBe(404);
  await expect(page.getByRole("alert")).toContainText("Could not add the task.");
  await expect(field).toHaveValue(title);
  expect(posts).toBe(1);
  console.log("ASSERT genuine API 404 retains the quick-add draft; no response interception");

  await lists.getByRole("button", { name: /^All lists/ }).click();
  // Pause only this disposable app to hold its real request without changing any response.
  pauseApp(true);
  try {
    const started = page.waitForRequest(isTaskPost);
    await page.getByRole("form", { name: "Capture a task" }).evaluate((form: HTMLFormElement) => {
      form.requestSubmit();
      form.requestSubmit();
    });
    await started;
    await expect(page.getByRole("button", { name: "Add task" })).toBeDisabled();
    await field.fill(nextTitle);
    await field.press("Enter");
    expect(posts).toBe(2);
    console.log("ASSERT real paused-app pending request admits once, including repeated Enter");
  } finally {
    pauseApp(false);
  }
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  await expect(field).toHaveValue(nextTitle);
  await expect(page.getByRole("button", { name: "Add task" })).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(posts).toBe(2);

  await field.press("Enter");
  await expect(page.getByText(nextTitle, { exact: true })).toBeVisible();
  await expect(field).toHaveValue("");
  expect(posts).toBe(3);
  const saved = await page.request.get("/api/tasks");
  expect(saved.ok()).toBeTruthy();
  const { tasks } = (await saved.json()) as { tasks: readonly { title: string }[] };
  expect(tasks.filter((task) => task.title === title)).toHaveLength(1);
  expect(tasks.filter((task) => task.title === nextTitle)).toHaveLength(1);
  await page.reload();
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  await expect(page.getByText(nextTitle, { exact: true })).toBeVisible();
  console.log(
    "ASSERT recovery persists one task, preserves the next draft, and permits its deliberate save"
  );
});

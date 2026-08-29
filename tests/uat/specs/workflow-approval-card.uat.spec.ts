import { expect, test } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_ID, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import { execUatSql } from "./job-search-board-sql.js";

export const uatLevel = {
  level: "solo-admin",
  without: [],
  withWorkflowApprovalFixture: true
} as const;

test("owner reaches a live workflow approval card and resumes the run (#2015)", async ({
  page
}) => {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  await page.goto(baseURL);
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.locator(".jds-usermenu__trigger");
  await expect(skipSetup.or(userMenu).first()).toBeVisible();
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(userMenu).toBeVisible();
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const approval = page.getByRole("region", { name: "Workflow approval" });
  const resolveResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/workflows/approvals/") && response.request().method() === "POST"
  );
  await approval.getByRole("button", { name: "Approve" }).click();

  const response = await resolveResponse;
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    approval: { workflowRunId: string; stepRunId: string; status: string };
    step: { id: string; workflowRunId: string; status: string };
  };
  expect(body.approval.status).toBe("approved");
  expect(body.step).toMatchObject({
    id: body.approval.stepRunId,
    workflowRunId: body.approval.workflowRunId,
    status: "queued"
  });

  await expect
    .poll(
      () => {
        const raw = execUatSql(
          process.env.JARVIS_UAT_PROJECT_NAME!,
          `select data::text from pgboss.job where name = 'workflow.step.execute' and data->>'stepRunId' = '${body.step.id}' order by created_on desc limit 1;`
        ).trim();
        return raw ? JSON.parse(raw) : null;
      },
      { timeout: 15_000 }
    )
    .toEqual({
      actorUserId: UAT_ADMIN_ID,
      workflowRunId: body.approval.workflowRunId,
      stepRunId: body.approval.stepRunId
    });

  await expect
    .poll(
      async () => {
        const detailResponse = await page.request.get(
          `/api/workflows/runs/${body.approval.workflowRunId}`
        );
        return detailResponse.ok() ? detailResponse.json() : null;
      },
      { timeout: 30_000 }
    )
    .toMatchObject({
      status: "succeeded",
      steps: expect.arrayContaining([
        expect.objectContaining({ id: body.approval.stepRunId, status: "succeeded" })
      ])
    });

  await expect(approval).toContainText("Approved");
});

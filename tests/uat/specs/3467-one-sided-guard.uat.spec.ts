import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { buildUatComposeArgs } from "../provisioner.js";
import { bringUpRealChatModel, requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;

test("one-sided notices create no commitments while owner promises and reply requests reach Today", async ({
  page
}) => {
  test.skip(!process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED, "A real economy model is required");
  test.setTimeout(300_000);
  await signInUatAdmin(page);
  // A fresh install downloads the CLI before the shared sign-in helper can use it.
  const installed = await page.request.post("/api/onboarding/provider-install", {
    data: { providerKind: "anthropic" },
    timeout: 180_000
  });
  expect(installed.ok()).toBe(true);
  await bringUpRealChatModel(page);
  execFileSync(
    "docker",
    buildUatComposeArgs(requireUatProjectName(), [
      "cp",
      "tests/uat/seed/3467-one-sided-fixture.ts",
      "jarv1s:/app/tests/uat/seed/3467-one-sided-fixture.ts"
    ])
  );
  const seeded = JSON.parse(
    execFileSync(
      "docker",
      buildUatComposeArgs(requireUatProjectName(), [
        "exec",
        "-T",
        "-e",
        "JARVIS_GATE_RUN=1",
        "-e",
        "JARVIS_UAT_SEED_CONFIRM=1",
        "jarv1s",
        "node_modules/.bin/tsx",
        "--tsconfig",
        "tsconfig.json",
        "tests/uat/seed/3467-one-sided-fixture.ts"
      ]),
      { encoding: "utf8" }
    ).trim()
  ) as { accountId: string; commitmentId: string; noticesPromoted: number; questionTriage: string };
  expect(seeded.noticesPromoted).toBe(0);
  expect(seeded.questionTriage).toBe("needs_reply");
  expect(
    (
      await page.request.put(`/api/connectors/accounts/${seeded.accountId}/feature-grants`, {
        data: { email: true }
      })
    ).ok()
  ).toBe(true);
  const created = await page.request.post("/api/briefings/definitions", {
    data: {
      title: "One-sided notice proof",
      briefingType: "morning",
      enabled: true,
      selectedToolNames: ["commitments.listVisible", "email.listVisibleMessages"]
    }
  });
  expect(created.status()).toBe(201);
  const { definition } = await created.json();
  const started = await page.request.post(`/api/briefings/definitions/${definition.id}/run`, {
    data: {}
  });
  expect(started.status()).toBe(202);
  const { runId } = await started.json();
  let run:
    | {
        status: string;
        summaryText: string;
        sourceMetadata: { commitmentCount: number; emailCount: number };
      }
    | undefined;
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/briefings/definitions/${definition.id}/runs`);
        run = (await response.json()).runs.find((row: { id: string }) => row.id === runId);
        return run?.status;
      },
      { timeout: 180_000, intervals: [1000, 2000, 4000] }
    )
    .toBe("succeeded");
  expect(run?.sourceMetadata.commitmentCount).toBe(1);
  expect(run?.sourceMetadata.emailCount).toBeGreaterThan(0);
  expect(run?.summaryText).toMatch(/design draft/i);
  expect(run?.summaryText).toMatch(/report/i);
  expect(run?.summaryText).not.toMatch(/pharmacy|prescription|pick.?up/i);
  await page.reload();
  const hero = page.locator(".today-hero");
  await expect(hero.getByRole("button", { name: "Read the full morning briefing" })).toBeVisible();
  await hero.getByRole("button", { name: "Read the full morning briefing" }).click();
  await expect(page.getByText(/design draft/i).first()).toBeVisible();
  console.log(
    "[live proof] no notice candidate; needs-reply question and one owner promise rendered in a real-model briefing"
  );
});

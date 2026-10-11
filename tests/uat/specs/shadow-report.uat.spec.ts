import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import { buildUatComposeArgs } from "../provisioner.js";
import {
  requireShadowReportProject,
  SHADOW_REPORT_MODEL_TOOL,
  SHADOW_REPORT_MODEL_IDENTITY
} from "../fixtures/shadow-report-connection.js";
import {
  classifierMcpFixtureContainerName,
  CLASSIFIER_MCP_FIXTURE_CONTAINER_PORT,
  FIXTURE_LIGHT_TOOL
} from "../fixtures/classifier-mcp-fixture-server.js";

// Temporary shadow report (#2957). Drives real chat turns through the production shadow wiring
// (same harness as the #2907 live proof: scripted chat backend plus the fixture classifier
// origin, both test-only stand-ins for external models; every shadow record is written by the
// shipped gate code observing a real turn): one match, one genuine mismatch, one missed tool.
// Then opens the report from the Classifier row's Shadow link and proves non-zero counts plus
// the disagreement row, with a screenshot for the PR.
export const uatLevel = {
  level: "admin+data",
  without: [],
  withoutNewsJsonBinding: true,
  chatScript: "classifier-shadow",
  withClassifierFixture: true,
  withClassifierMcpFixture: true
} as const;

const exec = promisify(execFile);

async function fixtureLightEvidence(project: string): Promise<unknown> {
  // Reduce inside the fixture container: no tool arguments, device names or full state enter
  // the test log. These counts prove an actual gateway request, not just the scripted reply.
  const script =
    `fetch('http://127.0.0.1:${CLASSIFIER_MCP_FIXTURE_CONTAINER_PORT}/__control/state')` +
    `.then(r=>r.json()).then(s=>console.log(JSON.stringify({` +
    `calls:s.calls.filter(c=>c.tool===${JSON.stringify(FIXTURE_LIGHT_TOOL)}&&` +
    `c.args.name==='Kitchen light'&&c.args.on===true).length,` +
    `totalCalls:s.calls.length,kitchenOn:s.devices.find(d=>d.id==='light.kitchen')?.on===true})))`;
  const result = await exec("docker", [
    "exec",
    classifierMcpFixtureContainerName(requireShadowReportProject(project)),
    "node",
    "-e",
    script
  ]);
  return JSON.parse(result.stdout);
}

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return baseURL;
}

async function signIn(page: Page): Promise<void> {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
  await expect(skipSetup.or(userMenu).first()).toBeVisible();
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    try {
      await page.getByRole("button", { name: "Skip anyway" }).click({ timeout: 5_000 });
    } catch {
      // No confirmation dialog on this instance.
    }
  }
  await expect(userMenu).toBeVisible({ timeout: 30_000 });
}

async function openAssistantAndAiSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "AI providers" }).click();
}

const classifierSelect = (page: Page) => page.getByLabel("Classifier model", { exact: true });
const gateButton = (page: Page, name: string) =>
  page.getByRole("group", { name: "Gate state" }).getByRole("button", { name });

async function chooseClassifier(page: Page, label: string): Promise<void> {
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/api/ai/services/sorting/binding") &&
      response.request().method() === "PUT",
    { timeout: 30_000 }
  );
  await classifierSelect(page).selectOption({ label });
  expect((await saved).status()).toBe(200);
  await expect(classifierSelect(page)).toHaveValue(/^model:/);
}

async function setGate(page: Page, name: string): Promise<void> {
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith(
        "/api/admin/runtime-config/chat.classifier_gate_mode"
      ) && response.request().method() === "PUT",
    { timeout: 30_000 }
  );
  await gateButton(page, name).click();
  expect((await saved).status()).toBe(200);
  await expect(gateButton(page, name)).toHaveAttribute("aria-pressed", "true");
}

async function openChat(page: Page): Promise<Locator> {
  await page.locator(".topbar-actions button").click();
  const drawer = page.locator("aside.chatd");
  await expect(drawer).toBeVisible();
  return drawer;
}

async function sendMessage(
  page: Page,
  drawer: Locator,
  message: string,
  approveFixtureLightInProject?: string
): Promise<number> {
  const turnResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/api/chat/turn") &&
      response.request().method() === "POST",
    { timeout: 180_000 }
  );
  const composer = drawer.getByLabel("Message Moss");
  await composer.fill(message);
  await composer.press("Enter");
  if (approveFixtureLightInProject) {
    // Outside descriptors and ACP launch are admission paths. This one known synthetic write
    // must ask; no unrelated tool or production device is approved by this test.
    const card = drawer.getByRole("region", { name: "Action request" });
    await expect(card.getByText(SHADOW_REPORT_MODEL_TOOL, { exact: true })).toBeVisible({
      timeout: 60_000
    });
    await expect(
      card.getByText("Moss read something from outside your account before asking this.")
    ).toBeVisible();
    const disclosedArguments = await card.locator(".action-request-arguments").textContent();
    expect(disclosedArguments).not.toBeNull();
    expect(JSON.parse(disclosedArguments!)).toEqual({ name: "Kitchen light", on: true });
    expect(await fixtureLightEvidence(approveFixtureLightInProject)).toEqual({
      calls: 0,
      totalCalls: 0,
      kitchenOn: false
    });
    const resolved = page.waitForResponse(
      (response) =>
        /\/api\/chat\/action-requests\/[^/]+\/resolve$/.test(new URL(response.url()).pathname) &&
        response.request().method() === "POST"
    );
    await card.getByRole("button", { name: "Approve", exact: true }).click();
    expect((await resolved).status()).toBe(204);
  }
  return (await turnResponse).status();
}

async function reportCounts(
  page: Page,
  days: number
): Promise<{ status: number; report: Record<string, unknown> }> {
  return page.evaluate(
    async ({ days }) => {
      const response = await fetch(`/api/chat/classifier/shadow-report?days=${days}`);
      return { status: response.status, report: (await response.json()).report };
    },
    { days }
  );
}

test("the shadow report counts real shadow records and lists the disagreement (#2957)", async ({
  page
}) => {
  test.setTimeout(420_000);
  const project = requireShadowReportProject(process.env.JARVIS_UAT_PROJECT_NAME);
  await exec(
    "docker",
    buildUatComposeArgs(project, [
      "exec",
      "-T",
      "jarv1s",
      "node_modules/.bin/tsx",
      "tests/uat/fixtures/shadow-report-connection-cli.ts",
      project
    ])
  );
  await signIn(page);

  // Fixture classifier plus Shadow gate through the real settings row.
  await openAssistantAndAiSettings(page);
  await chooseClassifier(page, "UAT Classifier Fixture Model");
  await setGate(page, "Shadow");
  await expect(page.getByRole("link", { name: "See shadow results" }).first()).toBeVisible();
  await expect(page.getByText("On opens after shadow review.")).toBeVisible();

  // 1. Match: the fixture picks calendar.listVisibleEvents and the model calls it.
  await page.goto(requireBaseURL());
  let drawer = await openChat(page);
  expect(await sendMessage(page, drawer, "uatfix what is on my calendar today?")).toBe(200);
  await expect(drawer.getByText("You have events on your calendar today.").last()).toBeVisible({
    timeout: 60_000
  });

  // 2. Genuine mismatch: the fixture still picks calendar.listVisibleEvents while the model
  // calls the seeded in-memory MCP light tool. Both are classifier-declared: undeclared tasks.list
  // is intentionally unobserved after #3037, so it cannot prove a genuine disagreement.
  await page.goto(requireBaseURL());
  drawer = await openChat(page);
  expect(
    await sendMessage(page, drawer, "uatmiss turn on the fixture Kitchen light", project)
  ).toBe(200);
  await expect(drawer.getByText("The fixture light is on.").last()).toBeVisible({
    timeout: 60_000
  });
  await expect
    .poll(() => fixtureLightEvidence(project))
    .toEqual({
      calls: 1,
      totalCalls: 1,
      kitchenOn: true
    });

  // 3. Missed tool: the unreachable classifier fails, but the model still uses a tool.
  await openAssistantAndAiSettings(page);
  await chooseClassifier(page, "UAT Classifier Unreachable Model");
  await page.goto(requireBaseURL());
  drawer = await openChat(page);
  expect(await sendMessage(page, drawer, "uatfix what is on my calendar today?")).toBe(200);
  await expect(drawer.getByText("You have events on your calendar today.").last()).toBeVisible({
    timeout: 60_000
  });

  // Opening a row precedes its decision and model observation. Poll the complete exact
  // numeric tuple, not just checked=3, so the last async writes cannot race the assertions.
  const expectedCounts = {
    status: 200,
    days: 30,
    checked: 3,
    pickedTool: 2,
    agreed: 1,
    comparable: 2,
    missedTool: 1,
    disagreements: 1
  };
  let lastCounts: Record<string, number | null> = {};
  try {
    await expect
      .poll(
        async () => {
          const { status, report } = await reportCounts(page, 30);
          lastCounts = { status };
          for (const key of ["days", "checked", "pickedTool", "agreed", "comparable", "missedTool"])
            lastCounts[key] = typeof report[key] === "number" ? report[key] : null;
          lastCounts.disagreements = Array.isArray(report.disagreements)
            ? report.disagreements.length
            : null;
          return lastCounts;
        },
        { timeout: 30_000 }
      )
      .toEqual(expectedCounts);
  } catch {
    // Numeric-only, single-line evidence survives CI's bounded Error: filter. Never emit
    // report rows, message text, identifiers, provider responses or credentials.
    throw new Error(
      `Shadow report counts: expected=${JSON.stringify(expectedCounts)} received=${JSON.stringify(lastCounts)}`
    );
  }
  const api = await reportCounts(page, 30);
  expect((api.report.disagreements as unknown[]).length).toBe(1);
  const disagreement = (api.report.disagreements as Record<string, unknown>[])[0]!;
  expect(disagreement.classifierTool).toBe("calendar.listvisibleevents");
  // The older base normalized transport underscores into dots; current main resolves the
  // exact declared module/tool identity. Both name this same actually-invoked fixture tool.
  expect([SHADOW_REPORT_MODEL_IDENTITY, "uat-shadow-report.set.light.state"]).toContain(
    disagreement.modelTool
  );

  // Open the report from the Shadow note link and prove the numbers and the row on screen.
  await openAssistantAndAiSettings(page);
  await page.getByRole("link", { name: "See shadow results" }).last().click();
  await expect(page).toHaveURL(/section=shadowreport/);
  await expect(page.getByRole("heading", { name: "Shadow report" })).toBeVisible();
  await expect(page.getByText("Messages checked")).toBeVisible();
  await expect(
    page.getByText(`calendar.listvisibleevents led to ${String(disagreement.modelTool)}`)
  ).toBeVisible();
  if (process.env.MOSS_UAT_CAPTURE_OFF !== "1")
    await page.screenshot({ path: test.info().outputPath("shadow-report-live.png") });

  // The 7 and 90-day views carry the same three turns.
  for (const days of [7, 90]) {
    const ranged = await reportCounts(page, days);
    expect(ranged.status).toBe(200);
    expect(ranged.report.checked).toBe(3);
    expect((ranged.report.disagreements as unknown[]).length).toBe(1);
  }
});

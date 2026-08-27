import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import { buildUatComposeArgs, restartUatStack } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

const execFileAsync = promisify(execFile);

// #1106: follow-up to #1084/#1103 — that PR fixed the External modules group (membership test
// moved onto the registry INDEX, `latestVersion != null`) but shipped without a docker UAT
// (owner waived it 07-16 to avoid blocking on new seed authoring). This is that UAT: a module NOT
// in the registry is dropped onto the instance's disk, the stack is restarted so the boot-time
// module scan picks it up, and the real page is checked for the trust warning, the module row,
// and its admin credential field. No mocked API calls — same style as module-install.uat.spec.ts.
export const uatLevel = { level: "solo-admin", without: [] } as const;

const FIXTURE_MODULE_ID = "uat-1106-fixture";
const FIXTURE_CREDENTIAL_LABEL = "Fixture API key";

test("an undeclared external module shows its trust warning and credential field after a real restart", async ({
  page
}) => {
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!projectName || !baseURL) {
    throw new Error("JARVIS_UAT_PROJECT_NAME / JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }

  // Build the module folder on the test runner's disk, then copy it into the running
  // container's module directory (scripts/start-jarv1s.ts creates /data/modules at boot).
  const localRoot = mkdtempSync(join(tmpdir(), "uat-1106-"));
  const localModuleDir = join(localRoot, FIXTURE_MODULE_ID);
  mkdirSync(localModuleDir, { recursive: true });
  writeFileSync(
    join(localModuleDir, "jarvis.module.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: FIXTURE_MODULE_ID,
      name: "UAT Fixture Module",
      version: "0.1.0",
      publisher: "UAT Test Publisher",
      lifecycle: "optional",
      compatibility: { jarv1s: ">=0.1.0" },
      auth: [
        {
          id: `${FIXTURE_MODULE_ID}.api`,
          displayName: FIXTURE_CREDENTIAL_LABEL,
          kind: "api-key",
          scope: "instance"
        }
      ]
    })
  );

  const copyArgs = buildUatComposeArgs(projectName, [
    "cp",
    localModuleDir,
    `jarv1s:/data/modules/${FIXTURE_MODULE_ID}`
  ]);
  await execFileAsync("docker", [...copyArgs]);

  // Restart reruns the boot-time module scan — there is no in-app "rescan" button today, so
  // this is the real way an operator would make the dropped-in module show up.
  await restartUatStack(projectName, baseURL);

  await page.goto(baseURL);
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();

  // A freshly-seeded owner has first-run onboarding pending, so login lands on the setup wizard,
  // not the app shell (tests/uat/specs/1270-provider-signin.uat.spec.ts's skipOnboarding does the
  // same dance). Skip it to reach the usermenu.
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.locator(".jds-usermenu__trigger");
  await expect(skipSetup.or(userMenu).first()).toBeVisible();
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(userMenu).toBeVisible();

  await page.locator(".jds-usermenu__trigger").click();
  await page.getByRole("button", { name: "Settings & permissions" }).click();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "Instance modules" }).click();

  const externalModulesCard = page.locator(".pane__card", { hasText: "External modules" });
  await expect(externalModulesCard).toBeVisible();

  await expect(
    externalModulesCard.getByText(
      "External modules are not reviewed by Moss. Only enable modules you authored or fully trust — an enabled module runs with the same access as built-in features."
    )
  ).toBeVisible();

  const fixtureRow = externalModulesCard.locator(".set-row", { hasText: "UAT Fixture Module" });
  await expect(fixtureRow).toBeVisible();
  await expect(fixtureRow.locator(".set-row__desc")).toContainText("UAT Test Publisher");
  await expect(fixtureRow.locator(".set-row__desc")).toContainText("v0.1.0");

  const enableSwitch = fixtureRow.getByRole("checkbox", { name: "Enable UAT Fixture Module" });
  // The Switch primitive's real checkbox input is deliberately opacity:0 (packages/ui/src/switch.tsx),
  // styled by its visible label/track sibling instead — toBeVisible() on the input itself always
  // reads "hidden" by design, so check the visible wrapper and assert state on the input.
  await expect(fixtureRow.locator("label.jds-switch")).toBeVisible();
  await expect(enableSwitch).not.toBeChecked();

  await expect(page.getByLabel(FIXTURE_CREDENTIAL_LABEL)).toBeVisible();
});

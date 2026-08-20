import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { buildUatComposeArgs, restartUatStack } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = { level: "admin+data", without: [] } as const;

// FIN-03 (#1148) Task 5 — end-to-end proof of the envelope budget on a REAL activated
// external module, from the finance-feed spec template (D7: docker-cp the package,
// fail-closed reconcile discovers it on restart, enable through the real admin UI where
// the trusted hashes are recorded, restart again so the module worker registers its
// pg-boss queues — the assign step needs the finance.budget-apply queue live).
//
// What FIN-03 adds on top of the feed proof: the seed chunk plants ONE prior-month
// assignment ledger (groceries $200, rent $1,850) and nothing else — no `state:` caches
// — so every number this spec asserts had to come out of the worker's deriveBudgetMonths
// rollover (carry forward, activity subtraction, TBB accounting), not from a fixture.
//
// SECRET HYGIENE (binding, spec §security): this test never talks to Plaid and no
// credential of any kind exists in the stack — the seed chunk (tests/uat/seed/chunks/
// finance.ts) writes only module-KV data rows; `finance.plaid-tokens` is never seeded.
//
// Real nav only past the initial load (#999/#1026); the Budget tab is reached through
// the module's own in-module router link. page.reload() is allowed — it is exactly what
// proves the assignment persisted (reload discards the screen's optimistic override, so
// the refetched value can only come from the worker's ledger write).
// run-uat.ts's finally always tears the stack down with `down -v`, so container
// logs are unrecoverable after a failure (learned the hard way on this spec's
// first run: a silently-failing queue job left no evidence). Dump them into the
// run log BEFORE teardown whenever the test didn't pass.
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixtures arg
test.afterEach(async ({}, testInfo) => {
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  if (testInfo.status === testInfo.expectedStatus || !projectName) return;
  // The reload-poll loop at the end of the test spams ~40 request-log lines per
  // reload, which scrolled the one interesting worker line out of a plain
  // --tail window on run 2 — filter the api request noise out and keep the rest.
  try {
    const logs = execFileSync(
      "docker",
      buildUatComposeArgs(projectName, ["logs", "--tail", "5000", "jarv1s"]),
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );
    console.log(
      logs
        .split("\n")
        .filter(
          (line) =>
            !line.includes('"msg":"incoming request"') &&
            !line.includes('"msg":"request completed"')
        )
        .join("\n")
    );
  } catch {
    // Diagnostics only — never mask the real test failure with a logs error.
  }
  // The ground truth for "did the queue job run and how did it end": pg-boss
  // keeps the job row (state, retry_count, output with the handler's error)
  // in pgboss.job. POSTGRES_* values are fixed in infra/docker-compose.prod.yml.
  try {
    execFileSync(
      "docker",
      buildUatComposeArgs(projectName, [
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "jarv1s",
        "-c",
        // platform.module-control is included because the enable-click runs a
        // reconcile inside that job — its output column holds the full
        // serialized reconcile error the worker log reduces to an errorName.
        "SELECT name, state, retry_count, started_on, completed_on, output FROM pgboss.job WHERE name LIKE 'finance%' OR name = 'platform.module-control' ORDER BY created_on"
      ]),
      { stdio: "inherit" }
    );
  } catch {
    // Same: diagnostics only.
  }
});

test("Finance budget derives rollover and applies assignments end-to-end", async ({ page }) => {
  // Two real container restarts + a pg-boss-driven assign poll — well past the
  // 60s config default.
  test.setTimeout(420_000);

  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!projectName || !baseURL) {
    throw new Error("JARVIS_UAT_PROJECT_NAME / JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }

  // --- D7 activation, host side (feed-spec template, verbatim) -------------------------
  execFileSync("pnpm", ["build:external:finance"], { stdio: "inherit" });
  execFileSync(
    "docker",
    buildUatComposeArgs(projectName, [
      "cp",
      "external-modules/finance",
      "jarv1s:/data/modules/finance"
    ]),
    { stdio: "inherit" }
  );

  // Restart #1: reconcile runs at boot and discovers the package (fail-closed:
  // visible to the admin but INACTIVE until explicitly enabled below).
  await restartUatStack(projectName, baseURL);

  // --- Sign in ------------------------------------------------------------------------
  await page.goto(baseURL);
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  // Scoped to the form: the auth-mode segmented control has its own "Sign in" tab button
  // with the same accessible name as the submit button (apps/web/src/auth/auth-screen.tsx).
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".jds-usermenu__trigger")).toBeVisible();

  // --- Enable through the real admin UI ------------------------------------------------
  await page.locator(".jds-usermenu__trigger").click();
  await page.getByRole("button", { name: "Settings & permissions" }).click();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "Instance modules" }).click();
  await expect(page.getByRole("heading", { name: "Instance modules" })).toBeVisible();
  const enableSwitch = page.getByRole("checkbox", { name: "Enable Finance", exact: true });
  await expect(enableSwitch).not.toBeChecked();
  // The switch input itself is visually hidden (components-forms.css) — the wrapping
  // <label.jds-switch> is the clickable surface (same idiom as tests/e2e/settings-modules.spec.ts).
  await page.locator("label.jds-switch", { has: enableSwitch }).click();
  await expect(enableSwitch).toBeChecked();

  // Restart #2: the module worker only registers its pg-boss queues at boot, and the
  // assign step below needs the finance.budget-apply queue live.
  await restartUatStack(projectName, baseURL);
  await page.reload();

  // --- Reach the Budget tab via real nav -----------------------------------------------
  await page.locator('nav[aria-label="Main"]').getByRole("link", { name: "Finance" }).click();
  await expect(page.locator('[aria-label="Transaction feed"]')).toBeVisible({ timeout: 30_000 });
  // The in-module router link (root.tsx tabs) — a real pushState nav, not a goto.
  await page.getByRole("link", { name: "Budget", exact: true }).click();
  await expect(page.locator('section[aria-label="Budget"]')).toBeVisible();

  // --- Seeded-derived state (rollover proof) -------------------------------------------
  // Seed: prior-month ledger groceries 20_000 / rent-mortgage 185_000, no prior-month
  // transactions; current month has 8_432 groceries + 185_000 rent activity and no
  // income-categorized transactions. Derived: groceries carry 200.00 − 84.32 = 115.68
  // available, rent 0.00, TBB −205_000. Nothing seeds `state:` caches, so rendering
  // these numbers proves the status handler computed the projection on miss.
  const rowFor = (name: string) =>
    page.getByRole("row").filter({ has: page.getByRole("rowheader", { name, exact: true }) });

  const tbb = page.locator('[aria-label="To be budgeted"]');
  // Negative TBB renders in the module's existing amber badge (the authored
  // danger token) — asserting the class pins the overspend affordance.
  await expect(tbb.locator(".jds-badge--amber")).toHaveText("-$2,050.00");

  const groceries = rowFor("Groceries");
  await expect(groceries.getByText("$115.68", { exact: true })).toBeVisible();
  await expect(groceries.getByText("$84.32", { exact: true })).toBeVisible();
  await expect(
    groceries.getByRole("textbox", { name: "Assigned to Groceries", exact: true })
  ).toHaveValue("0.00");
  await expect(rowFor("Rent & mortgage").getByText("$0.00", { exact: true })).toBeVisible();

  // Income and Transfers never get budget rows (income IS the TBB headline;
  // transfers are excluded from activity by the derivation).
  await expect(page.getByRole("rowheader", { name: "Income", exact: true })).toHaveCount(0);
  await expect(page.getByRole("rowheader", { name: "Transfers", exact: true })).toHaveCount(0);

  // --- Assign through the real queue ---------------------------------------------------
  // Committing the input enqueues finance.budget-apply with metadata-only params
  // {month, categoryId, amountCents} (D6 carve-out). The UI flips optimistically, so a
  // bare assertion right after the commit proves nothing — instead reload (dropping the
  // optimistic override) and poll until the WORKER's ledger write is what the derived
  // state renders: assigned 50.00, available 200.00 + 50.00 − 84.32 = 165.68, and TBB
  // down by the newly assigned 50.00.
  const assignInput = page.getByRole("textbox", { name: "Assigned to Groceries", exact: true });
  await assignInput.fill("50");
  await assignInput.press("Enter");
  await expect(async () => {
    await page.reload();
    await expect(
      page.getByRole("textbox", { name: "Assigned to Groceries", exact: true })
    ).toHaveValue("50.00", { timeout: 5_000 });
  }).toPass({ timeout: 120_000, intervals: [5_000] });
  await expect(rowFor("Groceries").getByText("$165.68", { exact: true })).toBeVisible();
  await expect(tbb.locator(".jds-badge--amber")).toHaveText("-$2,100.00");
});

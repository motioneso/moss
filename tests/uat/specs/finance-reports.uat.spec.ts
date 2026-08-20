import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { buildUatComposeArgs, restartUatStack } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = { level: "admin+data", without: [] } as const;

// FIN-05 (#1150) Task 7 — end-to-end proof of the Reports tab on a REAL activated
// external module (budget-spec template, verbatim harness: D7 docker-cp the package,
// fail-closed reconcile discovers it on restart, enable through the real admin UI,
// restart again so the module worker boots with its manifest registered).
//
// What FIN-05 adds on top of the budget proof: the seed chunk plants balance-snapshot
// chunks (with day gaps) and a checking→savings transfer pair, and NOTHING derived —
// so the net-worth headline had to come out of deriveNetWorth's carry-forward and the
// spending numbers out of aggregateSpending AFTER transfer auto-pairing excluded both
// legs. The pairing proof is a negative assertion: without pairing, the savings leg
// (−50_000, uncategorized) would drag Uncategorized from -$5.75 to -$505.75 and a
// $500.00 row would render.
//
// SECRET HYGIENE (binding, spec §security): this test never talks to Plaid and no
// credential of any kind exists in the stack — the seed chunk (tests/uat/seed/chunks/
// finance.ts) writes only module-KV data rows; `finance.plaid-tokens` is never seeded.
//
// run-uat.ts's finally always tears the stack down with `down -v`, so container
// logs are unrecoverable after a failure — dump them into the run log BEFORE
// teardown whenever the test didn't pass.
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixtures arg
test.afterEach(async ({}, testInfo) => {
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  if (testInfo.status === testInfo.expectedStatus || !projectName) return;
  // Filter the api request noise out and keep the rest (budget-spec lesson: the
  // interesting worker line scrolls out of a plain --tail window otherwise).
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
  // Ground truth for module jobs: pg-boss keeps the job row (state, retry_count,
  // output with the handler's error) in pgboss.job. platform.module-control is
  // included because the enable-click runs a reconcile inside that job.
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
        "SELECT name, state, retry_count, started_on, completed_on, output FROM pgboss.job WHERE name LIKE 'finance%' OR name = 'platform.module-control' ORDER BY created_on"
      ]),
      { stdio: "inherit" }
    );
  } catch {
    // Same: diagnostics only.
  }
});

test("Finance reports derive net worth and pairing-excluded spending end-to-end", async ({
  page
}) => {
  // Two real container restarts — well past the 60s config default.
  test.setTimeout(420_000);

  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!projectName || !baseURL) {
    throw new Error("JARVIS_UAT_PROJECT_NAME / JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }

  // --- D7 activation, host side (budget-spec template, verbatim) -----------------------
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

  // Restart #2: the module worker registers at boot; the reports tools are read-risk
  // invokeTool calls, but the restart matches the budget template's activation shape.
  await restartUatStack(projectName, baseURL);
  await page.reload();

  // --- Reach the Reports tab via real nav ----------------------------------------------
  await page.locator('nav[aria-label="Main"]').getByRole("link", { name: "Finance" }).click();
  await expect(page.locator('[aria-label="Transaction feed"]')).toBeVisible({ timeout: 30_000 });
  // The in-module router link (root.tsx tabs) — a real pushState nav, not a goto.
  await page.getByRole("link", { name: "Reports", exact: true }).click();
  const reports = page.locator('section[aria-label="Finance reports"]');
  await expect(reports).toBeVisible();

  // --- Net worth (carry-forward proof) -------------------------------------------------
  // Seeded snapshots: checking {d2 248_000, d3 250_500, d6 252_100, d9 254_317},
  // savings {d2 1_198_750, d9 1_200_000}. Headline = latest per account =
  // 254_317 + 1_200_000 = $14,543.17. Scoped to the net-worth section — the feed
  // total renders the same figure elsewhere in the app.
  const netWorth = reports.locator('section[aria-label="Net worth"]');
  await expect(netWorth.getByText("$14,543.17", { exact: true })).toBeVisible({
    timeout: 30_000
  });

  // --- Spending by category (pairing proof) --------------------------------------------
  // Post-pairing current-month spending: groceries 8_432, rent 185_000, uncategorized
  // coffee 675 + interest −1_250 = −575. The transfer legs (±50_000) are excluded.
  const byCategory = reports.locator('section[aria-label="Spending by category"]');
  const categoryRow = (label: string) =>
    byCategory.locator(".fnm-report-bar-row", { hasText: label });
  await expect(categoryRow("Groceries").getByText("$84.32", { exact: true })).toBeVisible();
  await expect(
    categoryRow("Rent & mortgage").getByText("$1,850.00", { exact: true })
  ).toBeVisible();
  await expect(categoryRow("Uncategorized").getByText("-$5.75", { exact: true })).toBeVisible();
  // Negative assertion = the pairing proof: without auto-pairing the savings leg,
  // a $500.00 amount would render and Uncategorized would read -$505.75.
  await expect(reports.getByText("$500.00", { exact: true })).toHaveCount(0);
  await expect(reports.getByText("-$505.75", { exact: true })).toHaveCount(0);

  // --- Spending by payee ---------------------------------------------------------------
  const byPayee = reports.locator('section[aria-label="Spending by payee"]');
  await expect(byPayee.getByText("Green Hills Market", { exact: true })).toBeVisible();
  await expect(byPayee.getByText("Oakwood Property Management", { exact: true })).toBeVisible();

  // --- Cash flow -----------------------------------------------------------------------
  // Current month: income 0, outflow 8_432 + 675 + 185_000 − 1_250 = 192_857 →
  // net -$1,928.57 (the transfer pair nets to zero by exclusion, not by luck).
  const cashFlow = reports.locator('section[aria-label="Cash flow"]');
  await expect(cashFlow.getByText("-$1,928.57", { exact: true })).toBeVisible();

  // --- Persistence: reload drops all client state --------------------------------------
  // The numbers must come back from real KV reads through the worker, not from
  // anything cached client-side.
  await page.reload();
  await expect(reports.getByText("$14,543.17", { exact: true })).toBeVisible({
    timeout: 30_000
  });
  await expect(categoryRow("Uncategorized").getByText("-$5.75", { exact: true })).toBeVisible();

  // --- FIN-06c (#1166, F6-D5): the ETL proof ---------------------------------------------
  // Everything above passed with the SAME dollar figures as the FIN-05 record while
  // reading through a KV-shaped seed — that's only possible if enable's
  // finance.storage-migrate job (fired per owner, F6-D4) correctly drained every KV
  // namespace into the module's own tables and the reports handlers now read those
  // tables. This block is the direct proof: the source KV rows are gone and the
  // destination table rows exist. The migrate job runs async after enable, so poll
  // (same docker-exec-psql invocation as the afterEach diagnostic above) rather than
  // assert once. Namespace strings match domain/kv-port.ts's NS map; app.module_kv
  // columns match packages/settings/sql/0154_module_kv.sql.
  const runPsql = (sql: string): string =>
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
        "-t",
        "-A",
        "-c",
        sql
      ]),
      { encoding: "utf8" }
    );

  await expect(async () => {
    const kvNamespacesGone = runPsql(
      "SELECT count(*) FROM app.module_kv WHERE module_id = 'finance' AND namespace IN ('finance.accounts','finance.transactions','finance.snapshots')"
    ).trim();
    const connectionItemsGone = runPsql(
      "SELECT count(*) FROM app.module_kv WHERE module_id = 'finance' AND namespace = 'finance.connections' AND key LIKE 'item:%'"
    ).trim();
    // Ledger AND the now-retired state cache both lived in this one namespace
    // (F6-D1) — a single count covers both.
    const budgetsGone = runPsql(
      "SELECT count(*) FROM app.module_kv WHERE module_id = 'finance' AND namespace = 'finance.budgets'"
    ).trim();
    const transactionRows = runPsql("SELECT count(*) FROM app.finance_transactions").trim();

    expect(kvNamespacesGone, "accounts/transactions/snapshots KV namespaces").toBe("0");
    expect(connectionItemsGone, "connections item:* KV keys").toBe("0");
    expect(budgetsGone, "budgets namespace (ledger + state)").toBe("0");
    expect(Number(transactionRows), "app.finance_transactions row count").toBeGreaterThan(0);
  }).toPass({ timeout: 60_000, intervals: [2_000] });
});

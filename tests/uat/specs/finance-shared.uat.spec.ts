import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { buildUatComposeArgs, restartUatStack } from "../provisioner.js";
import {
  UAT_ADMIN_EMAIL,
  UAT_ADMIN_PASSWORD,
  UAT_SECOND_OWNER_EMAIL,
  UAT_SECOND_OWNER_PASSWORD
} from "../seed/admin.js";

export const uatLevel = { level: "multi-user", without: [] } as const;

// FIN-04 (#1149) Task 6 — end-to-end proof of the household shared pool on a REAL
// activated external module, across TWO real signed-in users. From the finance-feed
// spec template (D7: docker-cp the package, fail-closed reconcile discovers it on
// restart, enable through the real admin UI where the trusted hashes are recorded,
// restart again so the module worker registers its pg-boss queues — the Share toggle
// needs the finance.share-apply queue live).
//
// What FIN-04 adds on top of the feed/budget proofs: the multi-user seed plants
// finance data for the ADMIN ONLY (levels.ts keeps the chunk asymmetric on purpose),
// so every household row the second owner sees had to travel the real pipeline —
// share-apply queue job → instance-scope mirror projection (`instanceWritePolicy:
// "module"`, the first real module-policy write in the product) → the member's own
// merged accounts.list/transactions.query reads → web-side owner resolution against
// GET /api/users/directory. And the negative half is falsifiable for the same
// reason: the unshared account and the admin's budget ledger exist ONLY as the
// admin's user-scoped rows, so the member seeing none of them proves scope, not an
// empty database.
//
// SECRET HYGIENE (binding, spec §security): this test never talks to Plaid and no
// credential of any kind exists in the stack — the seed chunk (tests/uat/seed/chunks/
// finance.ts) writes only module-KV data rows; `finance.plaid-tokens` is never seeded.
//
// Real nav only past the initial load (#999/#1026). page.reload() is allowed — it is
// exactly what proves persistence (reload discards the screen's optimistic
// shareOverrides, so a "Shared" toggle after reload can only come from the worker's
// flag write; the member's pill can only come from the mirror).
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

// Both users sign in through the same real auth form. Scoped to the form: the
// auth-mode segmented control has its own "Sign in" tab button with the same
// accessible name as the submit button (apps/web/src/auth/auth-screen.tsx).
async function signIn(page: Page, baseURL: string, email: string, password: string): Promise<void> {
  await page.goto(baseURL);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
}

test("Household shared pool: owner shares an account, member sees it attributed", async ({
  page
}) => {
  // Two real container restarts + a pg-boss-driven share poll + a second full
  // login — well past the 60s config default.
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

  // --- Sign in as the owner (UAT Admin) ------------------------------------------------
  await signIn(page, baseURL, UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD);
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
  // Share toggle below needs the finance.share-apply queue live.
  await restartUatStack(projectName, baseURL);
  await page.reload();

  // --- Owner: share Everyday Checking through the real toggle --------------------------
  await page.locator('nav[aria-label="Main"]').getByRole("link", { name: "Finance" }).click();
  await expect(page.locator('[aria-label="Transaction feed"]')).toBeVisible({ timeout: 30_000 });

  // Seed truth: nothing is shared yet, so the owner's own pills carry a Share
  // toggle in its OFF state (accessible name is the visible text).
  const checkingPill = page.locator(".fnm-pill", { hasText: "Everyday Checking" });
  const savingsPill = page.locator(".fnm-pill", { hasText: "Rainy Day Savings" });
  await expect(checkingPill.getByRole("button", { name: "Share", exact: true })).toBeVisible();
  await expect(savingsPill.getByRole("button", { name: "Share", exact: true })).toBeVisible();

  // The click flips the label optimistically and enqueues finance.share-apply with
  // metadata-only params {accountId, shared} (D6 carve-out). The optimistic flip
  // proves nothing — reload (dropping shareOverrides) and poll until the WORKER's
  // sharedToHousehold flag write is what the refetched account renders.
  await checkingPill.getByRole("button", { name: "Share", exact: true }).click();
  await expect(checkingPill.getByRole("button", { name: "Shared", exact: true })).toBeVisible();
  await expect(async () => {
    await page.reload();
    const pill = page.locator(".fnm-pill", { hasText: "Everyday Checking" });
    await expect(pill.getByRole("button", { name: "Shared", exact: true })).toBeVisible({
      timeout: 5_000
    });
  }).toPass({ timeout: 120_000, intervals: [5_000] });
  // Savings stays unshared — the flag write is per-account, not per-user.
  await expect(
    page
      .locator(".fnm-pill", { hasText: "Rainy Day Savings" })
      .getByRole("button", { name: "Share", exact: true })
  ).toBeVisible();

  // --- Switch users: owner out, household member in ------------------------------------
  await page.locator(".jds-usermenu__trigger").click();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.locator("form.auth-form")).toBeVisible({ timeout: 30_000 });
  await signIn(page, baseURL, UAT_SECOND_OWNER_EMAIL, UAT_SECOND_OWNER_PASSWORD);

  // #1059 trap: onboarding status is per-user and the seed completes it only for
  // the admin, so the second owner lands on the wizard. "Skip anyway" is #369's
  // consequence dialog — it only appears when the wizard thinks chat would
  // dead-end, so tolerate both paths rather than pin instance provider state.
  await page.getByRole("button", { name: "Skip setup" }).click();
  try {
    await page.getByRole("button", { name: "Skip anyway" }).click({ timeout: 5_000 });
  } catch {
    // No confirm dialog — the seeded instance AI provider satisfied #369's check.
  }
  await expect(page.locator(".jds-usermenu__trigger")).toBeVisible({ timeout: 30_000 });

  // --- Member: merged feed shows the shared account, attributed ------------------------
  await page.locator('nav[aria-label="Main"]').getByRole("link", { name: "Finance" }).click();
  await expect(page.locator('[aria-label="Transaction feed"]')).toBeVisible({ timeout: 30_000 });

  // applyShareFlag writes the flag FIRST and the mirror SECOND, so the owner-side
  // poll above proves the job ran but not that every mirror key landed — poll here
  // too instead of asserting the first paint.
  await expect(async () => {
    await page.reload();
    await expect(
      page.locator(".fnm-pill", { hasText: "Everyday Checking" }).getByText("UAT Admin")
    ).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 120_000, intervals: [5_000] });

  const memberPill = page.locator(".fnm-pill", { hasText: "Everyday Checking" });
  // The shared-view projection carries the balance, and the pill renders owner
  // attribution INSTEAD of Plaid plumbing: no status badge, no Share toggle
  // (only the owner may unshare, #1149) — buttons simply don't exist here.
  await expect(memberPill.getByText("$2,543.17")).toBeVisible();
  await expect(memberPill.getByRole("button")).toHaveCount(0);

  // A shared transaction row from the mirror, attributed the same way, with the
  // owner's category label read-only (no recategorize select on household rows —
  // recategorize would enqueue against the VIEWER's chunks and fail not_found).
  const sharedRow = page.locator(".fnm-txrow", { hasText: "GREEN HILLS MARKET #204" });
  await expect(sharedRow.getByText("UAT Admin")).toBeVisible();
  await expect(sharedRow.locator("select")).toHaveCount(0);

  // --- Member: the UNSHARED account and the owner's budget stay invisible --------------
  // These rows exist only as the admin's user-scoped KV — any leak here means the
  // merge read instance scope wrong or RLS let a foreign row through.
  await expect(page.getByText("Rainy Day Savings")).toHaveCount(0);
  await expect(page.getByText("INTEREST PAYMENT")).toHaveCount(0);

  // The owner's prior-month assignment ledger (groceries/rent) must not seed the
  // member's budget: the derivation runs over the MEMBER's chunks and ledgers
  // only. An empty user still renders the DEFAULT taxonomy rows (loadCategories
  // never seeds; budget.status computes the all-zero state on miss), so the
  // non-leak proof is every number being zero exactly where the OWNER's screen
  // derives −$2,050.00 TBB and $115.68 / $84.32 on Groceries (FIN-03 spec).
  await page.getByRole("link", { name: "Budget", exact: true }).click();
  await expect(page.locator('section[aria-label="Budget"]')).toBeVisible();
  await expect(page.getByText(/Nothing to budget in /)).toBeVisible();
  await expect(page.locator('[aria-label="To be budgeted"]')).toContainText("$0.00");
  const memberGroceries = page
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "Groceries", exact: true }) });
  await expect(
    memberGroceries.getByRole("textbox", { name: "Assigned to Groceries", exact: true })
  ).toHaveValue("0.00");
  await expect(memberGroceries.getByText("$115.68", { exact: true })).toHaveCount(0);
  await expect(memberGroceries.getByText("$84.32", { exact: true })).toHaveCount(0);
});

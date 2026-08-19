# Module #1007 ENOENT Guard + Stage 2 UAT Proof Implementation Plan

> **For agentic workers:** This plan is driven inline by the `coordinated-build` agent, task by
> task (the superpowers execution sub-skills are disabled in this repo by design). Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `loadModuleMigrationFiles` to tolerate a missing `sql/` directory (external DB-less
modules like job-search currently fail to activate with ENOENT), then prove — end to end through
the real web UI on an isolated dev stack — that job-search installs, runs, and survives a container
recreate.

**Architecture:** One defensive try/catch added to an existing pure function
(`packages/db/src/migrations/module-sql-runner.ts`), covered by a new unit test alongside its two
existing siblings. Stage 2 is operational: bring up an isolated `jarvis-uat-1006` Docker Compose
stack from this worktree's fixed image build inputs, drive owner signup + module install/enable
through a new self-contained Playwright script, and assert persistence across a container
recreate.

**Tech Stack:** TypeScript, Vitest (integration test harness via `tsx scripts/test-integration.ts`),
Docker Compose, Playwright.

## Global Constraints

- Fix only #1007 (ENOENT guard). Do **not** touch compose files — #1006 is already fixed upstream
  (commit `7484f449`/#964) and Stage 2 empirically reconfirms it via the recreate assertion; do not
  re-add any `/app/data` volume.
- Do not edit any Instance-modules UI / settings code (`apps/web/src/settings/settings-instance-modules-pane.tsx`,
  `settings-module-registry-section.tsx`) — owned by another agent. Only drive it via Playwright.
- No `git add -A` — explicit paths only, per task.
- Do not touch `docs/coordination/` or run repo-wide `pnpm format`.
- Isolated Stage 2 stack name `jarvis-uat-1006` only; PROD (`jarv1s-prod`, port 1533) and
  `jarvis-devproof-999` are off-limits.
- Regression test must not touch the sibling `describe("module migration ledger", ...)` block in
  the same file.
- PR body: `Closes #1007`; note #1006 was already fixed upstream by 7484f449/#964, reconfirmed by
  the Stage 2 recreate test.

---

### Task 1: ENOENT guard in `loadModuleMigrationFiles`

**Files:**

- Modify: `packages/db/src/migrations/module-sql-runner.ts:130-146`
- Test: `tests/integration/module-migration-ledger.test.ts` (inside the existing
  `describe("loadModuleMigrationFiles", ...)` block, lines ~33-52)

**Interfaces:**

- Consumes: nothing new — `loadModuleMigrationFiles(directory: string): Promise<ModuleMigrationFile[]>`
  already exists (`module-sql-runner.ts:131`); signature is unchanged.
- Produces: same signature, now resolving to `[]` instead of rejecting when `directory` doesn't
  exist. Callers (`scripts/module-install.ts:57`, and transitively `scripts/module-reconcile.ts`
  Phase 6) need no changes — they already treat an empty migration list as "no DB work to do".

- [ ] **Step 1: Write the failing test**

Add as the 3rd test inside the existing `describe("loadModuleMigrationFiles", ...)` block in
`tests/integration/module-migration-ledger.test.ts` (after the "throws with the file name..." test,
before the closing `});` at line 52):

```ts
it("returns [] when the directory doesn't exist (DB-less external module)", async () => {
  dir = mkdtempSync(join(tmpdir(), "module-migrations-"));
  const missing = join(dir, "sql");
  // dir itself is real (so afterEach can rmSync it); "sql" under it is never created.

  await expect(loadModuleMigrationFiles(missing)).resolves.toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:integration -- tests/integration/module-migration-ledger.test.ts`
Expected: FAIL — the new test rejects with an `ENOENT` error instead of resolving to `[]`
(current `readdir` call throws raw).

- [ ] **Step 3: Write minimal implementation**

Replace `packages/db/src/migrations/module-sql-runner.ts:130-132`:

```ts
/** Loads every `.sql` file in `directory`, sorted by filename, validating each against the wire contract. */
export async function loadModuleMigrationFiles(directory: string): Promise<ModuleMigrationFile[]> {
  const entries = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
```

with:

```ts
/**
 * Loads every `.sql` file in `directory`, sorted by filename, validating each against the wire
 * contract. A missing `directory` returns `[]` rather than throwing: external modules with no
 * database tables (e.g. job-search) ship no `sql/` dir at all, which is a valid, common shape —
 * not an error. Reconcile (#1007) was pinning every DB-less module `disabled` /
 * `database install failed` because the raw ENOENT propagated as a hard failure. Any other
 * readdir error (permissions, not-a-directory, etc.) still rethrows.
 */
export async function loadModuleMigrationFiles(directory: string): Promise<ModuleMigrationFile[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries = names.filter((name) => name.endsWith(".sql")).sort();
```

**Interfaces note:** the rest of the function body (lines 133-146 in the original) is unchanged —
it still consumes the local `entries` array exactly as before.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:integration -- tests/integration/module-migration-ledger.test.ts`
Expected: PASS — all 3 tests in `describe("loadModuleMigrationFiles", ...)` green, plus the
untouched `describe("module migration ledger", ...)` block still green.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/migrations/module-sql-runner.ts tests/integration/module-migration-ledger.test.ts
git commit -m "fix(modules): tolerate missing sql/ dir in loadModuleMigrationFiles (#1007)"
```

---

### Task 2: Full local gate

**Files:** none (verification only)

**Interfaces:** N/A

- [ ] **Step 1: Run the full foundation gate**

Run: `pnpm verify:foundation`
Expected: exit code 0. Record the exit code in the final report to the coordinator.

- [ ] **Step 2: Commit** — nothing to commit (verification-only task); proceed to Task 3 regardless
      of whether anything changed.

---

### Task 3: Stage 2 — bring up isolated UAT stack

**Files:**

- Create (ephemeral, not committed): none — the stack uses this worktree's existing
  `infra/docker-compose.prod.yml` unmodified and the reused env file below.

**Interfaces:**

- Consumes: `ghcr.io/motioneso/jarv1s:edge` image (already contains the #1007 fix once CI has
  republished after this PR merges — for the _proof_ run before merge, the fixed code is exercised
  via this worktree's own build, not the published `:edge` tag; see Step 1 note).
- Produces: a running stack on `http://localhost:1545` (and LAN `http://192.168.50.36:1545`) that
  Task 4's Playwright script drives.

- [ ] **Step 1: Tear down any stale stack, then build and start the isolated stack from this
      worktree's fixed code**

The original devproof handoff assumed pulling published `:edge`, but that tag won't contain the
Task 1 fix until this branch merges and CI republishes. Build the image from this worktree instead
so the fix under test is actually exercised:

```bash
cd /home/ben/Jarv1s/.claude/worktrees/module-persist-1006
docker compose -p jarvis-uat-1006 down -v 2>&1 | tail -5 || true
docker compose -p jarvis-uat-1006 \
  --env-file /tmp/claude-1000/-home-ben-Jarv1s--claude-worktrees-coord-2026-06-30-rfa-fleet/58a78927-385c-4b1d-8fa0-94db20255d6f/scratchpad/devproof/env.devproof \
  -f infra/docker-compose.prod.yml \
  build jarv1s
docker compose -p jarvis-uat-1006 \
  --env-file /tmp/claude-1000/-home-ben-Jarv1s--claude-worktrees-coord-2026-06-30-rfa-fleet/58a78927-385c-4b1d-8fa0-94db20255d6f/scratchpad/devproof/env.devproof \
  -f infra/docker-compose.prod.yml \
  -p jarvis-uat-1006 up -d
```

Override the web port to 1545 via the env file's `JARVIS_WEB_PORT` (or equivalent published-port
var — confirm the exact var name by grepping `infra/docker-compose.prod.yml` for `ports:` before
running; the env file already sets this per the original handoff).

Expected: containers start; no port conflict (1545 confirmed free in Step 0 orientation).

- [ ] **Step 2: Wait for health and confirm the module-data mount**

```bash
until curl -fsS http://localhost:1545/health/ready >/dev/null 2>&1; do sleep 2; done
echo "ready"
docker inspect jarvis-uat-1006-jarv1s-1 --format '{{json .Mounts}}' | grep -o '/app/data'
```

Expected: `ready` printed, and the mounts JSON contains `/app/data` (confirms the already-shipped
#1006 volume fix is present in the running container — this is the baseline the Task 5 recreate
test will re-assert).

- [ ] **Step 3: Commit** — nothing to commit (operational step).

---

### Task 4: Stage 2 — Playwright UAT script (owner signup → install → enable → verify route)

**Files:**

- Create: `scripts/uat/job-search-install.spec.ts`

**Interfaces:**

- Consumes: real selectors confirmed by reading the source this session:
  - Owner signup (`apps/web/src/auth/auth-screen.tsx`): first-boot auto-selects sign-up mode
    (`needsBootstrap` true). Fields are `<label>Name<input .../></label>`,
    `<label>Email<input type="email" .../></label>`, `<label>Password<input type="password"
minLength={8} .../></label>`. Submit button text: `"Create account"`.
  - Settings deep link: `apps/web/src/settings/settings-page.tsx` honors `?section=<id>` once on
    mount then clears it (lines ~178-192) — for an admin section id (`"instmods"`) it also flips
    `mode` to `"admin"` automatically. So `/settings?section=instmods` lands directly on Instance
    modules with no extra clicking.
  - Instance modules row (`apps/web/src/settings/settings-module-registry-section.tsx`): row
    `<li>` has `<strong>{row.name}</strong>` (job-search's registry display name — confirm exact
    string by inspecting the live page, since it's a running-instance value, not a source
    constant) and `<code>{row.id}</code>` (expect `job-search`). Install button text `"Install"`;
    clicking opens `role="dialog" aria-modal="true" aria-label="Install ${row.name}?"` with a
    `"Download"` confirm button. After download: toast `"${name} downloaded — restart Jarvis to
apply"` and state label becomes `"Downloaded — restart to apply"`. Enable/disable uses a
    `<Switch ariaLabel="Enable ${row.name}">` once `installed-enabled`/`installed-disabled`.
  - job-search module route (`external-modules/job-search/src/web/root.tsx` +
    `external-modules/job-search/src/web/router.ts`): host base path is `/m/job-search`; the
    module root renders `<div className="jsm-root" data-module="job-search">` with header
    `<h1>Job Search</h1>` and nav `aria-label="Job Search sections"`.
- Produces: action logs and DOM/network assertions under the run's scratchpad `devproof/` directory.

- [ ] **Step 1: Confirm Playwright is available**

```bash
pnpm dlx playwright install chromium
```

Expected: exits 0 (already installed, or installs cleanly).

- [ ] **Step 2: Write the script**

```ts
// scripts/uat/job-search-install.spec.ts
// #1007 Stage 2 UAT proof: owner signup -> install job-search from the registry through the real
// Settings UI -> enable it -> confirm a real job-search route responds -> (Task 5) survive a
// container recreate. This is the end-to-end proof Ben asked for; no backend shortcuts.
import { chromium, type Page } from "playwright";
const BASE_URL = process.env["UAT_BASE_URL"] ?? "http://localhost:1545";
const OWNER_EMAIL = "uat-owner-1006@example.com";
const OWNER_PASSWORD = "uat-owner-password-1006";
const OWNER_NAME = "UAT Owner";

async function signUpOwner(page: Page): Promise<void> {
  await page.goto(BASE_URL);
  await page.getByLabel("Name").fill(OWNER_NAME);
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/(onboarding|home|today)?/, { timeout: 15_000 });
}

async function skipOnboardingIfPresent(page: Page): Promise<void> {
  const skipAll = page.getByRole("button", { name: /skip/i });
  if (
    await skipAll
      .first()
      .isVisible({ timeout: 5_000 })
      .catch(() => false)
  ) {
    await skipAll.first().click();
  }
}

async function installJobSearch(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/settings?section=instmods`);
  await page.waitForSelector("text=Available modules", { timeout: 15_000 });

  const row = page.locator("li", { has: page.locator("code", { hasText: "job-search" }) });
  await row.scrollIntoViewIfNeeded();

  const installButton = row.getByRole("button", { name: /install/i });
  await installButton.click();

  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Download" }).click();

  await row.getByText(/restart to apply/i).waitFor({ timeout: 30_000 });
}

async function enableJobSearch(page: Page): Promise<void> {
  const row = page.locator("li", { has: page.locator("code", { hasText: "job-search" }) });
  const toggle = row.getByRole("switch");
  const alreadyEnabled = await toggle.isVisible({ timeout: 2_000 }).catch(() => false);
  if (!alreadyEnabled) {
    // Not yet installed/enabled-eligible: restart is required first (Task 5 handles that).
    return;
  }
  if (!(await toggle.isChecked())) {
    await toggle.click();
    await page.waitForTimeout(500);
  }
}

async function assertJobSearchRouteResponds(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/m/job-search`);
  await page.waitForSelector('[data-module="job-search"]', { timeout: 15_000 });
  await page.getByRole("heading", { name: "Job Search" }).waitFor({ timeout: 15_000 });
}

export async function run(): Promise<{ needsRestart: boolean }> {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await signUpOwner(page);
    await skipOnboardingIfPresent(page);
    await installJobSearch(page);
    await enableJobSearch(page);

    const row = page.locator("li", { has: page.locator("code", { hasText: "job-search" }) });
    const toggle = row.getByRole("switch");
    const needsRestart = !(await toggle.isVisible({ timeout: 2_000 }).catch(() => false));
    return { needsRestart };
  } finally {
    await browser.close();
  }
}

// Post-restart resume: re-enable + assert the route, without re-doing signup/install.
export async function resumeAfterRestart(): Promise<void> {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(BASE_URL);
    await page.getByLabel("Email").fill(OWNER_EMAIL);
    await page.getByLabel("Password").fill(OWNER_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/(onboarding|home|today)?/, { timeout: 15_000 });

    await page.goto(`${BASE_URL}/settings?section=instmods`);
    await enableJobSearch(page);
    await assertJobSearchRouteResponds(page);
  } finally {
    await browser.close();
  }
}

const mode = process.argv[2] ?? "run";
if (mode === "resume") {
  resumeAfterRestart()
    .then(() => console.log("RESUME OK"))
    .catch((error) => {
      console.error("RESUME FAILED", error);
      process.exitCode = 1;
    });
} else {
  run()
    .then((result) => console.log(`RUN OK needsRestart=${result.needsRestart}`))
    .catch((error) => {
      console.error("RUN FAILED", error);
      process.exitCode = 1;
    });
}
```

- [ ] **Step 3: Run it against the live stack**

```bash
cd /home/ben/Jarv1s/.claude/worktrees/module-persist-1006
UAT_BASE_URL=http://localhost:1545 pnpm dlx tsx scripts/uat/job-search-install.spec.ts run
```

Expected: `RUN OK needsRestart=true` (per the original handoff's directive #5, restart-to-activate
is confirmed by-design — expect `true`; if it prints `false`, that is itself a finding to report,
not a bug to chase). Confirm the script's state and route assertions pass.

- [ ] **Step 4: Commit**

```bash
git add scripts/uat/job-search-install.spec.ts
git commit -m "test(uat): add Playwright job-search install/enable proof script (#1007)"
```

---

### Task 5: Stage 2 — restart-to-activate, then prove persistence across container recreate

**Files:** none (operational verification only)

**Interfaces:** consumes `resumeAfterRestart()` from Task 4's script.

- [ ] **Step 1: Restart the stack (first activation)**

```bash
docker compose -p jarvis-uat-1006 \
  --env-file /tmp/claude-1000/-home-ben-Jarv1s--claude-worktrees-coord-2026-06-30-rfa-fleet/58a78927-385c-4b1d-8fa0-94db20255d6f/scratchpad/devproof/env.devproof \
  -f infra/docker-compose.prod.yml \
  restart jarv1s
until curl -fsS http://localhost:1545/health/ready >/dev/null 2>&1; do sleep 2; done
```

Expected: health check passes again after restart.

- [ ] **Step 2: Re-run the script in resume mode — enable + confirm the route**

```bash
UAT_BASE_URL=http://localhost:1545 pnpm dlx tsx scripts/uat/job-search-install.spec.ts resume
```

Expected: `RESUME OK`; the live route assertion passes for the real job-search route. This is the
"restart activates it" finding, reported plainly per directive #5 — not treated
as a bug.

- [ ] **Step 3: Recreate the container (the #1006 persistence proof) and re-assert**

```bash
docker compose -p jarvis-uat-1006 \
  --env-file /tmp/claude-1000/-home-ben-Jarv1s--claude-worktrees-coord-2026-06-30-rfa-fleet/58a78927-385c-4b1d-8fa0-94db20255d6f/scratchpad/devproof/env.devproof \
  -f infra/docker-compose.prod.yml \
  up -d --force-recreate jarv1s
until curl -fsS http://localhost:1545/health/ready >/dev/null 2>&1; do sleep 2; done
UAT_BASE_URL=http://localhost:1545 pnpm dlx tsx scripts/uat/job-search-install.spec.ts resume
```

Expected: `RESUME OK` again after `--force-recreate` — job-search is still installed/enabled and
its route still responds without re-installing. GREEN only if this step passes without re-running
the install flow.

- [ ] **Step 4: Commit** — nothing to commit (operational verification).

---

### Task 6: Pre-push gate, PR, and report

**Files:** none beyond what Tasks 1 and 4 already committed.

- [ ] **Step 1: Pre-push trio + rebase**

```bash
pnpm format:check && pnpm lint && pnpm typecheck
git fetch origin main && git rebase origin/main
```

Expected: all green; rebase clean (or resolved if trivial).

- [ ] **Step 2: Push and open PR**

PR body: `Closes #1007`. Note: "#1006 was already fixed upstream by 7484f449/#964 — reconfirmed
empirically by this PR's Stage 2 container-recreate test." Include the restart-to-activate finding
plainly (by-design, per `scripts/start-jarv1s.ts` boot sequence and the Instance-modules UI's own
`<Note>` banner).

- [ ] **Step 3: Invoke `coordinated-wrap-up`** for the PR + report step (not part of this plan's
      scope — separate skill).

- [ ] **Step 4: Final report to Coordinator** covering: VERDICT GREEN/RED; owner login
      (`http://192.168.50.36:1545` or `http://localhost:1545`, email `uat-owner-1006@example.com`,
      password `uat-owner-password-1006`); restart-was-required = yes (plain finding); evidence paths
      under the scratchpad devproof dir; Playwright script path
      `scripts/uat/job-search-install.spec.ts`; leave `jarvis-uat-1006` UP if GREEN, tear down
      (`docker compose -p jarvis-uat-1006 down -v`) if RED.

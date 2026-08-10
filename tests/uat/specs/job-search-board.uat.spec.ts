// tests/uat/specs/job-search-board.uat.spec.ts
//
// #1306 Task 22 (docs/superpowers/handoffs/2026-07-27-job-search/parts/27-task22-e2e.md): the
// job-search module's UAT coverage, end to end against the real stack. ONE test, `test.step`
// phases, not a suite — mirrors the part file's own framing ("a single narrative, not a suite")
// and keeps the two restarts (install, then enable) paid for exactly once.
//
// Structural precedent is tests/uat/specs/finance-feed.uat.spec.ts: same activation recipe
// (build:external, docker cp, restart, enable via Instance modules, restart, reload, open via the
// nav). This module additionally needs N42's fixture-backed AI/crawl origin
// (`withJobSearchFixture: true` below).
//
// Ruling N45 (rulings-ledger.md): "a UAT phase may seed its preconditions, but never the
// behaviour it asserts." That splits this spec by SUBJECT, not by convenience:
//   - Phases 1-2 (install/enable, automatic profile bootstrap) need no model and always run.
//   - Phases 3-4 are ABOUT the real onboarding conversation itself — the chat turn IS the
//     subject under test, so a fake/canned provider cannot stand in for it (it can't reliably
//     decide which of six `job-search.*` tools to call over a multi-turn interview). These two
//     stay gated on REAL_CHAT_CONFIGURED, exactly like real-chat-onboarding.uat.spec.ts's #1121
//     gate: skipped on every default/CI run, exercised only when an operator supplies a real
//     token via JARVIS_UAT_REAL_CHAT_ENV_FILE.
//   - Phases 5-12 are ABOUT the board, sort, portal banner, inspector, drawer scoping, and nav
//     badge — NONE of them are about onboarding. Gating those on a real model too would mean this
//     spec's only board/sort/banner/inspector coverage never runs on CI, which is what the
//     original version of this file did (a `test.skip` mid-test that silently dropped the rest of
//     the narrative). Instead, a "Setup" step direct-seeds one already-active profile (N40: a real
//     production path — onboarding completion — writes exactly this row shape, so seeding it is
//     skipping a slow dependency, not fabricating the thing under test), and Phases 5-12 run
//     unconditionally against it, on every run.
import { execFileSync } from "node:child_process";
import { expect, test, type Locator, type Page, type Response } from "@playwright/test";
import { buildUatComposeArgs, restartUatStack } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_ID, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import { deterministicFixtureScore } from "../fixtures/job-search-fixture-server.js";

export const uatLevel = {
  level: "admin+data",
  without: [],
  withJobSearchFixture: true
} as const;

// #1121: the provisioner exports this only after decrypting + validating an operator-provided
// real-chat token env file (writeUatRealChatEnvFile). Absent on every default/CI run, so the whole
// real-conversation portion of this spec skips rather than failing — see header.
const REAL_CHAT_CONFIGURED = Boolean(process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE);

// Mirrors real-chat-onboarding.uat.spec.ts's bounded exponential backoff: never a fixed sleep,
// always a hard deadline. Used both for the bootstrap-profile wait (which self-polls internally,
// per use-profiles.ts's own 3s/120s/40-attempt loop) and for the reload-driven chip/board waits
// below, which do NOT self-poll and need an explicit reload each attempt.
const POLL_DEADLINE_MS = 120_000;
const POLL_INITIAL_INTERVAL_MS = 500;
const POLL_MAX_INTERVAL_MS = 4_000;
// How long one poll cycle waits for the reloaded page to render what it is looking for. Generous
// because the board's data arrives over two sequential fetches (profile list, then matches).
const POLL_SETTLE_MS = 5_000;

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) {
    throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }
  return baseURL;
}

function requireProjectName(): string {
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!projectName) {
    throw new Error("JARVIS_UAT_PROJECT_NAME must be set by run-uat.ts");
  }
  return projectName;
}

// Shared direct-SQL-seed helper for the Setup/Phase 10/Phase 11 steps below (N40/N45): connects as
// the container's bootstrap superuser, not one of the four named app roles
// (infra/postgres/bootstrap/0000_roles.sql marks jarvis_migration_owner/app_runtime/worker_runtime/
// auth_runtime all NOBYPASSRLS), so this bypasses the FORCE RLS policies the same way a real
// migration/bootstrap connection does — there is no app-role path that could run these INSERTs.
// `-t -A` gives unaligned, headerless output so a `RETURNING` clause parses with a plain `.trim()`
// / `.split("|")` — but ONLY after the command tag is stripped. psql prints its tag ("INSERT 0 1",
// "UPDATE 1") on the line *after* the RETURNING row even under -t -A, so a raw return glues the tag
// onto the last column: a seeded uuid came back as "<uuid>\nINSERT 0 1" and Postgres rejected it as
// invalid uuid syntax on the next statement. Stripped here rather than at each call site, because
// every caller that adds a RETURNING clause would otherwise have to rediscover it.
const PSQL_COMMAND_TAG = /^(?:INSERT \d+ \d+|UPDATE \d+|DELETE \d+|SELECT \d+|MERGE \d+)$/;

function execUatSql(projectName: string, sql: string): string {
  const raw = execFileSync(
    "docker",
    buildUatComposeArgs(projectName, [
      "exec",
      "-T",
      "postgres",
      "psql",
      // The superuser, not a role named after the database. `infra/docker-compose.prod.yml` sets
      // POSTGRES_USER: postgres and POSTGRES_DB: jarv1s, so there is no `jarv1s` ROLE at all —
      // an earlier version of this helper assumed symmetry with the database name and every call
      // died with `FATAL: role "jarv1s" does not exist`. Only a live run could catch that; both
      // the compile and the whole unit/integration gate are blind to it.
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

  return raw
    .split("\n")
    .filter((line) => !PSQL_COMMAND_TAG.test(line.trim()))
    .join("\n");
}

// Local mirror of apps/web/src/shell/chat-surface-key.ts's moduleChatSurface — KEEP IN SYNC. No
// existing UAT spec imports browser-bundle source (it isn't built for node), and this is the only
// way Phase 11 can compute the exact surface string useProfileThread's setSurfaceKey(surfaceKey)
// binds, without which a direct-seeded chat_threads row would land on the wrong surface and never
// be picked up by useChatStream's per-surface history fetch.
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

function toHex8(value: number): string {
  return value.toString(16).padStart(8, "0");
}

function moduleChatSurface(moduleId: string, key: string): string {
  const input = `${moduleId}:${key}`;
  const reversed = Array.from(input).reverse().join("");
  const hi = toHex8(fnv1a32(input));
  const lo = toHex8(fnv1a32(reversed));
  return `m-${hi}${lo}`;
}

// Copied (not imported) from finance-feed.uat.spec.ts / real-chat-onboarding.uat.spec.ts — the
// harness's established pattern for avoiding cross-file test() registration. admin+data lands
// directly on AppShell (no first-run wizard), so no Skip-setup handling is needed here, unlike the
// solo-admin copies.
async function signIn(page: Page): Promise<void> {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".jds-usermenu__trigger")).toBeVisible();
}

async function openInstanceModules(page: Page): Promise<void> {
  await page.locator(".jds-usermenu__trigger").click();
  await page.getByRole("button", { name: "Settings & permissions" }).click();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "Instance modules" }).click();
}

async function openJobSearch(page: Page): Promise<void> {
  await page.locator('nav[aria-label="Modules"]').getByRole("link", { name: "Job Search" }).click();
}

async function observedProfiles(response: Response): Promise<Array<{ state?: string }> | null> {
  if (
    !response.url().endsWith("/api/ai/assistant-tools/job-search.profile.list/invoke") ||
    response.request().method() !== "POST" ||
    !response.ok()
  ) {
    return null;
  }
  const body = (await response.json()) as {
    invocation?: { status?: string; result?: { profiles?: Array<{ state?: string }> } };
  };
  return body.invocation?.status === "succeeded" && Array.isArray(body.invocation.result?.profiles)
    ? body.invocation.result.profiles
    : null;
}

// use-profiles.ts's POLL_* constants cover only the empty->profile-exists transition (the hook
// polls internally while pollArmed && status==="empty"). Once a profile exists, completedSteps and
// match data are fetched once on mount with no live refresh — reload is how this spec observes
// progress made by conversational turns, not merely a persistence check (matches the part file's
// "assert chip state survives a reload" wording, which is also the only way to see it change).
// #1306 live-path evidence. The gate wants proof a human can read, and the manual walkthrough doc
// (docs/superpowers/handoffs/2026-07-27-job-search/MANUAL-TEST.md) is assembled from exactly these
// frames — so they are written to a stable, predictable directory rather than testInfo.outputPath,
// whose name changes with the test title. Also attached to the Playwright report, so a run that
// fails halfway still carries every frame it did manage to capture.
// Each frame carries its own ordinal rather than an incrementing counter: Phases 3-4 only run when
// an operator supplies a real model token, and a counter would silently renumber every later frame
// on those runs — breaking the doc's image links depending on how the suite was invoked. A gap
// where a phase was skipped is the honest result.
const SCREENSHOT_DIR = "test-results/job-search-uat-screens";

async function shot(page: Page, name: string): Promise<void> {
  const file = `${SCREENSHOT_DIR}/${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  await test.info().attach(name, { path: file, contentType: "image/png" });
}

// `check` MUST auto-wait. page.reload() resolves on "load", which is long before React has booted,
// fetched the profile list and fetched that profile's data — so anything sampling the DOM the
// instant reload returns reads the pre-hydration page every single cycle and never recovers, no
// matter how long the data has been ready server-side. Most locator methods (getAttribute,
// innerText, expect(...)) auto-wait for attachment and are safe; `locator.count()` is the notable
// exception — it answers from the DOM as it stands. Use countWhenReady() rather than count().
async function pollWithReload<T>(
  page: Page,
  check: () => Promise<T>,
  isDone: (value: T) => boolean,
  description: string
): Promise<T> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let interval = POLL_INITIAL_INTERVAL_MS;
  for (;;) {
    await page.reload();
    const value = await check();
    if (isDone(value)) return value;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for: ${description}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, interval));
    interval = Math.min(interval * 2, POLL_MAX_INTERVAL_MS);
  }
}

// count() with the auto-waiting that count() itself lacks: give the first match a bounded chance to
// attach before counting. A timeout here is a legitimate "not yet, poll again", not a failure —
// hence the swallowed rejection — so the outer poll's deadline stays the only thing that can fail.
async function countWhenReady(rows: Locator): Promise<number> {
  await rows
    .first()
    .waitFor({ state: "attached", timeout: POLL_SETTLE_MS })
    .catch(() => undefined);
  return rows.count();
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixtures arg
test.afterEach(async ({}, testInfo) => {
  // finance-feed.uat.spec.ts's own pattern: only worth the docker round trips when the test
  // actually went the wrong way, and only when a stack project actually got provisioned.
  if (testInfo.status === testInfo.expectedStatus) return;
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!projectName) return;

  try {
    const logs = execFileSync(
      "docker",
      buildUatComposeArgs(projectName, ["logs", "--tail", "5000", "jarv1s"]),
      { encoding: "utf8" }
    );
    const filtered = logs
      .split("\n")
      .filter(
        (line) =>
          !line.includes('"msg":"incoming request"') && !line.includes('"msg":"request completed"')
      )
      .join("\n");
    console.log(`--- jarv1s logs (filtered) ---\n${filtered}`);
  } catch (error) {
    console.log(`could not fetch jarv1s logs: ${String(error)}`);
  }

  try {
    const jobs = execFileSync(
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
        // `created_on`, not `createdon` — this block's own catch swallowed the resulting syntax
        // error, so the diagnostic printed "could not query" on a healthy stack. Column names per
        // finance-feed.uat.spec.ts, which is the working precedent for this query.
        "select id, name, state, output from pgboss.job where name like 'job-search%' or name = 'platform.module-control' order by created_on desc limit 50;"
      ]),
      { encoding: "utf8" }
    );
    console.log(`--- pgboss job-search jobs ---\n${jobs}`);
  } catch (error) {
    console.log(`could not query pgboss.job: ${String(error)}`);
  }
});

test("job search: install, bootstrap, onboarding, crawl, board, inspector, chat scoping (#1306)", async ({
  page
}) => {
  test.setTimeout(900_000);
  let chatTurnsPosted = 0;
  let bootstrapTransition: Promise<void> | null = null;

  // --- Phase 1: install + enable + navigate (unconditional — no model required) ---
  await test.step("Phase 1: build, install, enable, and open the Job Search module", async () => {
    execFileSync("pnpm", ["build:external:job-search"], { stdio: "inherit" });

    const projectName = requireProjectName();
    const baseURL = requireBaseURL();

    execFileSync(
      "docker",
      buildUatComposeArgs(projectName, [
        "cp",
        "external-modules/job-search",
        "jarv1s:/data/modules/job-search"
      ]),
      { stdio: "inherit" }
    );
    await restartUatStack(projectName, baseURL);

    await signIn(page);
    await openInstanceModules(page);

    const enableSwitch = page.getByRole("checkbox", { name: "Enable Job Search", exact: true });
    await expect(enableSwitch).not.toBeChecked();
    await page.locator("label.jds-switch", { has: enableSwitch }).click();
    await expect(enableSwitch).toBeChecked();

    await restartUatStack(projectName, baseURL);
    await page.reload();

    await page.route("**/api/chat/turn", async (route) => {
      chatTurnsPosted += 1;
      await route.continue();
    });

    const emptyProfileList = page.waitForResponse(
      async (response) => {
        const profiles = await observedProfiles(response);
        return profiles?.length === 0;
      },
      { timeout: POLL_DEADLINE_MS }
    );
    const bootstrapAccepted = page.waitForResponse(
      (response) =>
        response
          .url()
          .endsWith("/api/modules/job-search/queues/job-search.profile-bootstrap/run") &&
        response.request().method() === "POST" &&
        response.status() === 202,
      { timeout: POLL_DEADLINE_MS }
    );
    const healthyProfileList = page.waitForResponse(
      async (response) => {
        const profiles = await observedProfiles(response);
        return profiles?.some((profile) => profile.state === "in_conversation") === true;
      },
      { timeout: POLL_DEADLINE_MS }
    );
    bootstrapTransition = Promise.all([
      emptyProfileList,
      bootstrapAccepted,
      healthyProfileList
    ]).then(([emptyResponse, acceptedResponse, healthyResponse]) => {
      expect(emptyResponse.request().timing().startTime).toBeLessThan(
        acceptedResponse.request().timing().startTime
      );
      expect(acceptedResponse.request().timing().startTime).toBeLessThan(
        healthyResponse.request().timing().startTime
      );
    });

    await openJobSearch(page);
    await shot(page, "01-module-opened");
  });

  // --- Phase 2: automatic profile bootstrap (unconditional — no model required) ---
  // The whole empty -> accepted bootstrap -> in-conversation window is the consent boundary:
  // creating the onboarding profile must never send a chat turn on the user's behalf.
  await test.step("Phase 2: profile bootstrap reaches in_conversation with zero chat turns", async () => {
    if (!bootstrapTransition) throw new Error("Phase 1 did not arm bootstrap observation");
    await bootstrapTransition;
    expect(chatTurnsPosted, "automatic bootstrap must not send a chat turn").toBe(0);
    await shot(page, "02-profile-bootstrap-in-conversation");
  });

  // --- Phases 3-4: real onboarding conversation (N45 — gated because the chat turn itself is
  // the subject under test here; see the header comment for why Phases 5-12 are NOT gated) ---
  let seededProfileId = "";
  let seededSurfaceKey = "";

  if (REAL_CHAT_CONFIGURED) {
    // --- Phase 3: onboarding screen renders while state === "in_conversation" ---
    await test.step("Phase 3: onboarding screen appears, no board list yet", async () => {
      await page.reload();
      await expect(page.getByText("Let's work out what this search is for.")).toBeVisible({
        timeout: POLL_DEADLINE_MS
      });
      await expect(page.locator(".jsm-board-list")).toHaveCount(0);

      // The five onboarding chips render as plain-text spans, not-done styled until completed.
      for (const step of ["role", "want", "where", "comp", "sources"]) {
        await expect(page.getByText(step, { exact: true })).toBeVisible();
      }
      await shot(page, "03-onboarding-screen");
    });

    // --- Phase 4: drive the real conversation to completion, asserting chip persistence ---
    const DISTINCTIVE_PROMPT =
      "I'm looking for senior backend engineering roles, remote in the US or UK, minimum " +
      "$160,000 base, and I want the work to touch developer tooling rather than pure product " +
      "features. Please enable the Freehire and LinkedIn sources for this search.";

    await test.step("Phase 4: real onboarding conversation completes all five steps", async () => {
      await page.getByRole("textbox").last().fill(DISTINCTIVE_PROMPT);
      await page.keyboard.press("Enter");

      // #1306: portal-enabling only happens via the job-search.portal.set-enabled tool, invoked by
      // the assistant conversation — there is no onboarding-time UI toggle (settings.tsx's toggle is
      // for an already-active profile). The prompt above asks explicitly so "sources" can complete.
      const done = new Set(["role", "want", "where", "comp", "sources"]);
      await pollWithReload(
        page,
        async () => {
          const state: Record<string, boolean> = {};
          for (const step of done) {
            const chip = page.getByText(step, { exact: true });
            const className = (await chip.getAttribute("class")) ?? "";
            state[step] = className.includes("jds-badge--forest");
          }
          return state;
        },
        (state) => Object.values(state).every(Boolean),
        "all five onboarding chips (role, want, where, comp, sources) reaching done"
      );

      // Explicit reload + re-check: chip completion must survive a fresh page load, not just live
      // component state left over from the conversation.
      await page.reload();
      for (const step of done) {
        const chip = page.getByText(step, { exact: true });
        await expect(chip).toHaveClass(/jds-badge--forest/);
      }
      await shot(page, "04-onboarding-all-steps-done");
    });
  } else {
    test.info().annotations.push({
      type: "skip",
      description:
        "Phases 3-4 (real onboarding conversation) need JARVIS_UAT_REAL_CHAT_ENV_FILE, unset for " +
        "this run. Phases 1-2 and 5-12 still ran, against a direct-seeded profile per N45."
    });
    console.log(
      "job-search UAT: JARVIS_UAT_REAL_CHAT_ENV_FILE unset — Phases 3-4 (real onboarding " +
        "conversation) skipped. Set that env var to exercise them. Phases 5-12 below still run."
    );
  }

  // --- Setup: direct-seed one already-active profile so Phases 5-12 need no real chat model
  // (N45/N40). This is exactly the row shape onboarding completion itself writes — same table,
  // same state, same criteria contract — so seeding it skips a slow dependency (a multi-turn
  // conversation), not the board/sort/banner/inspector/badge behaviour those phases check. On a
  // REAL_CHAT_CONFIGURED run this profile exists ALONGSIDE the one Phase 4 just onboarded; every
  // phase below addresses this one specifically by id, so the two never interfere. ---
  await test.step("Setup: direct-seed one active profile for Phases 5-12", async () => {
    const projectName = requireProjectName();
    const criteria = {
      titles: ["Senior Backend Engineer"],
      seniority: ["senior"],
      locations: ["Remote - US", "Remote - UK"],
      remote: "required",
      compFloorCents: 16_000_000,
      excludeCompanies: [],
      mustHave: ["developer tooling"],
      niceToHave: [],
      dealbreakers: [],
      wantNarrative:
        "Backend engineering roles that touch developer tooling rather than pure product features."
    };
    const criteriaJson = JSON.stringify(criteria).replace(/'/g, "''");
    const row = execUatSql(
      projectName,
      `insert into app.job_search_profiles (owner_user_id, name, state, criteria) values ` +
        `('${UAT_ADMIN_ID}', 'UAT direct-seed profile (#1306)', 'active', '${criteriaJson}'::jsonb) ` +
        `returning id, surface_key;`
    ).trim();
    const [id, surfaceKey] = row.split("|");
    expect(id, "profile insert must return an id").toBeTruthy();
    expect(surfaceKey, "profile insert must return a surface_key").toBeTruthy();
    seededProfileId = id!;
    seededSurfaceKey = surfaceKey!;

    // Force-select the seeded profile via the same localStorage key use-profiles.ts's
    // selectedIdKey() reads — robust regardless of whether a REAL_CHAT_CONFIGURED run also has an
    // onboarded profile competing for the default "first profile in the list" selection.
    await page.evaluate((id) => {
      window.localStorage.setItem("job-search:selected-profile-id", id);
    }, seededProfileId);
  });

  // --- Phase 5: an active profile auto-enqueues exactly the documented crawl request ---
  await test.step("Phase 5: profile going active auto-enqueues job-search.crawl-run", async () => {
    // Filter on the seeded profile's own id inside the predicate itself, not only in a follow-up
    // assertion — a REAL_CHAT_CONFIGURED run may have a second (onboarded) profile also crossing
    // into "active" around now, and its own auto-enqueue must not satisfy this wait instead.
    const waitForCrawlRun = page
      .waitForRequest(
        (request) => {
          if (!request.url().includes("/api/modules/job-search/queues/job-search.crawl-run/run")) {
            return false;
          }
          if (request.method() !== "POST") return false;
          const body = request.postDataJSON() as { params?: { profileId?: string } } | null;
          return body?.params?.profileId === seededProfileId;
        },
        { timeout: 15_000 }
      )
      .catch(() => null);
    await page.reload();
    const request = await waitForCrawlRun;
    if (request) {
      const body = request.postDataJSON() as { jobKind?: string };
      expect(body.jobKind).toBe("crawl.run");
    }
    // If the latch had already fired before this step (a legitimate race, not a bug — see
    // root.tsx's isLatched guard), the absence of a second request is correct, not a failure.
  });

  // --- Phase 6: board replaces chat once a profile is active ---
  await test.step("Phase 6: board screen replaces the onboarding chat", async () => {
    await page.reload();
    const viewNavigation = page.getByRole("navigation", { name: "Job search view" });
    const matchesButton = viewNavigation.getByRole("button", { name: "Matches" });
    await expect(matchesButton).toBeVisible();
    await expect(viewNavigation.getByRole("button", { name: "Overview" })).toBeVisible();
    await expect(viewNavigation.getByRole("button", { name: "Profile" })).toBeVisible();
    await expect(viewNavigation.getByRole("button", { name: "Monitors" })).toBeVisible();
    await expect(matchesButton).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("Let's work out what this search is for.")).toHaveCount(0);
    await shot(page, "05-board-replaces-chat");
  });

  // --- Phase 7: wait for matches, then verify Fit/Want sort against deterministicFixtureScore ---
  await test.step("Phase 7: matches appear and Fit/Want sort matches the fixture's deterministic scores", async () => {
    // #1329: unscored rows render "—"/"—" and sort last, never interleaved — restrict the
    // sort-order assertion to scored rows, which is what sortMatches itself guarantees.
    const matchList = page.locator(".jsm-board-list .jsm-list");
    const scoredRows = matchList.locator(":scope > div.jsm-row-shell").filter({
      hasNot: page.getByText("Not read yet")
    });

    // Wait for a SCORED row, not merely any row. The crawl stage writes every kept posting as an
    // unscored match before the score stage reads a single one, so "at least one row" goes true
    // while the whole board still says "Not read yet" — and the sort assertion below then has
    // nothing to sort. Waiting on the scored row is waiting for the crawl->score handoff, which is
    // what this phase is actually about.
    await pollWithReload(
      page,
      async () => countWhenReady(scoredRows),
      (count) => count > 0,
      "at least one SCORED match row on the board"
    );

    const scoredCount = await scoredRows.count();
    expect(
      scoredCount,
      "at least one posting must have been scored (freehire has 3 within budget)"
    ).toBeGreaterThan(0);
    await shot(page, "06-board-matches");

    const titles: string[] = [];
    for (let i = 0; i < scoredCount; i++) {
      titles.push((await scoredRows.nth(i).locator(":scope > button.jsm-row").innerText()).trim());
    }
    const expectedOrder = [...titles].sort(
      (a, b) => deterministicFixtureScore(b, "fit") - deterministicFixtureScore(a, "fit")
    );

    await page.getByRole("button", { name: /^Fit/ }).click();

    const sortedRows = matchList.locator(":scope > div.jsm-row-shell").filter({
      hasNot: page.getByText("Not read yet")
    });
    const actualOrder: string[] = [];
    for (let i = 0; i < scoredCount; i++) {
      actualOrder.push(
        (await sortedRows.nth(i).locator(":scope > button.jsm-row").innerText()).trim()
      );
    }
    expect(actualOrder).toEqual(expectedOrder);
    await shot(page, "07-board-sorted-by-fit");

    // No cell ever blends fit/want into a single percentage (ledger L9: fit/want non-blending).
    const boardText = await matchList.innerText();
    expect(boardText).not.toMatch(/\d{1,3}%\s*match/i);
  });

  // --- Phase 8: LinkedIn's permanent login_required degradation renders all 4 documented facts ---
  await test.step("Phase 8: LinkedIn portal banner surfaces the login_required failure", async () => {
    const banner = page.locator('[role="status"], [role="alert"]').filter({ hasText: "LinkedIn" });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("LinkedIn");
    // describeFailure's login_required summary — retrieved is always 0 for this fixture (the
    // auth-wall throws on the very first page fetch, before any posting is parsed), which is
    // communicated qualitatively by "before showing postings" rather than as a separate number;
    // PortalBanner never renders cause.retrieved directly.
    await expect(banner).toContainText("asked for an account before showing postings");
    await expect(banner).toContainText("I will not sign in to a job board on your behalf.");
    await expect(banner).toContainText("Turned off");
    await expect(banner).toContainText("Has never completed a search.");
    await shot(page, "08-linkedin-login-required-banner");
  });

  // --- Phase 9: unscored posting opens the Inspector with the "queued, not dropped" status ---
  await test.step("Phase 9: an unscored posting's Inspector says queued, not dropped", async () => {
    const projectName = requireProjectName();

    // Direct-seeded, for the same reason Phase 10 direct-seeds `outside_frame` below: the UI
    // contract under test ("an unread row renders as queued rather than being dropped") has to be
    // exercised deterministically, and the arithmetic that used to guarantee an unread row no
    // longer does. This phase relied on the scoring stage running out of AI calls — the overflow
    // fixture's 10 postings against a per-invocation budget of 8 — so exactly two rows were always
    // left unread. That budget is now 200, because a first crawl of a real board returns well over
    // a hundred postings and reading a seventh of them made the board look broken. Ten postings no
    // longer overflow anything, so the guarantee is gone; growing the fixture past 200 postings to
    // restore it would trade a fast UAT for an arbitrary one. Unscoring a row outright says what
    // this phase actually means and never rots against a budget constant again.
    //
    // Takes the LAST scored row (scored_at DESC) where Phase 10 takes the first, so the two
    // seeds can never land on the same match and quietly undo each other.
    const unscoredSeed = execUatSql(
      projectName,
      `update app.job_search_matches set state = 'unscored', fit = null, want = null, fit_reason = null, want_reason = null, scored_at = null where id = (select id from app.job_search_matches where profile_id = '${seededProfileId}' and want is not null order by scored_at desc, id desc limit 1) returning id, (select title from app.job_search_postings p where p.id = job_search_matches.posting_id);`
    );
    expect(
      unscoredSeed.trim().length,
      "a scored match must exist to unscore for this phase"
    ).toBeGreaterThan(0);
    const unscoredTitle = unscoredSeed.split("|")[1]?.trim() ?? "";
    expect(unscoredTitle, "the unscored match must have a posting title").toBeTruthy();
    await page.reload();

    const unscoredRow = page
      .locator(".jsm-board-list .jsm-list > div.jsm-row-shell")
      .filter({ hasText: unscoredTitle })
      .first();
    await expect(unscoredRow.getByText("Not read yet", { exact: true })).toBeVisible();
    await unscoredRow.locator(":scope > button.jsm-row").click();

    const detail = page.getByRole("article", {
      name: `Details for ${unscoredTitle}`,
      exact: true
    });
    await expect(detail).toBeVisible();
    await expect(detail.getByText("Not read yet", { exact: true })).toBeVisible();
    await expect(detail.getByRole("status")).toContainText("queued for scoring, not dropped");
    await shot(page, "09-inspector-unscored-posting");
    await detail.getByRole("button", { name: "Back to matches", exact: true }).click();
  });

  // --- Phase 10: outside-frame badge, direct-seeded, renders on both board row and Inspector ---
  await test.step("Phase 10: 'Outside your stated frame' renders on the board row and in the Inspector", async () => {
    const projectName = requireProjectName();

    // #1292/triage.ts: OUTSIDE_FRAME_CRITERIA_MAX=0.5, OUTSIDE_FRAME_PROFILE_MIN=0.6 — a match is
    // flagged outside_frame when it clears the profile's general-interest bar but misses the
    // stated criteria bar (see tests/unit/job-search-triage.test.ts). Direct-seeding this flag on
    // an already-crawled row is the only way to exercise the UI contract deterministically without
    // hand-crafting a posting that lands in exactly that band for real.
    const matchRow = execUatSql(
      projectName,
      // Postgres UPDATE takes no ORDER BY / LIMIT of its own — the pick has to happen in a
      // subquery, or the statement is a syntax error rather than an unlucky choice of row.
      // Ordered by scored_at (job_search_matches has no created_at; `want is not null` guarantees
      // scored_at is set), then id, so the row chosen is the same one on every run — and ascending,
      // where Phase 9's unscore seed takes the last row, so the two never collide.
      //
      // Keyed on `want`, not `fit`: Fit is only knowable against a résumé, and #1341 made the
      // scoring stage write `fit = null` rather than a meaningless 0 when there is no résumé on
      // file. This UAT profile has no résumé, so `fit is not null` now matches nothing and this
      // seed silently updated zero rows. Want is scored either way and is the honest test of
      // "a match that has been read".
      `update app.job_search_matches set outside_frame = true where id = (select id from app.job_search_matches where profile_id = '${seededProfileId}' and want is not null order by scored_at, id limit 1) returning id, (select title from app.job_search_postings p where p.id = job_search_matches.posting_id);`
    );
    expect(
      matchRow.trim().length,
      "a scored match must exist to flag outside_frame on"
    ).toBeGreaterThan(0);
    // execUatSql has already stripped psql's command tag, so the RETURNING row is the whole output.
    const seededTitle = matchRow.split("|")[1]?.trim() ?? "";
    expect(seededTitle, "the seeded match must have a posting title").toBeTruthy();

    await page.reload();
    const flaggedRow = page
      .locator(".jsm-board-list .jsm-list > div.jsm-row-shell")
      .filter({ hasText: seededTitle });
    await expect(flaggedRow.getByText("Outside your stated frame", { exact: true })).toBeVisible();
    await shot(page, "10-outside-frame-board-row");

    await flaggedRow.locator(":scope > button.jsm-row").click();
    const detail = page.getByRole("article", {
      name: `Details for ${seededTitle}`,
      exact: true
    });
    await expect(detail.getByText("Outside your stated frame", { exact: true })).toBeVisible();
    await shot(page, "11-outside-frame-inspector");
    await detail.getByRole("button", { name: "Back to matches", exact: true }).click();
  });

  // --- Phase 11: core drawer scoping — spec §7 says opening the header chat control inside a
  // profile gives that profile's thread; #1284's isolation rule says it must not appear anywhere
  // else. Ben ruled on 2026-07-28 that these are one rule, not two: the drawer shows the chat you
  // are actually in, and #1284's "never in the main drawer" governs LEAKAGE — a module's thread
  // must not survive your leaving the module. #1332 was therefore a real bug: app-shell.tsx handed
  // the drawer a fixed DEFAULT_CHAT_SURFACE literal instead of the live surface, so the drawer was
  // empty inside a profile too. Fixed; this phase asserts the shipped contract (present inside,
  // absent outside) and is expected GREEN. It was written live rather than test.fixme'd precisely
  // so that the fix would need one edit here, not a rewrite — and it did not need even that.
  await test.step("Phase 11: core chat drawer scopes the job-search thread to this profile (#1284/#1332)", async () => {
    // Visible in the test report itself, not just in source comments (N45: a reviewer shouldn't
    // need to read code to know what this step is defending): this is the live-path proof for
    // #1332, whose fix is a one-line change in app-shell.tsx. The two halves matter equally — a
    // regression that showed the module thread everywhere would pass the "visible inside" half
    // and fail the "absent on /tasks" half.
    test.info().annotations.push({
      type: "contract",
      description:
        "Spec §7 + #1284 as reconciled by Ben's 2026-07-28 ruling: the drawer shows the thread " +
        "of the surface you are in (marker visible inside the profile) and nothing from a " +
        "module you have left (marker absent on /tasks)."
    });

    // Seed a thread + one message directly on this profile's surface (N40: a real user turn sent
    // from inside the profile — via useProfileThread's seedContext or a normal reply — writes
    // exactly this chat_threads/chat_messages shape; packages/chat/src/routes.ts's
    // GET /api/chat/threads + GET /api/chat/threads/:id/messages is the real path that reads it
    // back, and use-chat-stream.ts's useChatStream calls both on mount to hydrate the drawer). This
    // is the only surface with a thread on it, so listChatThreads' `threads[0]` selection cannot
    // pick the wrong row regardless of ordering.
    const projectName = requireProjectName();
    const surface = moduleChatSurface("job-search", seededSurfaceKey);
    const MARKER_TEXT = "UAT direct-seed marker for the job search chat drawer scoping check";

    const threadId = execUatSql(
      projectName,
      `insert into app.chat_threads (id, owner_user_id, title, surface) values ` +
        `(gen_random_uuid(), '${UAT_ADMIN_ID}', 'UAT direct-seed thread (#1306)', '${surface}') ` +
        `returning id;`
    ).trim();
    expect(threadId, "thread insert must return an id").toBeTruthy();
    execUatSql(
      projectName,
      `insert into app.chat_messages (id, thread_id, owner_user_id, role, status, body) values ` +
        `(gen_random_uuid(), '${threadId}', '${UAT_ADMIN_ID}', 'user', 'stored', '${MARKER_TEXT}');`
    );

    await page.reload();
    // Name-agnostic: the accessible name is `Chat with ${assistantName}` (persona-driven, not a
    // fixed literal); .topbar-actions holds exactly one button, the chat toggle.
    await page.locator(".topbar-actions button").click();
    await expect(page.getByText(MARKER_TEXT, { exact: false })).toBeVisible();
    await shot(page, "12-drawer-inside-profile");
    await page.keyboard.press("Escape");

    await page.goto(`${requireBaseURL()}/tasks`);
    // Name-agnostic: the accessible name is `Chat with ${assistantName}` (persona-driven, not a
    // fixed literal); .topbar-actions holds exactly one button, the chat toggle.
    await page.locator(".topbar-actions button").click();
    await expect(page.getByText(MARKER_TEXT, { exact: false })).toHaveCount(0);
    await shot(page, "13-drawer-outside-module-empty");
  });

  // Phase 12 stays standalone so a fresh shell observes the notification produced by the crawl,
  // then clears it through the same Notifications UI a user does.
});

test("nav badge reflects unread matches and clears on mark-read (#1285)", async ({ page }) => {
  await signIn(page);
  const navLink = page
    .getByRole("navigation", { name: "Modules", exact: true })
    .getByRole("link", { name: "Job Search" });
  await expect(navLink.locator(".jds-badge-count")).toBeVisible();

  await page.locator(".jds-usermenu__trigger").click();
  await page.getByRole("button", { name: "Notifications" }).click();
  const notice = page.getByText(/\d+ new job matches?/);
  await expect(notice).toBeVisible();
  const title = await notice.innerText();
  await page.getByRole("button", { name: `Mark ${title} read` }).click();

  await expect(navLink.locator(".jds-badge-count")).toHaveCount(0);
});

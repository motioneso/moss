import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test, type Browser } from "@playwright/test";

// The Meals clickable prototype is static HTML under docs/. The suite's web server roots at
// apps/web and cannot serve it, so the pages open by file path.
const FOLDER = path.resolve("docs/superpowers/specs/assets/2026-10-09-meals");
const PROTOTYPE = pathToFileURL(path.join(FOLDER, "index.html")).href;

// Screenshots are a review aid. Full-page captures of every route at both widths take minutes, so
// they are saved only when MEALS_PROTOTYPE_SHOTS is set.
const SHOTS = process.env.MEALS_PROTOTYPE_SHOTS
  ? path.resolve("test-results/meals-prototype")
  : null;
const WIDTHS = [1440, 390] as const;
const AREAS = ["plan", "recipe", "list", "pantry", "household", "log", "settings"];
const STATES = ["empty", "loading", "error", "ai-off", "long"];

// A recipe page needs a recipe id, so recipe routes are checked through their samples only.
const STATE_AREAS = AREAS.filter((area) => area !== "recipe");

// A class the stylesheets never define still renders, as nothing. Runtime-built names such as a
// button variant escape a text search, so the rendered page is checked against every stylesheet.
// The masthead root is a bare hook the shared component also sets without styling.
const BARE_HOOKS = new Set(["jds-masthead"]);

function definedClasses(): Set<string> {
  const files = [
    path.resolve("apps/web/src/styles/tokens.css"),
    ...readdirSync(path.resolve("packages/ui/src/styles")).map((f) =>
      path.resolve("packages/ui/src/styles", f)
    ),
    ...readdirSync(path.resolve("apps/web/src/styles")).map((f) =>
      path.resolve("apps/web/src/styles", f)
    ),
    path.join(FOLDER, "prototype.css")
  ].filter((f) => f.endsWith(".css"));
  const names = new Set(BARE_HOOKS);
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").matchAll(/\.((?:jds|mls)-[a-zA-Z0-9_-]+)/g))
      names.add(match[1]!);
  }
  return names;
}

interface Visit {
  readonly name: string;
  readonly hash: string;
  readonly long?: boolean;
}

interface ReviewRoute {
  readonly path: string;
  readonly phase: number;
}

async function readRoutes(browser: Browser): Promise<ReviewRoute[]> {
  const page = await browser.newPage();
  await page.goto(PROTOTYPE);
  await page.waitForFunction(() => "MEALS_APP" in window);
  const routes = await page.evaluate(() =>
    (
      window as unknown as { MEALS_APP: { reviewRoutes: () => ReviewRoute[] } }
    ).MEALS_APP.reviewRoutes()
  );
  await page.close();
  return routes;
}

const areaOf = (route: ReviewRoute) => route.path.split("/")[0]!;

function visitsFor(routes: readonly ReviewRoute[], area: string): Visit[] {
  const query = (params: Record<string, string | number>) =>
    `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;
  const own = routes.filter((r) => areaOf(r) === area);
  const samples = own.map((r) => ({
    name: r.phase > 2 ? `${r.path}@phase${r.phase}` : r.path,
    hash: `#/${r.path}${r.phase > 2 ? query({ phase: r.phase }) : ""}`
  }));

  // Long names, lines and numbers on every route, so wrapping is checked everywhere.
  const long = own.map((r) => ({
    name: `${r.path}@long`,
    hash: `#/${r.path}${query(r.phase > 2 ? { state: "long", phase: r.phase } : { state: "long" })}`,
    long: true
  }));
  if (!STATE_AREAS.includes(area)) return [...samples, ...long];
  const states = STATES.map((state) => ({
    name: `${area}@${state}`,
    hash: `#/${area}${query({ state })}`,
    long: state === "long"
  }));
  return [
    ...samples,
    ...long,
    ...states,
    { name: `${area}@phase5`, hash: `#/${area}${query({ phase: 5 })}` }
  ];
}

test("every Meals prototype route belongs to a checked area", async ({ browser }) => {
  test.setTimeout(120_000);
  const routes = await readRoutes(browser);
  expect(routes.length).toBeGreaterThan(20);
  expect(routes.filter((r) => !AREAS.includes(areaOf(r))).map((r) => r.path)).toEqual([]);
});

// One test per area and width, so each has its own time budget and CI can run them in parallel.
for (const width of WIDTHS) {
  for (const area of AREAS) {
    test(`Meals prototype ${area} renders cleanly at ${width}px`, async ({ browser }) => {
      test.setTimeout(240_000);
      if (SHOTS) mkdirSync(SHOTS, { recursive: true });

      const defined = definedClasses();
      const visits = visitsFor(await readRoutes(browser), area);
      expect(visits.length).toBeGreaterThan(0);
      const context = await browser.newContext({ viewport: { width, height: 1000 } });

      for (const visit of visits) {
        await test.step(visit.name, async () => {
          const page = await context.newPage();
          const problems: string[] = [];
          page.on("console", (m) => {
            if (m.type() === "error") problems.push(`console: ${m.text()}`);
          });
          page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
          page.on("requestfailed", (r) => problems.push(`failed request: ${r.url()}`));

          await page.goto(`${PROTOTYPE}${visit.hash}`);
          const main = page.locator("#main");
          await expect(main).not.toBeEmpty();
          expect((await main.innerText()).trim().length).toBeGreaterThan(0);
          const used = await page.evaluate(() => [
            ...new Set(
              [...document.querySelectorAll("[class]")]
                .flatMap((el) => [...el.classList])
                .filter((c) => /^(jds|mls)-/.test(c))
            )
          ]);
          expect(
            used.filter((c) => !defined.has(c)),
            `${visit.name}: classes with no style`
          ).toEqual([]);
          if (visit.long) {
            const sideways = await page.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth
            );
            expect(sideways, `${visit.name}: page scrolls sideways`).toBeLessThanOrEqual(1);
          }
          if (SHOTS) {
            await page.screenshot({
              path: path.join(SHOTS, `${visit.name.replace(/[^a-z0-9@-]+/gi, "_")}-${width}.png`),
              fullPage: true
            });
          }

          expect(problems, visit.name).toEqual([]);
          await page.close();
        });
      }
      await context.close();
    });
  }
}

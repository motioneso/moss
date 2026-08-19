# Sports Broadsheet Grid Re-Architecture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the shipped `/sports` hairline reskin (PR #831) into a true multi-column newspaper layout — bold sans + mono, **no serif** — that respects the global light/dark theme and is honest to existing data, filling three new honestly-sourced server fields as it goes.

**Architecture:** Frontend lives in `packages/sports/src/web/*` and reads one contract, `SportsOverviewResponse` from `GET /api/sports/overview`. This milestone adds a small server slice: two new DTO fields (`Headline.summary`, `StandingsRow.qualificationNote`/`qualificationColor`) sourced from data ESPN already returns but the mappers currently drop, plus one lazy route (`GET /api/sports/standings?competitionKey=`) so the standings rail can show any supported league, not only followed ones. The page recomposes into a masthead → two tickers → editorial hero → 2-column broadsheet grid (Latest | Standings) → news band.

**Tech Stack:** React 18 + `@tanstack/react-query`, plain `<a href>` module links (`@jarv1s/module-web-sdk` `requestJson`), Fastify REST + fast-json-stringify schemas, shared TypeScript contracts in `packages/shared/src/sports-api.ts`, Vitest + `react-dom/server` `renderToString` string-assertion tests (no jsdom/RTL), CSS in `packages/sports/src/web/styles/*`.

## Global Constraints

- **No serif fonts anywhere.** The broadsheet feel is layout, hairlines, and heavy sans + mono — never a serif face. (Owner decision.)
- **No invented editorial backend.** No columnists, bylines, opinion, or fabricated copy. Every rendered string traces to a real `SportsOverviewResponse` (or new honestly-sourced) field.
- **Remove all explainer / "why you're seeing this" text.** Stop rendering the `rationale` field on every surface (hero, cards). Non-negotiable.
- **Respect the global theme (Option A).** Light/dark comes from the app theme; the redesign is "more layout than colors." No forced newsprint ground.
- **Design tokens only in CSS.** `pnpm check:design-tokens` forbids raw hex/`rgb(...)` in `packages/sports/src/web/styles/sports-*.css`. New editorial CSS uses `var(--…)` tokens exclusively. The raw ESPN qualification hex (`qualificationColor`) must **never** enter a `sports-*.css` file.
- **File-size gate: ≤1000 lines per source file (incl. CSS).** `sports-1.css` is at ~965 lines — all new editorial CSS goes in a **new** `packages/sports/src/web/styles/sports-5-editorial.css`. Extracting `StandingsRail` into its own file (Task 8) keeps `sports-page.tsx` under the cap.
- **Bounded server slice.** The only server changes permitted this milestone are the three task issues: #840 (`Headline.summary`), #841 (standings qualification fields), #842 (standings-by-league route). No other endpoint, table, or upstream fetch. No DB migration.
- **`toPublicHeadline` field-strip trap.** `sports-service.ts` `toPublicHeadline` destructures a fixed field list and rebuilds the object; any new `Headline` field not named there is silently stripped before the response. New fields must be added there (mirrors the `sourceTeamIds` strip).
- **fast-json-stringify strictness.** Response schemas use `additionalProperties: false`; a new DTO field must be added to BOTH the schema `properties` and `required`, or it is dropped from the serialized response.
- **Full local gate before every commit:** `pnpm lint && pnpm format:check && pnpm check:file-size && pnpm check:design-tokens && pnpm typecheck && pnpm test:unit`. (`pnpm verify:foundation` runs the whole gate.)
- **Documentation paths use `~/Jarv1s`,** never absolute local paths.

## File Structure

**Server (Tasks 1–3):**

- `packages/shared/src/sports-api.ts` — add fields to `Headline` + `StandingsRow` interfaces and their fast-json-stringify schemas; add `SportsStandingsResponse` + `sportsStandingsResponseSchema`.
- `packages/sports/src/source/espn-source.ts` — map `article.description` → `summary`; narrow `EspnStandingsEntry.note`; map note → qualification fields.
- `packages/sports/src/sports-service.ts` — pass `summary` through `toPublicHeadline`; add `getStandings(competitionKey)`.
- `packages/sports/src/routes.ts` — register `GET /api/sports/standings`.
- `packages/sports/src/web/sports-client.ts` + `query-keys.ts` — client fetch + query key for the standings route.
- `packages/sports/src/source/__fixtures__/nfl-news.json` — add `description` to articles.

**Frontend (Tasks 4–10):**

- `packages/sports/src/web/styles/sports-5-editorial.css` — **new** stylesheet: masthead, tickers, broadsheet grid, latest column, news band, legend, skeleton shapes.
- `packages/sports/src/web/sports-page.tsx` — recompose regions; masthead `PageHeader`; drop `rationale`; timezone match times; `BroadsheetGrid`.
- `packages/sports/src/web/sports-around-ticker.tsx` — **new** `AroundLeaguesTicker` (scores strip, scroll buttons, league-once separator).
- `packages/sports/src/web/sports-news.tsx` — `TopStoriesRail` → `LatestColumn` (2-up, thumbnails, no "RANKED"); `LeagueNewsSection` → `NewsBand` (summary blurb, continue-reading, league filter).
- `packages/sports/src/web/sports-standings.tsx` — **new** home for `StandingsRail` with all-league lazy fetch + qualification legend.

Tests are at the repo root under `tests/unit/` (not in the package): `tests/unit/sports-page.test.tsx`, `tests/unit/sports-routes.test.ts`, `tests/unit/sports-catalog.test.ts`.

**Reference (read before starting):** current `sports-page.tsx`, `sports-news.tsx`, `sports-ticker.tsx`, `locale.ts`, `sports-client.ts`, `query-keys.ts`; `source/espn-source.ts`, `sports-service.ts`, `routes.ts`, `source/catalog.ts`; the shared `sports-api.ts`. Test conventions: the `render()`/`makeOverview()` helpers at the top of `tests/unit/sports-page.test.tsx`, and the `makeDatasetClient`/`buildApp`/`app.inject` pattern in `tests/unit/sports-routes.test.ts`.

---

## Task 1: `Headline.summary` end-to-end (#840)

Add a short article blurb, sourced from ESPN's existing per-article `description` (currently dropped in the mapper), carried through to the DTO so the news band can render it.

**Files:**

- Modify: `packages/shared/src/sports-api.ts` (`Headline` interface; `headlineSchema`)
- Modify: `packages/sports/src/source/espn-source.ts` (article inline type ~264-271; `getHeadlines` map ~274-290)
- Modify: `packages/sports/src/sports-service.ts` (`toPublicHeadline` ~432-436)
- Modify: `packages/sports/src/source/__fixtures__/nfl-news.json` (add `description` to articles)
- Test: `tests/unit/sports-routes.test.ts`, `tests/unit/sports-page.test.tsx`

**Interfaces:**

- Produces: `Headline.summary: string` (empty string when the source has no description — never null, matching the `title`/`url` string convention). Consumed by Task 9 (`NewsBand`) and Task 7 (`LatestColumn` may reference it).

- [ ] **Step 1: Confirm the current field-strip and article shapes**

Run: `grep -n "toPublicHeadline" packages/sports/src/sports-service.ts` and `grep -n "description\|imageUrl\|articles" packages/sports/src/source/espn-source.ts`
Expected: locate `toPublicHeadline`'s destructure list and the `getHeadlines` article inline type + return object. Note the exact field order to match when editing.

- [ ] **Step 2: Write the failing route test** — append inside the `describe("sports routes", …)` block in `tests/unit/sports-routes.test.ts`, matching the file's existing `makeDatasetClient`/`buildApp` helpers (adapt the handler names to the real fakes in that file):

```ts
it("carries Headline.summary through the overview response (#840)", async () => {
  const app = buildApp(
    makeDatasetClient({
      news: () => [
        {
          id: "n1",
          competitionKey: "nfl",
          competitionLabel: "NFL",
          title: "Vikings clinch division",
          url: "https://example.test/n1",
          publishedAt: "2026-07-01T18:00:00Z",
          imageUrl: null,
          teamKeys: [],
          summary: "A late field goal sealed the NFC North.",
          sourceTeamIds: []
        }
      ]
    })
  );
  await app.ready();
  const res = await app.inject({ method: "GET", url: "/api/sports/overview" });
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain("A late field goal sealed the NFC North.");
  await app.close();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/sports-routes.test.ts -t "Headline.summary"`
Expected: FAIL — either a TS error that `summary` is missing on the source headline type, or the response omits the string because the schema/strip drops the unknown property.

- [ ] **Step 4: Add `summary` to the shared `Headline` interface** — in `packages/shared/src/sports-api.ts`, inside `interface Headline`, after the `imageUrl` line:

```ts
  readonly summary: string; // short article blurb from the source; "" when absent (#840)
```

- [ ] **Step 5: Add `summary` to `headlineSchema`** — same file. Add `"summary"` to the schema's `required` array and add to `properties`:

```ts
    summary: { type: "string" },
```

- [ ] **Step 6: Map the source description** — in `packages/sports/src/source/espn-source.ts`, widen the article inline type in `getHeadlines` (~264-271) by adding to the article item shape:

```ts
      description?: string;
```

Then in the returned headline object (~277-289) add, after `imageUrl`:

```ts
      summary: article.description ?? "",
```

(`SourceHeadline extends Headline`, so no separate source-type change is needed — the field is inherited.)

- [ ] **Step 7: Pass `summary` through the response boundary** — in `packages/sports/src/sports-service.ts`, `toPublicHeadline` (~432-436) destructures a fixed field list; a field not named here is stripped before it reaches the response. Add `summary` to both the destructure and the return object:

```ts
function toPublicHeadline(headline: Headline): Headline {
  const {
    id,
    competitionKey,
    competitionLabel,
    title,
    url,
    publishedAt,
    imageUrl,
    teamKeys,
    summary
  } = headline;
  return {
    id,
    competitionKey,
    competitionLabel,
    title,
    url,
    publishedAt,
    imageUrl,
    teamKeys,
    summary
  };
}
```

- [ ] **Step 8: Update the news fixture** — in `packages/sports/src/source/__fixtures__/nfl-news.json`, add a `"description": "…"` (one-sentence blurb) to each article object, so fixture-backed rendering shows real blurb text in Task 10 visual QA.

- [ ] **Step 9: Update the frontend test helper** — the shared `Headline` type now requires `summary`, so the `headline()` factory in `tests/unit/sports-page.test.tsx` fails typecheck. Add `summary: "",` to the object it returns (before any `...overrides`).

- [ ] **Step 10: Run tests to verify they pass**

Run: `pnpm vitest run tests/unit/sports-routes.test.ts tests/unit/sports-page.test.tsx`
Expected: PASS (all, including the new #840 test).

- [ ] **Step 11: Run the full gate**

Run: `pnpm lint && pnpm format:check && pnpm check:file-size && pnpm check:design-tokens && pnpm typecheck && pnpm test:unit`
Expected: all pass.

- [ ] **Step 12: Commit**

```bash
git add packages/shared/src/sports-api.ts packages/sports/src/source/espn-source.ts \
  packages/sports/src/sports-service.ts packages/sports/src/source/__fixtures__/nfl-news.json \
  tests/unit/sports-routes.test.ts tests/unit/sports-page.test.tsx
git commit -m "feat(sports): carry Headline.summary from ESPN description (#840)

User-facing: news stories on /sports can now show a one-line blurb."
```

---

## Task 2: Standings qualification fields (#841)

ESPN sends a per-row `note{description,color}` (e.g. `{"description":"UEFA Champions League","color":"#2a66d1"}`); the mapper currently collapses it to a bare `qualifies: entry.note != null`. Recover the description (for a legend) and the color (stored for a later design pass) without changing what `qualifies` means.

**Files:**

- Modify: `packages/shared/src/sports-api.ts` (`StandingsRow` ~34-44; `standingsRowSchema` ~222-247)
- Modify: `packages/sports/src/source/espn-source.ts` (`EspnStandingsEntry.note` ~51; `toStandingsRow` ~117-130)
- Test: `tests/unit/sports-routes.test.ts`, `tests/unit/sports-page.test.tsx`

**Interfaces:**

- Produces: `StandingsRow.qualificationNote: string | null` (the human label, e.g. "UEFA Champions League") and `StandingsRow.qualificationColor: string | null` (raw ESPN hex, carried for a future design pass — **not painted this milestone**). Consumed by Task 8 (`StandingsRail` legend).

- [ ] **Step 1: Write the failing route test** — append inside `describe("sports routes", …)`. Use the file's real standings fake handler name/shape (`makeDatasetClient` keyed by dataset); a followed `eng.1` competition drives standings into the overview:

```ts
it("carries standings qualification note + color through the overview (#841)", async () => {
  const app = buildApp(
    makeDatasetClient({
      standings: () => ({
        sections: [
          {
            label: null,
            rows: [
              {
                teamKey: "ars",
                name: "Arsenal",
                rank: 1,
                points: 40,
                wins: 12,
                losses: 2,
                draws: 4,
                winPercent: null,
                qualifies: true,
                qualificationNote: "UEFA Champions League",
                qualificationColor: "#2a66d1"
              }
            ]
          }
        ]
      })
    }),
    {
      follows: [
        { id: "f1", competitionKey: "eng.1", teamKey: null, createdAt: "2026-06-01T00:00:00.000Z" }
      ]
    }
  );
  await app.ready();
  const res = await app.inject({ method: "GET", url: "/api/sports/overview" });
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain("UEFA Champions League");
  expect(res.body).toContain("#2a66d1");
  await app.close();
});
```

(Adapt `buildApp`'s second arg to however the existing tests seed follows — match an existing test in the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/sports-routes.test.ts -t "qualification note"`
Expected: FAIL — schema drops the unknown properties, so the strings are absent (and/or TS rejects the extra fields on `StandingsRow`).

- [ ] **Step 3: Add fields to the shared `StandingsRow` interface** — in `packages/shared/src/sports-api.ts`, inside `interface StandingsRow`, after `qualifies`:

```ts
  readonly qualificationNote: string | null; // e.g. "UEFA Champions League"; null when none (#841)
  readonly qualificationColor: string | null; // raw source hex; carried for a later design pass (#841)
```

- [ ] **Step 4: Add fields to `standingsRowSchema`** — same file. Add `"qualificationNote"` and `"qualificationColor"` to `required`, and to `properties`:

```ts
    qualificationNote: { type: ["string", "null"] },
    qualificationColor: { type: ["string", "null"] },
```

- [ ] **Step 5: Narrow the source note type** — in `packages/sports/src/source/espn-source.ts`, change `EspnStandingsEntry.note` (~51) from `unknown` to a read shape:

```ts
  readonly note?: { readonly description?: string; readonly color?: string } | null;
```

- [ ] **Step 6: Map the note** — in `toStandingsRow` (~117-130), keep `qualifies` and add the two fields:

```ts
    qualifies: entry.note != null,
    qualificationNote: entry.note?.description ?? null,
    qualificationColor: entry.note?.color ?? null
```

- [ ] **Step 7: Update frontend test fixtures** — the shared `StandingsRow` now requires the two fields. Add `qualificationNote: null, qualificationColor: null` to every hand-written `StandingsRow` literal in `tests/unit/sports-page.test.tsx` (the `standingsGroup()` factory and any inline rows in the is-you/is-mine and paging tests). Add the same two null fields to any `StandingsRow` literal in `tests/unit/sports-routes.test.ts` outside the new test above.

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm vitest run tests/unit/sports-routes.test.ts tests/unit/sports-page.test.tsx`
Expected: PASS.

- [ ] **Step 9: Run the full gate**

Run: `pnpm lint && pnpm format:check && pnpm check:file-size && pnpm check:design-tokens && pnpm typecheck && pnpm test:unit`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add packages/shared/src/sports-api.ts packages/sports/src/source/espn-source.ts \
  tests/unit/sports-routes.test.ts tests/unit/sports-page.test.tsx
git commit -m "feat(sports): carry standings qualification note + color (#841)

User-facing: standings tables can now explain what a qualification marker means."
```

---

## Task 3: Standings-by-league route (#842)

The overview only fetches standings for followed competitions. Add a lazy route so the standings rail can request any of the eight catalog leagues on demand, without shipping all eight standings on every overview load.

**Files:**

- Modify: `packages/shared/src/sports-api.ts` (add `SportsStandingsResponse` type + `sportsStandingsResponseSchema`)
- Modify: `packages/sports/src/sports-service.ts` (add `getStandings(competitionKey)`)
- Modify: `packages/sports/src/routes.ts` (register `GET /api/sports/standings`)
- Modify: `packages/sports/src/web/sports-client.ts` (add `getStandingsByLeague`)
- Modify: `packages/sports/src/web/query-keys.ts` (add parameterized `standings` key)
- Test: `tests/unit/sports-routes.test.ts`

**Interfaces:**

- Consumes: `StandingsGroup` (existing), `catalogEntry` (existing), `this.cached<StandingsTable>("standings", …)` + `EMPTY_STANDINGS` (existing service internals).
- Produces:
  - Route `GET /api/sports/standings?competitionKey=<key>` → `200 { group: StandingsGroup }`, `400` on unknown key, `401` unauthorized.
  - `SportsService.getStandings(competitionKey: string): Promise<StandingsGroup>`.
  - Client `getStandingsByLeague(competitionKey: string): Promise<StandingsGroup>` (Task 8 consumes it).
  - Query key `sportsQueryKeys.standings(competitionKey)`.

- [ ] **Step 1: Confirm the overview standings assembly to mirror**

Run: `grep -n "standings\|cached\|EMPTY_STANDINGS\|standingsShape" packages/sports/src/sports-service.ts`
Expected: locate the overview standings mapping (~219-226) and the exact `StandingsGroup` field set (`competitionKey`, `competitionLabel`, `standingsShape`, `sections`). Match those field names in `getStandings`.

- [ ] **Step 2: Write the failing tests** — append inside `describe("sports routes", …)`:

```ts
it("GET /api/sports/standings returns one league's group (#842)", async () => {
  const app = buildApp(
    makeDatasetClient({
      standings: () => ({
        sections: [
          {
            label: "AFC East",
            rows: [
              {
                teamKey: "buf",
                name: "Buffalo Bills",
                rank: 1,
                points: null,
                wins: 11,
                losses: 3,
                draws: null,
                winPercent: 0.786,
                qualifies: true,
                qualificationNote: null,
                qualificationColor: null
              }
            ]
          }
        ]
      })
    })
  );
  await app.ready();
  const res = await app.inject({ method: "GET", url: "/api/sports/standings?competitionKey=nfl" });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  expect(body.group.competitionKey).toBe("nfl");
  expect(body.group.competitionLabel).toBe("NFL");
  expect(body.group.sections[0].label).toBe("AFC East");
  await app.close();
});

it("GET /api/sports/standings rejects an unknown competitionKey with 400 (#842)", async () => {
  const app = buildApp(makeDatasetClient({}));
  await app.ready();
  const res = await app.inject({
    method: "GET",
    url: "/api/sports/standings?competitionKey=xyz.nope"
  });
  expect(res.statusCode).toBe(400);
  await app.close();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run tests/unit/sports-routes.test.ts -t "standings"`
Expected: FAIL with 404 (route not registered).

- [ ] **Step 4: Add the response type + schema** — in `packages/shared/src/sports-api.ts`, after the follows response type:

```ts
export interface SportsStandingsResponse {
  readonly group: StandingsGroup;
}
```

and after `sportsFollowsResponseSchema`, add (reusing the existing `standingsGroupSchema`):

```ts
export const sportsStandingsResponseSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    required: ["competitionKey"],
    properties: {
      competitionKey: { type: "string", minLength: 1, maxLength: 100 }
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["group"],
      properties: {
        group: standingsGroupSchema
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;
```

(If `standingsGroupSchema` / `errorResponseSchema` are named differently in the file, use the existing names — grep first.)

- [ ] **Step 5: Add the service method** — in `packages/sports/src/sports-service.ts`, add a public method near `getOverview`, mirroring the overview standings assembly and reusing `cached`/`EMPTY_STANDINGS`:

```ts
  /** One league's standings, fetched on demand (#842). Never throws; degrades to empty sections. */
  async getStandings(competitionKey: string): Promise<StandingsGroup> {
    const state: DegradeState = { degraded: false };
    const table = await this.cached<StandingsTable>(
      "standings",
      { competitionKey },
      EMPTY_STANDINGS,
      state
    );
    const entry = catalogEntry(competitionKey);
    return {
      competitionKey,
      competitionLabel: entry?.label ?? competitionKey,
      standingsShape: entry?.standingsShape ?? "table",
      sections: table.sections
    };
  }
```

(Match the exact `DegradeState` type name and `StandingsGroup` field names used by `getOverview`; grep and copy them verbatim.)

- [ ] **Step 6: Register the route** — in `packages/sports/src/routes.ts`, import `sportsStandingsResponseSchema` alongside the other schema imports, and register after the overview route:

```ts
server.get(
  "/api/sports/standings",
  { schema: sportsStandingsResponseSchema },
  async (request, reply) => {
    try {
      await dependencies.resolveAccessContext(request);
      const { competitionKey } = request.query as { competitionKey: string };
      if (!catalogEntry(competitionKey)) {
        throw new HttpError(400, `Unknown competition: ${competitionKey}`);
      }
      const group = await service.getStandings(competitionKey);
      return { group };
    } catch (error) {
      return handleRouteError(error, reply);
    }
  }
);
```

(Use the exact `HttpError`/`handleRouteError`/`catalogEntry` symbols already imported in that file; the overview POST route already imports `catalogEntry` for its 400 check — mirror it.)

- [ ] **Step 7: Add the client fetch** — in `packages/sports/src/web/sports-client.ts`, add (mirroring `getSportsOverview`, importing `SportsStandingsResponse` + `StandingsGroup` from `@jarv1s/shared`):

```ts
export async function getStandingsByLeague(competitionKey: string): Promise<StandingsGroup> {
  const res = await requestJson<SportsStandingsResponse>(
    `/api/sports/standings?competitionKey=${encodeURIComponent(competitionKey)}`
  );
  return res.group;
}
```

- [ ] **Step 8: Add the query key** — in `packages/sports/src/web/query-keys.ts`, add to `sportsQueryKeys`:

```ts
  standings: (competitionKey: string) => ["sports", "standings", competitionKey] as const,
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `pnpm vitest run tests/unit/sports-routes.test.ts`
Expected: PASS (both new tests + all existing).

- [ ] **Step 10: Run the full gate**

Run: `pnpm lint && pnpm format:check && pnpm check:file-size && pnpm check:design-tokens && pnpm typecheck && pnpm test:unit`
Expected: all pass.

- [ ] **Step 11: Commit**

```bash
git add packages/shared/src/sports-api.ts packages/sports/src/sports-service.ts \
  packages/sports/src/routes.ts packages/sports/src/web/sports-client.ts \
  packages/sports/src/web/query-keys.ts tests/unit/sports-routes.test.ts
git commit -m "feat(sports): add standings-by-league route (#842)

User-facing: the standings panel can show any supported league, not just followed ones."
```

---

## Task 4: Editorial stylesheet scaffold + masthead

Create the new stylesheet, wire it into the bundle, and replace the plain page header with a broadsheet masthead. This task establishes the shared editorial primitives (`sp-col__kicker`, hairline rules, section eyebrows) the later frontend tasks reuse.

**Files:**

- Create: `packages/sports/src/web/styles/sports-5-editorial.css`
- Modify: the entry that imports the existing `sports-*.css` (grep — see Step 1)
- Modify: `packages/sports/src/web/sports-page.tsx` (`PageHeader`)
- Test: `tests/unit/sports-page.test.tsx`

**Interfaces:**

- Consumes: `useUserLocale()` + `formatDate(input, locale)` from `./locale.js`.
- Produces: CSS classes `sp-masthead`, `sp-masthead__title`, `sp-masthead__meta`, `sp-col__kicker`, `sp-eyebrow`, `sp-rule` — consumed by Tasks 5, 7, 8, 9. `PageHeader` renders `<header class="sp-masthead">` with a date line from the viewer locale.

- [ ] **Step 1: Locate the stylesheet import site**

Run: `grep -rn "sports-1.css\|sports-4-grid.css\|styles/sports" packages/sports/src`
Expected: the `import "./styles/sports-N.css";` lines (in a web entry — e.g. `packages/sports/src/web/index.ts` or the page). Note the file — Step 5 adds the new import there, immediately after the existing sports-CSS imports so cascade order is preserved.

- [ ] **Step 2: Write the failing test** — add to `describe("SportsPage", …)` in `tests/unit/sports-page.test.tsx`:

```ts
it("renders the broadsheet masthead", () => {
  const html = render(makeOverview());
  expect(html).toContain("sp-masthead");
  expect(html).toContain("sp-masthead__title");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/sports-page.test.tsx -t "masthead"`
Expected: FAIL (no `sp-masthead` in the output).

- [ ] **Step 4: Create the stylesheet** — `packages/sports/src/web/styles/sports-5-editorial.css`. Tokens only (no raw hex). Functional defaults; exact spacing/weights get tuned in the owner's later design pass. Before using a token name, grep `apps/web/src/styles/tokens.css` and substitute the nearest existing `--jds-*` token if a name below is absent — never introduce a raw value.

```css
/* Sports broadsheet editorial layer (#839). Tokens only — see tokens.css. No serif. */

.sp-masthead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-4);
  padding-bottom: var(--space-3);
  border-bottom: 2px solid var(--jds-border-strong, var(--jds-border));
}
.sp-masthead__title {
  font-family: var(--jds-font-sans);
  font-weight: 800;
  letter-spacing: -0.02em;
  font-size: var(--font-size-2xl, 1.75rem);
}
.sp-masthead__meta {
  font-family: var(--jds-font-mono);
  font-size: var(--font-size-xs, 0.75rem);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--jds-text-muted);
}

/* Reusable editorial primitives (consumed by Latest / Standings / News). */
.sp-col__kicker {
  font-family: var(--jds-font-mono);
  font-size: var(--font-size-xs, 0.75rem);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--jds-text-muted);
  margin-bottom: var(--space-2);
}
.sp-eyebrow {
  font-family: var(--jds-font-mono);
  font-size: var(--font-size-xs, 0.75rem);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--jds-text-muted);
}
.sp-rule {
  border: 0;
  border-top: 1px solid var(--jds-border);
  margin: var(--space-3) 0;
}
```

- [ ] **Step 5: Import the stylesheet** — in the entry found in Step 1, add immediately after the last existing `sports-*.css` import (match the relative path to that file's location):

```ts
import "./styles/sports-5-editorial.css";
```

- [ ] **Step 6: Rewrite `PageHeader`** — in `packages/sports/src/web/sports-page.tsx`, replace the `PageHeader` component body with a masthead that reads the viewer locale for the date line:

```tsx
function PageHeader(): JSX.Element {
  const locale = useUserLocale();
  return (
    <header className="sp-masthead">
      <h1 className="sp-masthead__title">Sports</h1>
      <span className="sp-masthead__meta">{formatDate(new Date(), locale)}</span>
    </header>
  );
}
```

Ensure `formatDate` and `useUserLocale` are imported from `./locale.js` (extend the existing locale import).

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run tests/unit/sports-page.test.tsx`
Expected: PASS.

- [ ] **Step 8: Run the full gate** (design-tokens gate matters here)

Run: `pnpm lint && pnpm format:check && pnpm check:file-size && pnpm check:design-tokens && pnpm typecheck && pnpm test:unit`
Expected: all pass — in particular `check:design-tokens` confirms no raw hex entered the new CSS.

- [ ] **Step 9: Commit** (include the barrel/entry file from Step 1 in the `git add`)

```bash
git add packages/sports/src/web/styles/sports-5-editorial.css packages/sports/src/web/sports-page.tsx
git commit -m "feat(sports): broadsheet masthead + editorial stylesheet scaffold (#839)

User-facing: /sports gains a newspaper-style masthead with today's date."
```

---

## Task 5: Around-the-Leagues ticker

A second ticker under the followed-teams ticker: a horizontal scores strip across the leagues on the overview, with left/right scroll buttons that hide at each end, and each league label shown once at the start of its group (the next league's label acts as the separator).

**Files:**

- Create: `packages/sports/src/web/sports-around-ticker.tsx`
- Modify: `packages/sports/src/web/sports-page.tsx` (compose `<AroundLeaguesTicker>` after `<SportsTicker>`)
- Modify: `packages/sports/src/web/styles/sports-5-editorial.css` (ticker styles)
- Test: `tests/unit/sports-page.test.tsx`

**Interfaces:**

- Consumes: `overview.scoreboard: ScoreboardGroup[]` (each `{ competitionKey, competitionLabel, games }`), `GameSummary`, `useUserLocale`/`formatTime` from `./locale.js`, `ChevronLeft`/`ChevronRight` from `lucide-react`. (Confirm the scoreboard field name against the DTO in Step 1 — use the real one.)
- Produces: `AroundLeaguesTicker({ groups }: { groups: readonly ScoreboardGroup[] }): JSX.Element | null` — renders `null` when `groups` is empty.

- [ ] **Step 1: Confirm the scoreboard shape + game score fields**

Run: `grep -n "ScoreboardGroup\|interface GameSummary\|shortName\|score" packages/shared/src/sports-api.ts`
Expected: the exact `ScoreboardGroup` field carrying games, and the `GameSummary` team/score field names (`home`/`away`, `shortName`, `score`, `state`, `startsAt`, `statusDetail`). Use the real names in Step 3.

- [ ] **Step 2: Write the failing test** — add to `describe("SportsPage", …)`:

```ts
it("renders the around-the-leagues scores strip with one label per league group", () => {
  const html = render(
    makeOverview({
      scoreboard: [
        { competitionKey: "nfl", competitionLabel: "NFL", games: [liveGame()] },
        {
          competitionKey: "nba",
          competitionLabel: "NBA",
          games: [
            {
              ...liveGame(),
              id: "g2",
              competitionKey: "nba",
              state: "final",
              statusDetail: "Final"
            }
          ]
        }
      ]
    })
  );
  expect(html).toContain("sp-around");
  expect(html).toContain("sp-around__league"); // league label rendered once per group
  expect(html).toContain("Scroll left");
  expect(html).toContain("Scroll right");
});
```

(Match `makeOverview`'s real scoreboard key name from Step 1; adjust `liveGame()` overrides to the real `GameSummary` shape.)

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/sports-page.test.tsx -t "around-the-leagues"`
Expected: FAIL.

- [ ] **Step 4: Create the component** — `packages/sports/src/web/sports-around-ticker.tsx` (adjust the imported type/field names to the real DTO from Step 1):

```tsx
import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { GameSummary, ScoreboardGroup } from "@jarv1s/shared";

import { formatTime, useUserLocale, type LocaleSettingsDto } from "./locale.js";

function scoreLabel(game: GameSummary, locale: LocaleSettingsDto): string {
  if (game.state === "pre") return formatTime(game.startsAt, locale);
  const away = game.away.score ?? 0;
  const home = game.home.score ?? 0;
  return `${game.away.shortName} ${away}–${home} ${game.home.shortName}`;
}

export function AroundLeaguesTicker({
  groups
}: {
  readonly groups: readonly ScoreboardGroup[];
}): JSX.Element | null {
  const locale = useUserLocale();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  if (groups.length === 0) return null;

  function updateEdges(): void {
    const el = scrollRef.current;
    if (!el) return;
    setAtStart(el.scrollLeft <= 1);
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
  }

  function nudge(direction: -1 | 1): void {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.round(el.clientWidth * 0.8), behavior: "smooth" });
  }

  return (
    <section className="sp-around" aria-label="Scores around the leagues">
      <button
        type="button"
        className="sp-around__nav sp-around__nav--left"
        aria-label="Scroll left"
        hidden={atStart}
        onClick={() => nudge(-1)}
      >
        <ChevronLeft aria-hidden size={16} />
      </button>
      <div
        className="sp-around__scroll"
        ref={scrollRef}
        onScroll={updateEdges}
        tabIndex={0}
        role="group"
      >
        {groups.map((group) => (
          <div className="sp-around__group" key={group.competitionKey}>
            <span className="sp-around__league">{group.competitionLabel}</span>
            {group.games.map((game) => (
              <span className="sp-around__score" key={game.id}>
                {scoreLabel(game, locale)}
              </span>
            ))}
          </div>
        ))}
      </div>
      <button
        type="button"
        className="sp-around__nav sp-around__nav--right"
        aria-label="Scroll right"
        hidden={atEnd}
        onClick={() => nudge(1)}
      >
        <ChevronRight aria-hidden size={16} />
      </button>
    </section>
  );
}
```

The "league label once, next league is the separator" rule is structural: each `sp-around__group` opens with exactly one `sp-around__league`; scores follow with no repeated league label; the next group's label (styled with a leading divider in Step 6) separates them.

- [ ] **Step 5: Compose it in the page** — in `packages/sports/src/web/sports-page.tsx`, import `AroundLeaguesTicker` from `./sports-around-ticker.js`, and render it immediately after `<SportsTicker …>` in the main composition (use the real scoreboard prop name):

```tsx
<AroundLeaguesTicker groups={overview.scoreboard} />
```

- [ ] **Step 6: Add ticker styles** — append to `sports-5-editorial.css`:

```css
.sp-around {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  border-bottom: 1px solid var(--jds-border);
  padding: var(--space-2) 0;
}
.sp-around__scroll {
  display: flex;
  gap: var(--space-4);
  overflow-x: auto;
  scrollbar-width: none;
  flex: 1;
}
.sp-around__scroll::-webkit-scrollbar {
  display: none;
}
.sp-around__group {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding-left: var(--space-3);
  border-left: 1px solid var(--jds-border);
}
.sp-around__group:first-child {
  border-left: 0;
  padding-left: 0;
}
.sp-around__league {
  font-family: var(--jds-font-mono);
  font-size: var(--font-size-xs, 0.75rem);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--jds-text-muted);
  white-space: nowrap;
}
.sp-around__score {
  font-family: var(--jds-font-mono);
  font-size: var(--font-size-sm, 0.8125rem);
  white-space: nowrap;
}
.sp-around__nav {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--jds-surface);
  border: 1px solid var(--jds-border);
  border-radius: var(--radius-sm, 4px);
  color: var(--jds-text);
  cursor: pointer;
  padding: var(--space-1);
}
.sp-around__nav[hidden] {
  display: none;
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run tests/unit/sports-page.test.tsx`
Expected: PASS.

- [ ] **Step 8: Run the full gate**

Run: `pnpm lint && pnpm format:check && pnpm check:file-size && pnpm check:design-tokens && pnpm typecheck && pnpm test:unit`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add packages/sports/src/web/sports-around-ticker.tsx packages/sports/src/web/sports-page.tsx \
  packages/sports/src/web/styles/sports-5-editorial.css tests/unit/sports-page.test.tsx
git commit -m "feat(sports): around-the-leagues scores ticker (#839)

User-facing: /sports adds a scrollable scores strip across leagues, with arrows that appear only when there's more to see."
```

---

## Task 6: Timezone-aware match times

Match start times must render in the viewer's timezone and preferred clock (12/24h), not ESPN's pre-formatted `statusDetail`. Frontend-only: `GameSummary.startsAt` (raw ISO instant) already ships next to `statusDetail`, and `formatTime`/`useUserLocale` are already wired. Live ("Q3 4:12") and final ("FT") states keep `statusDetail` — those are game-clock strings, not instants.

**Files:**

- Modify: `packages/sports/src/web/sports-page.tsx` (`GameRow` pre-game branch ~370; hero status ~173)
- Test: `tests/unit/sports-page.test.tsx`

**Interfaces:**

- Consumes: `formatTime(startsAt, locale)` from `./locale.js`, `useUserLocale()`.

- [ ] **Step 1: Confirm the two render sites + DEFAULT_LOCALE**

Run: `grep -n "statusDetail\|useUserLocale\|state === \"pre\"\|startsAt" packages/sports/src/web/sports-page.tsx` and `grep -n "DEFAULT_LOCALE\|timezone\|dateFormat" packages/sports/src/web/locale.ts`
Expected: the pre-game branch in `GameRow` (~370) and the hero status (~173), plus `DEFAULT_LOCALE = {timezone:"America/Los_Angeles", region:"en-US", dateFormat:"24"}` (drives the expected value in Step 2).

- [ ] **Step 2: Write the failing test** — add to `describe("SportsPage", …)`. Pick a `startsAt` whose 24h America/Los_Angeles rendering is unambiguous and assert the raw status string is gone:

```ts
it("renders pre-game match times in a clock format, not the raw source status", () => {
  const preGame: GameSummary = {
    ...liveGame(),
    id: "g-pre",
    state: "pre",
    statusDetail: "SOURCE_PREGAME_STRING",
    startsAt: "2026-07-01T23:20:00Z",
    home: { ...liveGame().home, score: null },
    away: { ...liveGame().away, score: null }
  };
  const html = render(
    makeOverview({
      scoreboard: [{ competitionKey: "nfl", competitionLabel: "NFL", games: [preGame] }]
    })
  );
  expect(html).not.toContain("SOURCE_PREGAME_STRING");
  expect(html).toContain("16:20"); // 23:20Z → 16:20 America/Los_Angeles, 24h
});
```

(Match `makeOverview`'s real scoreboard key + `GameSummary` shape from Task 5 Step 1. If the hero also renders this game, ensure its status is asserted too.)

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/sports-page.test.tsx -t "clock format"`
Expected: FAIL — the raw `statusDetail` still renders.

- [ ] **Step 4: Swap the `GameRow` pre-game branch** — in `sports-page.tsx`, the status block (~361-372) renders `{game.statusDetail}` for the pre-game branch. Ensure `GameRow` has the locale (`const locale = useUserLocale();` at its top if absent), then change the pre-game branch to:

```tsx
{
  game.state === "pre" ? formatTime(game.startsAt, locale) : game.statusDetail;
}
```

Keep the live/final branches on `statusDetail`.

- [ ] **Step 5: Swap the hero status** — in the hero component (~161-203), apply the same rule (add `useUserLocale()` if the component doesn't already call it):

```tsx
{
  game.state === "pre" ? formatTime(game.startsAt, locale) : game.statusDetail;
}
```

- [ ] **Step 6: Confirm imports** — ensure `formatTime` and `useUserLocale` are in the `./locale.js` import in `sports-page.tsx`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run tests/unit/sports-page.test.tsx`
Expected: PASS.

- [ ] **Step 8: Run the full gate**

Run: `pnpm lint && pnpm format:check && pnpm check:file-size && pnpm check:design-tokens && pnpm typecheck && pnpm test:unit`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add packages/sports/src/web/sports-page.tsx tests/unit/sports-page.test.tsx
git commit -m "feat(sports): show match times in the viewer's timezone and clock (#839)

User-facing: upcoming game times now display in your own timezone and 12/24-hour preference."
```

---

## Task 8: Standings rail — all leagues + qualification legend

> **Ordering:** run this task **before** Task 7. Task 7's `BroadsheetGrid` imports `StandingsRail` from `./sports-standings.js`, which this task creates.

Extract `StandingsRail` into its own file (keeps `sports-page.tsx` under the 1000-line cap) and extend it: the league `<select>` now offers **all eight catalog leagues**, not just followed ones; selecting a league not present in `overview.standings` lazily fetches it via the #842 route; and a legend explains the qualification marker using `qualificationNote` (#841).

**Files:**

- Create: `packages/sports/src/web/sports-standings.tsx` (move `StandingsRail`, `recordLine`, `formatPct` out of `sports-page.tsx`)
- Modify: `packages/sports/src/web/sports-page.tsx` (remove the moved code; import from `./sports-standings.js`)
- Modify: `packages/sports/src/web/styles/sports-5-editorial.css` (legend styles)
- Test: `tests/unit/sports-page.test.tsx`

**Interfaces:**

- Consumes: `overview.standings: StandingsGroup[]`, `overview.followedTeams`, `SPORTS_CATALOG` (from `../source/catalog.js`), `getStandingsByLeague` (Task 3), `sportsQueryKeys.standings` (Task 3), `useQuery`.
- Produces: `StandingsRail({ groups, followedTeams }): JSX.Element` (same props as the current in-page component, exported from the new module).

- [ ] **Step 1: Read the current `StandingsRail`** — `grep -n "StandingsRail\|recordLine\|formatPct\|is-you\|is-mine\|sp-standings\|<select\|<option\|qualifies" packages/sports/src/web/sports-page.tsx`. Copy the existing component, its two helpers, and its is-you/is-mine pair-scoped marking logic verbatim as the starting point — the tests at the is-you/is-mine and paging sections assert this behavior and must keep passing.

- [ ] **Step 2: Write the failing tests** — add to `describe("SportsPage", …)`:

```ts
it("offers all catalog leagues in the standings selector, not only ones with data", () => {
  const html = render(makeOverview()); // overview has only one standings group
  expect(html).toContain(">NBA<");
  expect(html).toContain(">Premier League<");
});

it("renders a qualification legend from the row note (#841)", () => {
  const html = render(
    makeOverview({
      standings: [
        {
          competitionKey: "eng.1",
          competitionLabel: "Premier League",
          standingsShape: "table",
          sections: [
            {
              label: null,
              rows: [
                {
                  teamKey: "ars",
                  name: "Arsenal",
                  rank: 1,
                  points: 40,
                  wins: 12,
                  losses: 2,
                  draws: 4,
                  winPercent: null,
                  qualifies: true,
                  qualificationNote: "UEFA Champions League",
                  qualificationColor: "#2a66d1"
                }
              ]
            }
          ]
        }
      ],
      followedTeams: [{ competitionKey: "eng.1", teamKey: "ars" }]
    })
  );
  expect(html).toContain("sp-legend");
  expect(html).toContain("UEFA Champions League");
});
```

(Match the option labels to the real `SPORTS_CATALOG` `label` values; match `makeOverview`'s standings/followedTeams key names.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run tests/unit/sports-page.test.tsx -t "catalog leagues"`
Expected: FAIL (selector only lists leagues with data; no legend).

- [ ] **Step 4: Create `sports-standings.tsx`** — move `StandingsRail` + `recordLine` + `formatPct` into the new file, then extend `StandingsRail`. Port the existing row/table renderer into a local `StandingsTable` helper, preserving the is-you/is-mine semantics and the qualifying-row marker exactly. **Do not paint `qualificationColor`** — the marker uses a token; the raw hex stays in the DTO for a later design pass.

```tsx
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { FollowedTeamRef, StandingsGroup } from "@jarv1s/shared";

import { SPORTS_CATALOG } from "../source/catalog.js";
import { getStandingsByLeague } from "./sports-client.js";
import { sportsQueryKeys } from "./query-keys.js";

export function StandingsRail({
  groups,
  followedTeams
}: {
  readonly groups: readonly StandingsGroup[];
  readonly followedTeams: readonly FollowedTeamRef[];
}): JSX.Element {
  const byKey = useMemo(() => new Map(groups.map((g) => [g.competitionKey, g])), [groups]);
  const firstKey = groups[0]?.competitionKey ?? SPORTS_CATALOG[0].competitionKey;
  const [selectedKey, setSelectedKey] = useState(firstKey);
  const [sectionIndex, setSectionIndex] = useState(0);

  // If the selected league isn't in the overview payload, lazily fetch it (#842).
  const lazy = useQuery({
    queryKey: sportsQueryKeys.standings(selectedKey),
    queryFn: () => getStandingsByLeague(selectedKey),
    enabled: !byKey.has(selectedKey)
  });

  const group = byKey.get(selectedKey) ?? lazy.data ?? null;
  const sections = group?.sections ?? [];
  const safeIndex = Math.min(sectionIndex, Math.max(0, sections.length - 1));
  const section = sections[safeIndex] ?? null;

  function selectLeague(key: string): void {
    setSelectedKey(key);
    setSectionIndex(0);
  }

  const legendNotes = section
    ? Array.from(
        new Map(
          section.rows
            .filter((r) => r.qualificationNote)
            .map((r) => [r.qualificationNote as string, r])
        ).values()
      )
    : [];

  return (
    <section className="sp-standings" aria-label="Standings">
      <div className="sp-standings__head">
        <p className="sp-col__kicker">Standings</p>
        <select
          className="sp-standings__select"
          aria-label="Select standings league"
          value={selectedKey}
          onChange={(e) => selectLeague(e.target.value)}
        >
          {SPORTS_CATALOG.map((entry) => (
            <option key={entry.competitionKey} value={entry.competitionKey}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>

      {sections.length > 1 && section ? (
        <div className="sp-standings__pager">
          <button
            type="button"
            aria-label="Previous standings"
            disabled={safeIndex === 0}
            onClick={() => setSectionIndex((i) => Math.max(0, i - 1))}
          >
            <ChevronLeft aria-hidden size={16} />
          </button>
          <span className="sp-standings__count">{section.label ?? group?.competitionLabel}</span>
          <button
            type="button"
            aria-label="Next standings"
            disabled={safeIndex >= sections.length - 1}
            onClick={() => setSectionIndex((i) => Math.min(sections.length - 1, i + 1))}
          >
            <ChevronRight aria-hidden size={16} />
          </button>
        </div>
      ) : null}

      {section ? (
        <StandingsTable
          rows={section.rows}
          followedTeams={followedTeams}
          competitionKey={selectedKey}
        />
      ) : (
        <p className="sp-standings__empty">
          {lazy.isLoading ? "Loading standings…" : "No standings available."}
        </p>
      )}

      {legendNotes.length > 0 ? (
        <ul className="sp-legend" aria-label="Qualification key">
          {legendNotes.map((r) => (
            <li className="sp-legend__item" key={r.qualificationNote}>
              <span className="sp-legend__marker" aria-hidden />
              {r.qualificationNote}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
```

Then add the ported `StandingsTable` (rows renderer using `recordLine`/`formatPct` + is-you/is-mine marking + the qualifying-row marker class), keeping those helper signatures identical to the originals.

- [ ] **Step 5: Remove the moved code from `sports-page.tsx`** — delete `StandingsRail`, `recordLine`, `formatPct` from `sports-page.tsx` and import `StandingsRail` from `./sports-standings.js`. Confirm no other symbol in `sports-page.tsx` still references the removed helpers (`grep -n "recordLine\|formatPct\|StandingsRail" packages/sports/src/web/sports-page.tsx`).

- [ ] **Step 6: Add legend styles** — append to `sports-5-editorial.css`:

```css
.sp-legend {
  list-style: none;
  margin: var(--space-3) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.sp-legend__item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-xs, 0.75rem);
  color: var(--jds-text-muted);
}
.sp-legend__marker {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  background: var(--jds-accent);
  flex: none;
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run tests/unit/sports-page.test.tsx`
Expected: PASS — new all-league + legend tests, plus the existing standings paging and is-you/is-mine tests still green.

- [ ] **Step 8: Run the full gate** (file-size gate confirms the extraction kept `sports-page.tsx` under 1000 lines)

Run: `pnpm lint && pnpm format:check && pnpm check:file-size && pnpm check:design-tokens && pnpm typecheck && pnpm test:unit`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add packages/sports/src/web/sports-standings.tsx packages/sports/src/web/sports-page.tsx \
  packages/sports/src/web/styles/sports-5-editorial.css tests/unit/sports-page.test.tsx
git commit -m "feat(sports): all-league standings selector + qualification legend (#839, #841, #842)

User-facing: the standings panel now covers every supported league and explains what qualification markers mean."
```

---

## Task 7: Broadsheet grid + Latest column

> **Ordering:** run this task **after** Task 8 (it imports `StandingsRail` from `./sports-standings.js`).

Recompose the body into a 2-column broadsheet grid — **Latest** (`minmax(0, 2fr)`) beside **Standings** (`minmax(0, 1fr)`) — collapsing to one column below 900px. The scores column is dropped (tickers + hero carry scores). Convert `TopStoriesRail` into `LatestColumn`: a two-up story layout with a thumbnail per story (`Headline.imageUrl`), the "Latest" kicker (drop the "RANKED" text), keeping the 1–6 mono numerals, and **no explainer/dek text**.

**Files:**

- Modify: `packages/sports/src/web/sports-news.tsx` (`TopStoriesRail` → `LatestColumn`; `StoryHero` dek removal)
- Modify: `packages/sports/src/web/sports-page.tsx` (`SplitSection` → 2-col `BroadsheetGrid`; drop `rationale`/`RationaleChip`)
- Modify: `packages/sports/src/web/styles/sports-5-editorial.css` (grid + latest styles)
- Test: `tests/unit/sports-page.test.tsx`

**Interfaces:**

- Consumes: `overview.topStories: Headline[]`, `overview.standings`, `overview.followedTeams`, `isFollowed` (existing helper in `sports-news.tsx`).
- Produces: `LatestColumn({ headlines, followedTeams }): JSX.Element`; `sp-grid` with `sp-grid__main` (Latest) + `sp-grid__rail` (Standings).

- [ ] **Step 1: Read the current news + split code** — `grep -n "TopStoriesRail\|StoryHero\|isFollowed\|RANKED\|dek\|rationale\|RationaleChip\|SplitSection\|Scoreboard" packages/sports/src/web/sports-news.tsx packages/sports/src/web/sports-page.tsx`. Note the exact `isFollowed` signature, the "RANKED" eyebrow text, the dek element, and every `rationale` render site.

- [ ] **Step 2: Write the failing test** — add:

```ts
it("renders the 2-up Latest column without the RANKED eyebrow or explainer dek", () => {
  const html = render(makeOverview());
  expect(html).toContain("sp-grid");
  expect(html).toContain("sp-latest");
  expect(html).toContain("Latest");
  expect(html).not.toContain("RANKED");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/sports-page.test.tsx -t "2-up Latest"`
Expected: FAIL.

- [ ] **Step 4: Convert `TopStoriesRail` → `LatestColumn`** — in `sports-news.tsx`, replace `TopStoriesRail` with `LatestColumn`. Keep the numerals + is-you marking; drop the "RANKED" wording; render a thumbnail per story when `imageUrl` is present (match the real `isFollowed` signature):

```tsx
export function LatestColumn({
  headlines,
  followedTeams
}: {
  readonly headlines: readonly Headline[];
  readonly followedTeams: readonly FollowedTeamRef[];
}): JSX.Element {
  return (
    <section className="sp-latest">
      <p className="sp-col__kicker">Latest</p>
      <ol className="sp-latest__list">
        {headlines.slice(0, 6).map((h, i) => (
          <li className="sp-latest__item" key={h.id}>
            <a className="sp-hl" href={h.url}>
              <span className="sp-hl__num">{i + 1}</span>
              {h.imageUrl ? (
                <img className="sp-hl__thumb" src={h.imageUrl} alt="" loading="lazy" />
              ) : (
                <span className="sp-hl__thumb sp-hl__thumb--empty" aria-hidden />
              )}
              <span className="sp-hl__body">
                <span className="sp-hl__comp">{h.competitionLabel}</span>
                {isFollowed(h, followedTeams) ? (
                  <span className="sp-hl__you">Following</span>
                ) : null}
                <span className="sp-hl__title">{h.title}</span>
              </span>
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}
```

- [ ] **Step 5: Remove the `StoryHero` dek** — in `sports-news.tsx`, delete the explainer "dek" paragraph from `StoryHero` (keep the image/title/link). No dek anywhere.

- [ ] **Step 6: Convert `SplitSection` → 2-col `BroadsheetGrid`** — in `sports-page.tsx`, replace `SplitSection` (previously Scoreboard + TopStoriesRail in the body, StandingsRail in the rail). Now Latest in the main column, Standings in the rail; **no Scoreboard component**:

```tsx
function BroadsheetGrid({ overview }: { overview: SportsOverviewResponse }): JSX.Element {
  return (
    <div className="sp-grid">
      <div className="sp-grid__main">
        <LatestColumn headlines={overview.topStories} followedTeams={overview.followedTeams} />
      </div>
      <aside className="sp-grid__rail">
        <StandingsRail groups={overview.standings} followedTeams={overview.followedTeams} />
      </aside>
    </div>
  );
}
```

Update imports: `LatestColumn` from `./sports-news.js`, `StandingsRail` from `./sports-standings.js`. Render `<BroadsheetGrid overview={overview} />` in place of `<SplitSection …>` in the main composition. (Match the real DTO field names: `topStories`, `standings`, `followedTeams`.)

- [ ] **Step 7: Drop `rationale` rendering** — remove `RationaleChip` and every `rationale`/`alsoToday`-style render site in `sports-page.tsx` (hero + any card). Leave the DTO field intact (server still sends it; the client ignores it). Delete the now-dead `RationaleChip` component.

- [ ] **Step 8: Fix the existing rationale assertions** — the tests that assert the rationale string renders (the hero test and any `makeOverview`-default assertion) now fail. Change each `expect(html).toContain("<rationale string>")` to `expect(html).not.toContain("<rationale string>")` and rename the test accordingly. Keep the team-name/score/`sp-hero__comp` assertions intact.

- [ ] **Step 9: Add grid + latest styles** — append to `sports-5-editorial.css`:

```css
.sp-grid {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: var(--space-6);
  align-items: start;
}
.sp-latest__list {
  list-style: none;
  margin: 0;
  padding: 0;
  columns: 2;
  column-gap: var(--space-5);
}
.sp-latest__item {
  break-inside: avoid;
  margin-bottom: var(--space-4);
}
.sp-hl {
  display: grid;
  grid-template-columns: auto 64px 1fr;
  gap: var(--space-2);
  align-items: start;
  text-decoration: none;
  color: inherit;
}
.sp-hl__num {
  font-family: var(--jds-font-mono);
  font-size: var(--font-size-sm, 0.8125rem);
  color: var(--jds-text-muted);
}
.sp-hl__thumb {
  width: 64px;
  height: 48px;
  object-fit: cover;
  border-radius: var(--radius-sm, 4px);
}
.sp-hl__thumb--empty {
  background: var(--jds-surface-muted, var(--jds-surface));
}
.sp-hl__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sp-hl__comp {
  font-family: var(--jds-font-mono);
  font-size: var(--font-size-xs, 0.75rem);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--jds-text-muted);
}
.sp-hl__you {
  font-family: var(--jds-font-mono);
  font-size: var(--font-size-xs, 0.75rem);
  color: var(--jds-accent);
}
.sp-hl__title {
  font-weight: 600;
}

@media (max-width: 900px) {
  .sp-grid {
    grid-template-columns: 1fr;
  }
  .sp-latest__list {
    columns: 1;
  }
}
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `pnpm vitest run tests/unit/sports-page.test.tsx`
Expected: PASS (grid test + updated rationale tests + existing).

- [ ] **Step 11: Run the full gate**

Run: `pnpm lint && pnpm format:check && pnpm check:file-size && pnpm check:design-tokens && pnpm typecheck && pnpm test:unit`
Expected: all pass.

- [ ] **Step 12: Commit**

```bash
git add packages/sports/src/web/sports-news.tsx packages/sports/src/web/sports-page.tsx \
  packages/sports/src/web/styles/sports-5-editorial.css tests/unit/sports-page.test.tsx
git commit -m "feat(sports): 2-column broadsheet grid + Latest column, drop explainer text (#839)

User-facing: /sports now reads as a newspaper — a wide Latest column beside standings, with the 'why you're seeing this' captions removed."
```

---

## Task 9: News band — blurb, continue-reading, league filter

Convert `LeagueNewsSection` into a `NewsBand`: each story shows its `Headline.summary` blurb (#840), a "Continue reading →" link to the real `url`, and the band has a league filter.

**Files:**

- Modify: `packages/sports/src/web/sports-news.tsx` (`LeagueNewsSection` → `NewsBand`)
- Modify: `packages/sports/src/web/sports-page.tsx` (render `<NewsBand>` in place of `<LeagueNewsSection>`, in the main composition and any empty-state branch)
- Modify: `packages/sports/src/web/styles/sports-5-editorial.css` (news band styles)
- Test: `tests/unit/sports-page.test.tsx`

**Interfaces:**

- Consumes: `overview.leagueNews: LeagueNewsGroup[]` (each `{ competitionKey, competitionLabel, headlines }`). (Confirm the real field name in Step 1.)
- Produces: `NewsBand({ groups }): JSX.Element | null`.

- [ ] **Step 1: Read the current league-news code** — `grep -n "LeagueNewsSection\|LeagueNewsGroup\|leagueNews\|League news" packages/sports/src/web/sports-news.tsx packages/sports/src/web/sports-page.tsx tests/unit/sports-page.test.tsx`. Note the real group field name and every existing assertion that references "League news".

- [ ] **Step 2: Write the failing test** — add:

```ts
it("renders the news band with a blurb, continue-reading link, and league filter", () => {
  const html = render(
    makeOverview({
      leagueNews: [
        {
          competitionKey: "nfl",
          competitionLabel: "NFL",
          headlines: [
            headline("nb1", "nfl", "Cowboys sign veteran lineman", {
              summary: "The move shores up a thin offensive line ahead of the playoffs.",
              url: "https://example.test/nb1"
            })
          ]
        }
      ]
    })
  );
  expect(html).toContain("sp-newsband");
  expect(html).toContain("The move shores up a thin offensive line ahead of the playoffs.");
  expect(html).toContain("Continue reading");
  expect(html).toContain('href="https://example.test/nb1"');
  expect(html).toContain("sp-newsband__filter");
});
```

(Match the `headline()` factory's real signature — overrides arg shape — and `makeOverview`'s real `leagueNews` key from Step 1.)

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/sports-page.test.tsx -t "news band"`
Expected: FAIL.

- [ ] **Step 4: Convert `LeagueNewsSection` → `NewsBand`** — in `sports-news.tsx`:

```tsx
export function NewsBand({
  groups
}: {
  readonly groups: readonly LeagueNewsGroup[];
}): JSX.Element | null {
  const [filterKey, setFilterKey] = useState<string>("all");
  if (groups.length === 0) return null;
  const shown = filterKey === "all" ? groups : groups.filter((g) => g.competitionKey === filterKey);

  return (
    <section className="sp-newsband" aria-label="League news">
      <div className="sp-newsband__head">
        <p className="sp-col__kicker">News</p>
        <select
          className="sp-newsband__filter"
          aria-label="Filter news by league"
          value={filterKey}
          onChange={(e) => setFilterKey(e.target.value)}
        >
          <option value="all">All leagues</option>
          {groups.map((g) => (
            <option key={g.competitionKey} value={g.competitionKey}>
              {g.competitionLabel}
            </option>
          ))}
        </select>
      </div>
      <div className="sp-newsband__grid">
        {shown.flatMap((g) =>
          g.headlines.map((h) => (
            <article className="sp-newsband__card" key={h.id}>
              {h.imageUrl ? (
                <img className="sp-newsband__img" src={h.imageUrl} alt="" loading="lazy" />
              ) : null}
              <span className="sp-hl__comp">{g.competitionLabel}</span>
              <h3 className="sp-newsband__title">{h.title}</h3>
              {h.summary ? <p className="sp-newsband__blurb">{h.summary}</p> : null}
              <a className="sp-newsband__more" href={h.url}>
                Continue reading →
              </a>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
```

Add `useState` to the React import and `LeagueNewsGroup` to the `@jarv1s/shared` type import in this file.

- [ ] **Step 5: Swap render sites in `sports-page.tsx`** — replace `<LeagueNewsSection …>` with `<NewsBand groups={overview.leagueNews} />` in the main composition and any empty-state branch that rendered league news. Update the import; remove the unused `LeagueNewsSection` import.

- [ ] **Step 6: Reconcile the existing "League news" assertion** — the test noted in Step 1 that asserts the `"League news"` text/heading now needs the new markup. Keep the `aria-label="League news"` on the band (as above) so an aria-label assertion still matches, or update the assertion to the new "News" kicker. Do not delete the assertion — repoint it.

- [ ] **Step 7: Add news band styles** — append to `sports-5-editorial.css`:

```css
.sp-newsband {
  border-top: 2px solid var(--jds-border-strong, var(--jds-border));
  margin-top: var(--space-6);
  padding-top: var(--space-4);
}
.sp-newsband__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}
.sp-newsband__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: var(--space-5);
}
.sp-newsband__card {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.sp-newsband__img {
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  border-radius: var(--radius-sm, 4px);
}
.sp-newsband__title {
  font-weight: 700;
  font-size: var(--font-size-md, 1rem);
  margin: 0;
}
.sp-newsband__blurb {
  color: var(--jds-text-muted);
  font-size: var(--font-size-sm, 0.8125rem);
  margin: 0;
}
.sp-newsband__more {
  font-family: var(--jds-font-mono);
  font-size: var(--font-size-xs, 0.75rem);
  color: var(--jds-accent);
  text-decoration: none;
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm vitest run tests/unit/sports-page.test.tsx`
Expected: PASS.

- [ ] **Step 9: Run the full gate**

Run: `pnpm lint && pnpm format:check && pnpm check:file-size && pnpm check:design-tokens && pnpm typecheck && pnpm test:unit`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add packages/sports/src/web/sports-news.tsx packages/sports/src/web/sports-page.tsx \
  packages/sports/src/web/styles/sports-5-editorial.css tests/unit/sports-page.test.tsx
git commit -m "feat(sports): news band with blurbs, continue-reading, league filter (#839, #840)

User-facing: league news now shows a short blurb per story, a link to read on, and a league filter."
```

---

## Task 10: Skeleton/empty reconcile + visual QA

Reconcile the loading skeleton and empty state with the new composition (two tickers, masthead, 2-col grid, news band — no scores column), then verify both themes with live DOM/layout assertions.

**Files:**

- Modify: `packages/sports/src/web/sports-page.tsx` (`SportsSkeleton`; `EmptyState`)
- Modify: `packages/sports/src/web/styles/sports-5-editorial.css` (skeleton shapes)
- Test: `tests/unit/sports-page.test.tsx`

**Interfaces:**

- Consumes: existing `sp-skel--ticker`/`sp-skel--hero` classes (the loading test asserts these — keep them).

- [ ] **Step 1: Read the skeleton + empty state** — `grep -n "SportsSkeleton\|sp-skel\|EmptyState\|hasSlate\|Scoreboard\|TopStoriesRail\|LeagueNewsSection\|Follow your teams\|Choose teams" packages/sports/src/web/sports-page.tsx tests/unit/sports-page.test.tsx`. Note the asserted skeleton classes and the exact empty-state CTA strings the tests depend on.

- [ ] **Step 2: Write the failing test** — the skeleton should include a second ticker + a grid shape (use the file's real loading-state render helper — it renders `<SportsPage>` with no primed query data):

```ts
it("renders a skeleton matching the new composition (two tickers + grid)", () => {
  const client = new QueryClient();
  const html = renderToString(
    createElement(QueryClientProvider, { client }, createElement(SportsPage))
  );
  expect(html).toContain("sp-skel--ticker");
  expect(html).toContain("sp-skel--around");
  expect(html).toContain("sp-skel--hero");
  expect(html).toContain("sp-skel--grid");
});
```

(Match however the existing loading test constructs the unprimed page.)

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/sports-page.test.tsx -t "new composition"`
Expected: FAIL.

- [ ] **Step 4: Update `SportsSkeleton`** — add a second ticker (`sp-skel--around`) below the followed ticker and a `sp-skel--grid` block; keep `sp-skel--ticker` and `sp-skel--hero`:

```tsx
function SportsSkeleton(): JSX.Element {
  return (
    <div className="sp-skel" aria-hidden>
      <div className="sp-skel__bar sp-skel--ticker" />
      <div className="sp-skel__bar sp-skel--around" />
      <div className="sp-skel__bar sp-skel--hero" />
      <div className="sp-skel__bar sp-skel--grid" />
    </div>
  );
}
```

Add `.sp-skel--around` / `.sp-skel--grid` heights to the stylesheet (grep `sp-skel--` in `styles/` for the existing modifier-height pattern and follow it):

```css
.sp-skel--around {
  height: 2.5rem;
}
.sp-skel--grid {
  height: 24rem;
}
```

- [ ] **Step 5: Reconcile `EmptyState`** — in the `hasSlate` branch that previously rendered `Scoreboard` / `TopStoriesRail` / `LeagueNewsSection`, drop `Scoreboard`, render `LatestColumn` + `NewsBand` instead. Keep the "Follow your teams" / "Choose teams to follow" CTA copy exactly (the empty-state tests assert these strings, plus `Following`/`1 league` counts). Adjust only component names, never the asserted copy.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run tests/unit/sports-page.test.tsx`
Expected: PASS (new skeleton test + the empty-state suite).

- [ ] **Step 7: Run the full gate**

Run: `pnpm verify:foundation`
Expected: all pass (lint, format, file-size, design-tokens, typecheck, unit).

- [ ] **Step 8: Visual QA — both themes**

Run focused Playwright DOM/computed-style assertions against `/sports` in **both light and dark**. Confirm: both tickers render; overflow controls appear only when needed; the hero has no explainer chip; the grid holds at desktop and collapses below 900px; the selector lists all leagues; the legend and news band render as specified; typography and contrast assertions pass. Fix any layout defects in `sports-5-editorial.css` and re-run the gate.

- [ ] **Step 9: Commit**

```bash
git add packages/sports/src/web/sports-page.tsx packages/sports/src/web/styles/sports-5-editorial.css \
  tests/unit/sports-page.test.tsx
git commit -m "feat(sports): reconcile skeleton + empty state with broadsheet layout (#839)

User-facing: the loading and empty-state screens now match the new newspaper layout."
```

---

## Self-Review

**1. Spec coverage** (against `docs/superpowers/specs/2026-07-06-sports-broadsheet-grid-design.md` + the rev-3 mockup):

- Masthead / no-serif broadsheet feel → Task 4. ✅
- Two tickers (followed kept untouched + around-the-leagues with scroll buttons that hide at ends + league-once separator) → Task 5. ✅
- Scores column dropped; 2-col grid Latest(2fr)|Standings(1fr) → Task 7. ✅
- Latest 2-up, thumbnail per story, drop "RANKED", keep numerals, no dek → Task 7. ✅
- Timezone/clock match times → Task 6. ✅
- All-league standings selector + conference/division sections (existing `StandingsSection.label`) + qualification legend → Task 8 (+ #841, #842). ✅
- News band: summary blurb + continue-reading + league filter → Task 9 (+ #840). ✅
- Remove all explainer/rationale text → Task 7 Steps 7–8. ✅
- Manage = existing settings link → already present (`SETTINGS_HREF` in `sports-page.tsx`/`sports-ticker.tsx`), no task needed. ✅
- Server slice bounded to #840/#841/#842, no DB migration → Tasks 1–3. ✅
- Design-token gate / raw qualification hex never in CSS → Task 8 Step 4 note; `check:design-tokens` in every CSS-touching task's gate. ✅
- File-size cap → new `sports-5-editorial.css` (Task 4) + `StandingsRail` extraction (Task 8). ✅

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"write tests for the above" — every code step carries real code and every test step shows the assertion. CSS values are functional defaults explicitly deferred to the owner's design pass, not placeholders. Several steps say "match the real field name / grep first" — these are grounding instructions, not deferred work: the surrounding code shows the shape and the grep only confirms the exact identifier before editing.

**3. Type consistency:**

- `Headline.summary: string` (Task 1) → `h.summary` (Tasks 9, optionally 7). ✅
- `StandingsRow.qualificationNote/qualificationColor: string | null` (Task 2) → `r.qualificationNote` (Task 8). ✅
- `getStandingsByLeague` + `sportsQueryKeys.standings` (Task 3) → consumed by `StandingsRail` (Task 8). ✅
- `StandingsRail({ groups, followedTeams })` — same prop names in Task 8 (definition) and Task 7 (`BroadsheetGrid` consumer). ✅
- `LatestColumn({ headlines, followedTeams })` — defined Task 7 Step 4, consumed same task. ✅
- `NewsBand({ groups })` — defined Task 9 Step 4, consumed Task 9 Step 5 + Task 10 Step 5. ✅
- **Ordering:** `BroadsheetGrid` (Task 7) imports `StandingsRail` from `./sports-standings.js`, created in Task 8 → **execute Task 8 before Task 7** (flagged at the top of both tasks). All other tasks respect server-before-frontend (1–3 before 7/8/9).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-06-sports-broadsheet-grid.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, task review between tasks, broad review at the end. Dispatch order: **1 → 2 → 3 → 4 → 5 → 6 → 8 → 7 → 9 → 10** (Standings extraction before the grid recompose, per the ordering note).
2. **Inline Execution** — execute tasks in this session with checkpoints for review.

Build must not start until the owner approves this plan.

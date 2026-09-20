// tests/uat/fixtures/espn-fixture-routes.ts
//
// Deterministic ESPN answers for the API-side e2e fixture seam (DF-V4-R4). The
// fixture server stamps the eng.1 scoreboard template at request time from its
// injected fixed parity morning clock (default now at 08:00 Los Angeles): four
// finished games and three Tonight fixtures. Matched on pathname only, like the job-search table:
// the adapter varies query strings per date window.
//
// Teams/standings/schedule are the smallest payloads the adapter's readers
// accept. The news payload's first story image is the fixture PNG as a data URI
// (see eng1-news.json): the fixture origin is container-private, so no browser
// can load an http(s) fixture URL, while the /espn/photo.png route below proves
// the same bytes serve as image/png in-network.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// tests/uat/fixtures -> tests/fixtures/espn
const ESPN_DIR = join(HERE, "..", "..", "fixtures", "espn");

export interface EspnFixtureRoute {
  readonly contentType: string;
  readonly body: Buffer;
}

interface TemplateSide {
  readonly id: string;
  readonly abbreviation: string;
  readonly displayName: string;
  readonly shortDisplayName: string;
  readonly score: string | null;
  readonly winner: boolean;
  readonly record: string;
}

interface TemplateEvent {
  readonly id: string;
  readonly startsAtOffsetHours: number;
  readonly state: string;
  readonly statusDetail: string;
  readonly home: TemplateSide;
  readonly away: TemplateSide;
}

function fixtureNow(): Date {
  const now = new Date();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    })
      .formatToParts(now)
      .map(({ type, value }) => [type, value])
  );
  const offset =
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      timeZoneName: "longOffset"
    })
      .formatToParts(now)
      .find((part) => part.type === "timeZoneName")
      ?.value?.replace("GMT", "") ?? "Z";
  return new Date(`${parts.year}-${parts.month}-${parts.day}T08:00:00${offset}`);
}

function readTemplate(): readonly TemplateEvent[] {
  const raw = JSON.parse(readFileSync(join(ESPN_DIR, "eng1-scoreboard.template.json"), "utf8")) as {
    events: readonly TemplateEvent[];
  };
  return raw.events;
}

function stampSide(side: TemplateSide, homeAway: string): unknown {
  return {
    homeAway,
    team: {
      id: side.id,
      abbreviation: side.abbreviation,
      displayName: side.displayName,
      shortDisplayName: side.shortDisplayName
    },
    score: side.score,
    winner: side.winner,
    records: [{ summary: side.record }]
  };
}

/** Renders the template into an ESPN scoreboard payload at `now`. Exported for the unit test. */
export function stampEng1Scoreboard(
  template: readonly TemplateEvent[],
  now: Date
): { readonly events: readonly unknown[] } {
  return {
    events: template.map((event) => ({
      id: event.id,
      date: new Date(now.getTime() + event.startsAtOffsetHours * 3_600_000).toISOString(),
      competitions: [
        {
          status: { type: { state: event.state, detail: event.statusDetail } },
          competitors: [stampSide(event.home, "home"), stampSide(event.away, "away")]
        }
      ]
    }))
  };
}

const ENG1_TEAMS: readonly TemplateSide[] = [
  {
    id: "359",
    abbreviation: "ARS",
    displayName: "Arsenal",
    shortDisplayName: "Arsenal",
    score: null,
    winner: false,
    record: "18-4-6"
  },
  {
    id: "363",
    abbreviation: "CHE",
    displayName: "Chelsea",
    shortDisplayName: "Chelsea",
    score: null,
    winner: false,
    record: "14-8-6"
  },
  {
    id: "364",
    abbreviation: "LIV",
    displayName: "Liverpool",
    shortDisplayName: "Liverpool",
    score: null,
    winner: false,
    record: "16-6-6"
  },
  {
    id: "382",
    abbreviation: "MCI",
    displayName: "Manchester City",
    shortDisplayName: "Man City",
    score: null,
    winner: false,
    record: "17-5-6"
  },
  {
    id: "367",
    abbreviation: "TOT",
    displayName: "Tottenham Hotspur",
    shortDisplayName: "Spurs",
    score: null,
    winner: false,
    record: "12-7-9"
  },
  {
    id: "361",
    abbreviation: "NEW",
    displayName: "Newcastle United",
    shortDisplayName: "Newcastle",
    score: null,
    winner: false,
    record: "13-8-7"
  }
];

function teamsPayload(): unknown {
  return {
    sports: [
      {
        leagues: [
          {
            teams: ENG1_TEAMS.map((team) => ({
              team: {
                id: team.id,
                abbreviation: team.abbreviation,
                displayName: team.displayName,
                shortDisplayName: team.shortDisplayName,
                logos: []
              }
            }))
          }
        ]
      }
    ]
  };
}

function standingsPayload(): unknown {
  return {
    children: [
      {
        name: "Premier League",
        standings: {
          entries: ENG1_TEAMS.map((team, index) => ({
            team: {
              id: team.id,
              abbreviation: team.abbreviation,
              displayName: team.displayName
            },
            stats: [
              { name: "wins", value: 18 - index },
              { name: "losses", value: 4 + index },
              { name: "points", value: 58 - index * 2 },
              { name: "rank", value: index + 1 }
            ]
          }))
        }
      }
    ]
  };
}

const JSON_TYPE = "application/json; charset=utf-8";

function newsPayload(): Buffer {
  const payload = JSON.parse(readFileSync(join(ESPN_DIR, "eng1-news.json"), "utf8")) as {
    articles: Array<{ images?: Array<{ url?: string }> }>;
  };
  const photo = readFileSync(join(ESPN_DIR, "photo.png")).toString("base64");
  const leadImage = payload.articles[0]?.images?.[0];
  if (leadImage) leadImage.url = `data:image/png;base64,${photo}`;
  return Buffer.from(JSON.stringify(payload));
}

/**
 * Minimal RSS 2.0 for the news desk under the seam. The catalog feed hosts rewrite
 * onto this origin when the bypass is on, and real RSS would 404; one working feed
 * is enough for the desk to render. Deliberately imageless: artwork must be https on
 * the source's declared image hosts (sanitizeImageUrl), which a container-private
 * fixture origin can never satisfy, so fixture stories are text-only — an allowed
 * state (invariant 3) that still proves every layout rule. Served at the default
 * sources' top-feed pathnames; per-topic feed fetches 404 and degrade per source.
 */
const NEWS_RSS_ITEMS = [
  [
    "UAT rig achieves deterministic Tuesday",
    "deterministic-tuesday",
    "Engineers confirmed the test harness now produces the same morning twice.",
    "07:00:00"
  ],
  [
    "City council approves night-bus trial",
    "night-bus-trial",
    "The six-month trial adds three late routes across the river.",
    "06:30:00"
  ],
  [
    "Orchards report record harvest",
    "record-harvest",
    "Growers credit a wet spring and a cool August for the bumper crop.",
    "06:00:00"
  ],
  [
    "Library extends weekend hours",
    "weekend-hours",
    "Both branches now stay open until eight on Saturdays.",
    "05:30:00"
  ]
] as const;

const NEWS_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>UAT fixture desk wire</title><link>https://fixture.invalid/</link><description>Deterministic UAT stories for the Today news desk.</description>${NEWS_RSS_ITEMS.map(
  ([title, slug, summary, time]) =>
    `<item><title>${title}</title><link>https://fixture.invalid/stories/${slug}</link><description>${summary}</description><pubDate>Tue, 15 Sep 2026 ${time} GMT</pubDate></item>`
).join("")}</channel></rss>`;

const RSS_TYPE = "application/rss+xml; charset=utf-8";

// Top-feed pathnames of the catalog's default sources (bbc, guardian, ap-via-openrss,
// nyt): one success renders the desk; the rest of the catalog degrades per source.
const NEWS_FEED_PATHS: readonly string[] = [
  "/news/rss.xml",
  "/international/rss",
  "/feed/apnews.com",
  "/services/xml/rss/nyt/HomePage.xml"
];

let templateCache: readonly TemplateEvent[] | undefined;

/**
 * Answers the ESPN paths the sports overview requests for eng.1, plus the PNG.
 * Anything else returns undefined so the caller falls through to its own 404.
 */
export function routeEspnFixture(
  pathname: string,
  now: Date = fixtureNow()
): EspnFixtureRoute | undefined {
  if (NEWS_FEED_PATHS.includes(pathname)) {
    return { contentType: RSS_TYPE, body: Buffer.from(NEWS_RSS) };
  }
  switch (pathname) {
    case "/apis/site/v2/sports/soccer/eng.1/scoreboard":
      templateCache ??= readTemplate();
      return {
        contentType: JSON_TYPE,
        body: Buffer.from(JSON.stringify(stampEng1Scoreboard(templateCache, now)))
      };
    case "/apis/site/v2/sports/soccer/eng.1/news":
      return { contentType: JSON_TYPE, body: newsPayload() };
    case "/apis/site/v2/sports/soccer/eng.1/teams":
      return { contentType: JSON_TYPE, body: Buffer.from(JSON.stringify(teamsPayload())) };
    case "/apis/site/v2/sports/soccer/eng.1/teams/359/schedule":
      return { contentType: JSON_TYPE, body: Buffer.from(JSON.stringify({ events: [] })) };
    case "/apis/v2/sports/soccer/eng.1/standings":
      return { contentType: JSON_TYPE, body: Buffer.from(JSON.stringify(standingsPayload())) };
    case "/espn/photo.png":
      return { contentType: "image/png", body: readFileSync(join(ESPN_DIR, "photo.png")) };
    default:
      return undefined;
  }
}

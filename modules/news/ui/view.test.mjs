import assert from "node:assert/strict";
import test from "node:test";
import * as v from "./view.mjs";
import { newsApi } from "./screen-api.mjs";
import { leadArtSvg, leadArtPalette, drawLeadContours } from "./lead-art.mjs";

const story = (id, extra = {}) => ({
  id,
  sourceKey: "s1",
  sourceLabel: "Wire",
  topicKey: null,
  topicLabel: null,
  topicLabels: [],
  title: `Story ${id}`,
  url: `https://example.com/${id}`,
  publishedAt: "2026-11-17T10:00:00.000Z",
  imageUrl: null,
  faviconUrl: null,
  summary: "",
  ...extra
});
const pic = (id) => `/api/news/images/${id}`;
const feedback = () => "";
const labelFor = (key) => ({ us: "U.S." })[key] ?? key;

test("the mosaic picks a feature with a photo and a summary, then two major cards with photos", () => {
  const pool = [
    story("a", { imageUrl: pic("a") }),
    story("b", { imageUrl: pic("b"), summary: "dek" }),
    story("c", { imageUrl: pic("c") }),
    story("d", { imageUrl: pic("d") }),
    ...["e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t"].map((id) =>
      story(id)
    )
  ];
  const plan = v.composeMosaic(pool);
  assert.equal(plan.feature.id, "b");
  assert.deepEqual([...plan.majorIds], ["a", "c"]);
  assert.equal(plan.mosaic.length, 2 + 6);
  assert.equal(plan.briefs.length, 10);
  assert.ok(!plan.briefs.some((h) => plan.mosaic.includes(h)));
});

test("with no photo and summary there is no feature and no major card", () => {
  const plan = v.composeMosaic([story("a"), story("b", { imageUrl: pic("b") })]);
  assert.equal(plan.feature, null);
  assert.deepEqual([...plan.majorIds], ["b"]);
});

test("source groups interleave one story from each source at a time", () => {
  const out = v.interleaveGroups([
    { headlines: [story("a1"), story("a2")] },
    { headlines: [story("b1")] }
  ]);
  assert.deepEqual(
    out.map((h) => h.id),
    ["a1", "b1", "a2"]
  );
});

test("a topic filter matches the key, the label and the story's own labels, ignoring case", () => {
  const h = story("a", { topicLabel: "U.S.", topicLabels: ["U.S."] });
  assert.ok(v.matchesTopic(h, "us", labelFor));
  assert.ok(v.matchesTopic(h, null, labelFor));
  assert.ok(!v.matchesTopic(h, "world", labelFor));
  assert.ok(v.matchesTopic(story("b", { topicKey: "WORLD" }), "world", labelFor));
});

test("a dismissed story leaves every list and the carousel refills from the ranked list", () => {
  const ranked = ["a", "b", "c", "d", "e", "f", "g"].map((id) => story(id));
  const data = {
    topStories: ranked.slice(0, 5),
    rankedStories: ranked,
    sourceGroups: [{ sourceKey: "s1", headlines: ranked }],
    activeTopics: [],
    enabledSources: ["s1"],
    degraded: false
  };
  const out = v.withoutStories(data, new Set(["a"]));
  assert.deepEqual(
    out.topStories.map((h) => h.id),
    ["b", "c", "d", "e", "f"]
  );
  assert.ok(!out.rankedStories.some((h) => h.id === "a"));
  assert.ok(!out.sourceGroups[0].headlines.some((h) => h.id === "a"));
  assert.equal(v.withoutStories(data, new Set()), data);
});

test("the kicker joins the source and the topic labels", () => {
  assert.equal(v.kicker(story("a")), "Wire");
  assert.equal(v.kicker(story("a", { topicLabel: "Tech" })), "Wire · Tech");
  assert.equal(
    v.kicker(story("a", { topicLabels: ["Tech", "Science"], topicLabel: "Tech" })),
    "Wire · Tech · Science"
  );
});

test("story text is escaped and only web links are written", () => {
  const nasty = story("a", {
    title: "<img src=x onerror=1>",
    url: "javascript:alert(1)",
    summary: "a & b"
  });
  const html = v.mosaic(v.composeMosaic([nasty]), feedback) + v.briefs([nasty], feedback);
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img src=x onerror=1&gt;"));
  assert.ok(!html.includes("javascript:"));
});

const base = {
  topStories: [],
  rankedStories: [],
  sourceGroups: [],
  activeTopics: [],
  enabledSources: ["s1"],
  degraded: false
};
const page = (data, extra = {}) =>
  v.pageHtml({
    data,
    filter: null,
    labelFor,
    slide: 0,
    feedbackHtml: feedback,
    receipt: "",
    failed: false,
    ...extra
  });

test("the empty states say what is wrong and offer the way out", () => {
  assert.match(page({ ...base, enabledSources: [] }), /Choose your sources/);
  assert.match(page({ ...base, degraded: true }), /News is unavailable/);
  const quiet = page(base);
  assert.match(quiet, /Nothing on the wire/);
  assert.match(
    quiet,
    /data-nav="\/settings\?section=modules&amp;module=news"|data-nav="\/settings\?section=modules&module=news"/
  );
  const filtered = page({ ...base, activeTopics: ["us"] }, { filter: "us" });
  assert.match(filtered, /No stories for U\.S\./);
  assert.match(filtered, /Show all stories/);
});

test("the loading and broken lines match the TypeScript screen", () => {
  assert.match(v.loadingLine(), /Loading news…/);
  assert.match(v.failureLine(false), /News is unavailable right now\..*Try again/);
  assert.match(
    v.failureLine(true),
    /Could not refresh news\. Showing the last loaded front page\./
  );
});

test("a loaded page shows the carousel, the rail, the brief list and the degraded note", () => {
  const stories = Array.from({ length: 30 }, (_, i) =>
    story(`s${i}`, i < 8 ? { imageUrl: pic(`s${i}`), summary: "dek" } : {})
  );
  const data = {
    ...base,
    topStories: stories.slice(0, 5),
    rankedStories: stories,
    sourceGroups: [
      {
        sourceKey: "s1",
        sourceLabel: "Wire",
        homepageUrl: "https://example.com",
        headlines: stories
      }
    ],
    activeTopics: ["us", "world"],
    degraded: true
  };
  const html = page(data);
  assert.match(html, /Your front page/);
  assert.equal((html.match(/aria-roledescription="slide"/g) ?? []).length, 5);
  assert.match(html, /aria-label="Story 5 of 5"/);
  assert.match(html, /From your sources/);
  assert.match(html, /In brief/);
  assert.match(html, /Some sources didn’t respond just now/);
  assert.match(html, />U\.S\.</);
  assert.equal((html.match(/nw-rail__item/g) ?? []).length, 12);
  assert.ok(!html.includes("Front pages from your sources"));
  assert.match(page({ ...data, activeTopics: [] }), /Front pages from your sources/);
});

test("the Today widget draws nothing without stories and a lead plus three rows with them", () => {
  assert.equal(
    v.widgetHtml(base, feedback, () => ""),
    ""
  );
  const stories = ["a", "b", "c", "d", "e"].map((id) =>
    story(id, { summary: "dek", faviconUrl: `/api/news/favicon/${id}.com` })
  );
  const html = v.widgetHtml({ ...base, topStories: stories }, feedback, () => "<ART/>");
  assert.match(html, /aria-label="News desk"/);
  assert.match(html, /The wider world/);
  assert.match(html, /<ART\/>/);
  assert.match(html, /Read the story/);
  assert.equal((html.match(/nw-twlist__item/g) ?? []).length, 3);
  assert.match(html, /Your news, in context/);
});

test("picture requests reach only the two picture routes and need an image reply", async () => {
  const seen = [];
  const reply = (body) => ({ request: async (m, p) => (seen.push([m, p]), body) });
  const ok = newsApi(reply({ dataUrl: "data:image/png;base64,AAAA" }));
  assert.equal(await ok.picture("/api/news/images/abc-123"), "data:image/png;base64,AAAA");
  assert.equal(await ok.picture("/api/news/favicon/example.com"), "data:image/png;base64,AAAA");
  assert.deepEqual(seen, [
    ["GET", "/images/abc-123"],
    ["GET", "/favicon/example.com"]
  ]);
  for (const bad of [
    "/api/news/overview",
    "https://evil.test/x.png",
    "/api/news/images/../x",
    "/api/news/images/a/b"
  ]) {
    await assert.rejects(() => ok.picture(bad));
  }
  await assert.rejects(() =>
    newsApi(reply({ dataUrl: "javascript:1" })).picture("/api/news/images/a")
  );
  await assert.rejects(() => newsApi(reply({ nope: 1 })).picture("/api/news/images/a"));
});

test("feedback posts the story id and trims nothing the screen did not trim", async () => {
  const sent = [];
  const api = newsApi({
    request: async (m, p, b) => (sent.push([m, p, b]), { status: 200, body: {} })
  });
  await api.feedback("id1", "more_like_this");
  await api.feedback("id1", "less_like_this", "too much");
  assert.deepEqual(sent, [
    ["POST", "/story-feedback", { storyRef: "id1", kind: "more_like_this" }],
    ["POST", "/story-feedback", { storyRef: "id1", kind: "less_like_this", reason: "too much" }]
  ]);
  const failing = newsApi({ request: async () => ({ status: 404, body: { error: "x" } }) });
  await assert.rejects(() => failing.feedback("id1", "more_like_this"), { status: 404 });
});

test("lead art is stable for one story and varies by topic family", () => {
  const a = { topic: "World", headline: "x", publisher: "y" };
  assert.equal(leadArtSvg(a), leadArtSvg(a));
  assert.notEqual(leadArtSvg(a), leadArtSvg({ ...a, headline: "z" }));
  assert.equal(leadArtPalette("Tech"), "technology");
  assert.equal(leadArtPalette("unknown"), "world");
  assert.ok(drawLeadContours(1, "climate").length > 5);
  assert.match(leadArtSvg(a), /Moss topic artwork/);
});

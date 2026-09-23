import { describe, expect, it } from "vitest";

import { projectStableSampleApi } from "../../tests/uat/visual-parity/capture.js";

const newsBase = {
  topStories: [{ id: "n1", title: "Lead story", url: "https://news.example/a" }]
};
const sportsBase = {
  topStories: [{ id: "s1", title: "Sport lead", url: "https://sports.example/a" }],
  followed: [
    {
      name: "Arsenal",
      stories: [{ title: "Arsenal story", url: "https://sports.example/ars" }]
    }
  ]
};

describe("projectStableSampleApi", () => {
  it("projects equal when only fields outside the projection differ", () => {
    const newsA = {
      ...newsBase,
      degraded: false,
      sourceGroups: [{ key: "g1" }],
      topStories: [{ ...newsBase.topStories[0], summary: "v1", imageUrl: "img1" }]
    };
    const newsB = {
      ...newsBase,
      degraded: true,
      sourceGroups: [{ key: "g2" }],
      topStories: [{ ...newsBase.topStories[0], summary: "v2", imageUrl: "img2" }]
    };
    const sportsA = {
      ...sportsBase,
      degraded: false,
      hero: { mode: "a" },
      topStories: [{ ...sportsBase.topStories[0], summary: "v1" }]
    };
    const sportsB = {
      ...sportsBase,
      degraded: true,
      hero: { mode: "b" },
      topStories: [{ ...sportsBase.topStories[0], summary: "v2" }]
    };
    expect(projectStableSampleApi(newsA, sportsA)).toEqual(projectStableSampleApi(newsB, sportsB));
  });

  it("still projects unequal when a title, url or top-story id changes", () => {
    const changedTitle = {
      ...newsBase,
      topStories: [{ ...newsBase.topStories[0], title: "Different lead" }]
    };
    expect(projectStableSampleApi(changedTitle, sportsBase)).not.toEqual(
      projectStableSampleApi(newsBase, sportsBase)
    );
    const changedUrl = {
      ...sportsBase,
      followed: [
        {
          name: "Arsenal",
          stories: [{ title: "Arsenal story", url: "https://sports.example/other" }]
        }
      ]
    };
    expect(projectStableSampleApi(newsBase, changedUrl)).not.toEqual(
      projectStableSampleApi(newsBase, sportsBase)
    );
    const changedId = {
      ...newsBase,
      topStories: [{ ...newsBase.topStories[0], id: "n2" }]
    };
    expect(projectStableSampleApi(changedId, sportsBase)).not.toEqual(
      projectStableSampleApi(newsBase, sportsBase)
    );
  });
});

import { firstDiffKey, isPopulated } from "../../tests/uat/visual-parity/capture.js";

describe("isPopulated pin", () => {
  const api = {
    news: [["n1", "Lead story", "https://news.example/a"]],
    sports: [["Sport lead", "https://sports.example/a"]],
    followed: [["Arsenal", [["Arsenal story", "https://sports.example/ars"]]]]
  };
  const dom = {
    newsItems: [{ id: "n", testId: null, href: null, text: "News item" }],
    arsenalItems: [{ id: "a", testId: null, href: null, text: "Arsenal item" }],
    arsenalText: "intro Arsenal seal late win to stay top of the pile outro",
    faces: [{ sel: ".nw-twlead__title", ready: true }]
  };
  it("accepts a populated sample and rejects one without a lead id", () => {
    expect(isPopulated(JSON.stringify({ api, ...dom }))).toBe(true);
    const noLead = { ...api, news: [[null, "Lead story", "https://news.example/a"]] };
    expect(isPopulated(JSON.stringify({ api: noLead, ...dom }))).toBe(false);
  });
});

describe("firstDiffKey", () => {
  it("names the first differing top-level key", () => {
    const a = JSON.stringify({ api: { news: [] }, faces: [{ ready: true }] });
    const b = JSON.stringify({ api: { news: [["n1", "t", "u"]] }, faces: [{ ready: true }] });
    expect(firstDiffKey(a, b)).toBe("api");
    const c = JSON.stringify({ api: { news: [] }, faces: [{ ready: false }] });
    expect(firstDiffKey(a, c)).toBe("faces");
    expect(firstDiffKey("not-json", b)).toBe("unparseable");
  });
});

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

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PNG } from "pngjs";

import { diffFiles, populatedReport } from "../../tests/uat/visual-parity/capture.js";

function solidPngFile(path: string, width: number, height: number): void {
  const png = new PNG({ width, height });
  png.data.fill(128);
  writeFileSync(path, PNG.sync.write(png));
}

describe("diffFiles size mismatch", () => {
  it("writes the diff file before returning 100", () => {
    const dir = mkdtempSync(join(tmpdir(), "parity-diag-"));
    const aPath = join(dir, "a.png");
    const bPath = join(dir, "b.png");
    const outPath = join(dir, "diff.png");
    solidPngFile(aPath, 4, 4);
    solidPngFile(bPath, 6, 4);
    expect(diffFiles(aPath, bPath, outPath)).toBe(100);
    expect(existsSync(outPath)).toBe(true);
  });
});

describe("isPopulated pins", () => {
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
  const cases: Array<[string, unknown, boolean]> = [
    ["all true", { api, ...dom }, true],
    [
      "lead missing id",
      { api: { ...api, news: [[null, "Lead story", "https://news.example/a"]] }, ...dom },
      false
    ],
    [
      "arsenal card missing",
      { api: { ...api, followed: [["Chelsea", [["x", "https://sports.example/c"]]]] }, ...dom },
      false
    ],
    ["news not rendered", { api, ...dom, newsItems: [] }, false],
    ["arsenal not rendered", { api, ...dom, arsenalItems: [] }, false],
    ["headline missing", { api, ...dom, arsenalText: "no headline here" }, false],
    ["face not ready", { api, ...dom, faces: [{ sel: ".nw-twlead__title", ready: false }] }, false]
  ];
  for (const [name, sample, expected] of cases) {
    it(`agrees with the base: ${name} -> ${expected}`, () => {
      expect(isPopulated(JSON.stringify(sample))).toBe(expected);
    });
  }
});

describe("populatedReport", () => {
  const api = {
    news: [["n1", "Lead story", "https://news.example/a"]],
    sports: [["Sport lead", "https://sports.example/a"]],
    followed: [["Arsenal", [["Arsenal story", "https://sports.example/ars"]]]]
  };
  const dom = {
    newsItems: [{ id: "n", testId: null, href: null, text: "News item" }],
    arsenalItems: [{ id: "a", testId: null, href: null, text: "Arsenal item" }],
    arsenalText: "intro Arsenal seal late win to stay top of the pile outro",
    faces: [
      { sel: ".nw-twlead__title", ready: true },
      { sel: ".desk-title", ready: true }
    ]
  };
  const full = JSON.stringify({ api, ...dom });
  it("reports all true on a populated sample", () => {
    expect(populatedReport(full)).toEqual({
      apiLead: true,
      apiArsenal: true,
      newsRendered: true,
      arsenalRendered: true,
      arsenalHeadline: true,
      facesReady: true,
      facesNotReady: []
    });
  });
  const faults: Array<[string, unknown, string]> = [
    ["apiLead", { api: { ...api, news: [[null, "t", "u"]] }, ...dom }, "apiLead"],
    ["apiArsenal", { api: { ...api, followed: [] }, ...dom }, "apiArsenal"],
    ["newsRendered", { api, ...dom, newsItems: [] }, "newsRendered"],
    ["arsenalRendered", { api, ...dom, arsenalItems: [] }, "arsenalRendered"],
    ["arsenalHeadline", { api, ...dom, arsenalText: "nothing" }, "arsenalHeadline"],
    ["facesReady", { api, ...dom, faces: [{ sel: ".desk-title", ready: false }] }, "facesReady"]
  ];
  for (const [name, sample, key] of faults) {
    it(`flags only ${name} when it is false`, () => {
      const report = populatedReport(JSON.stringify(sample));
      expect(report[key as keyof typeof report]).toBe(false);
      expect(isPopulated(JSON.stringify(sample))).toBe(false);
    });
  }
  it("names the faces that are not ready", () => {
    const sample = { api, ...dom, faces: [{ sel: ".desk-title", ready: false }] };
    expect(populatedReport(JSON.stringify(sample)).facesNotReady).toEqual([".desk-title"]);
  });
});

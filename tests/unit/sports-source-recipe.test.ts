import { describe, expect, it } from "vitest";

import {
  expandSportsSourceRecipe,
  extractSportsSourceRecipe,
  validateSportsSourceRecipe
} from "../../packages/sports/src/source/recipe.js";

const fotmobJsonRecipe = {
  version: 1,
  kind: "json",
  fetchHosts: ["www.fotmob.com"],
  request: {
    urlTemplate: "https://www.fotmob.com/api/tltv3/teams/{teamId}",
    slots: [{ name: "teamId", location: "path", encoding: "path_segment", maxLength: 32 }],
    headers: { accept: "application/json", "accept-language": "en-US,en;q=0.5" }
  },
  scopes: ["team", "competition"],
  itemLimit: 10,
  extraction: {
    itemsPath: ["news"],
    headlinePath: ["title"],
    urlPath: ["page", "url"],
    publishedAtPath: ["publishedAt"],
    normalize: ["trim", "collapse_whitespace", "strip_controls"]
  }
} as const;

describe("Sports public source recipe", () => {
  it("validates, fingerprints, expands, and replays a FotMob-shaped JSON recipe", () => {
    const validated = validateSportsSourceRecipe(fotmobJsonRecipe);
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error(validated.reason);

    const expanded = expandSportsSourceRecipe(validated.recipe, { teamId: "8650" });
    expect(expanded).toEqual({
      ok: true,
      url: "https://www.fotmob.com/api/tltv3/teams/8650",
      headers: { accept: "application/json", "accept-language": "en-US,en;q=0.5" },
      identity: expect.stringContaining(validated.fingerprint)
    });
    if (!expanded.ok) throw new Error(expanded.reason);

    expect(
      extractSportsSourceRecipe(validated.recipe, {
        body: JSON.stringify({
          news: [
            {
              title: "  Liverpool\u0000   team news ",
              page: { url: "https://external.example/story/1" },
              publishedAt: "2026-08-23T10:00:00Z"
            }
          ]
        }),
        contentType: "application/json",
        requestUrl: expanded.url
      })
    ).toEqual({
      ok: true,
      items: [
        {
          headline: "Liverpool team news",
          url: "https://external.example/story/1",
          publishedAt: "2026-08-23T10:00:00.000Z"
        }
      ]
    });
  });

  it("extracts bounded HTML with CSS selectors and treats an empty collection as healthy", () => {
    const validated = validateSportsSourceRecipe({
      version: 1,
      kind: "html",
      fetchHosts: ["publisher.example"],
      request: {
        urlTemplate: "https://publisher.example/team/{slug}/news",
        slots: [{ name: "slug", location: "path", encoding: "path_segment", maxLength: 64 }],
        headers: { accept: "text/html,application/xhtml+xml" }
      },
      scopes: ["team"],
      itemLimit: 5,
      extraction: {
        collectionSelector: "main.news",
        itemSelector: "article.story",
        headline: { selector: "h2", source: "text" },
        url: { selector: "a", source: "attribute", attribute: "href" },
        publishedAt: { selector: "time", source: "attribute", attribute: "datetime" },
        normalize: ["trim", "collapse_whitespace"]
      }
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error(validated.reason);

    expect(
      extractSportsSourceRecipe(validated.recipe, {
        body: `<main class="news"><article class="story"><a href="https://stories.example/1"><h2> Team   update </h2></a><time datetime="2026-08-23T12:00:00Z"></time></article></main>`,
        contentType: "text/html; charset=utf-8",
        requestUrl: "https://publisher.example/team/liverpool/news"
      })
    ).toEqual({
      ok: true,
      items: [
        {
          headline: "Team update",
          url: "https://stories.example/1",
          publishedAt: "2026-08-23T12:00:00.000Z"
        }
      ]
    });
    expect(
      extractSportsSourceRecipe(validated.recipe, {
        body: `<main class="news"></main>`,
        contentType: "text/html",
        requestUrl: "https://publisher.example/team/liverpool/news"
      })
    ).toEqual({ ok: true, items: [] });
    expect(
      extractSportsSourceRecipe(validated.recipe, {
        body: `<main></main>`,
        contentType: "text/html",
        requestUrl: "https://publisher.example/team/liverpool/news"
      })
    ).toEqual({ ok: false, reason: "recipe_drift" });
    expect(
      extractSportsSourceRecipe(validated.recipe, {
        body: `<main class="news">${"<div>".repeat(129)}story${"</div>".repeat(129)}</main>`,
        contentType: "text/html",
        requestUrl: "https://publisher.example/team/liverpool/news"
      })
    ).toEqual({ ok: false, reason: "unsupported" });
  });

  it("rejects open authority and executable or undeclared recipe fields", () => {
    const unsafeRecipes = [
      { ...fotmobJsonRecipe, script: "return fetch(url)" },
      { ...fotmobJsonRecipe, fetchHosts: ["www.fotmob.com", "evil.example"] },
      {
        ...fotmobJsonRecipe,
        fetchHosts: ["github.io", "evil.github.io"],
        request: { ...fotmobJsonRecipe.request, urlTemplate: "https://github.io/news" }
      },
      {
        ...fotmobJsonRecipe,
        request: {
          ...fotmobJsonRecipe.request,
          urlTemplate: "https://www.fotmob.com:8443/api/tltv3/teams/{teamId}"
        }
      },
      {
        ...fotmobJsonRecipe,
        request: { ...fotmobJsonRecipe.request, urlTemplate: "https://www.fotmob.com/{other}" }
      },
      {
        ...fotmobJsonRecipe,
        request: {
          ...fotmobJsonRecipe.request,
          headers: { accept: "text/html,application/xhtml+xml" }
        }
      }
    ];
    for (const recipe of unsafeRecipes) {
      expect(validateSportsSourceRecipe(recipe)).toEqual({
        ok: false,
        reason: "invalid_recipe"
      });
    }

    const validated = validateSportsSourceRecipe(fotmobJsonRecipe);
    if (!validated.ok) throw new Error(validated.reason);
    expect(expandSportsSourceRecipe(validated.recipe, { teamId: "../secrets" })).toEqual({
      ok: false,
      reason: "invalid_parameters"
    });
    expect(expandSportsSourceRecipe(validated.recipe, { teamId: "8650", extra: "1" })).toEqual({
      ok: false,
      reason: "invalid_parameters"
    });

    const reordered = validateSportsSourceRecipe({
      extraction: fotmobJsonRecipe.extraction,
      itemLimit: fotmobJsonRecipe.itemLimit,
      scopes: fotmobJsonRecipe.scopes,
      request: fotmobJsonRecipe.request,
      fetchHosts: fotmobJsonRecipe.fetchHosts,
      kind: fotmobJsonRecipe.kind,
      version: fotmobJsonRecipe.version
    });
    expect(reordered.ok && reordered.fingerprint).toBe(validated.fingerprint);
  });
});

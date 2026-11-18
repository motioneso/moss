import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

// The answer has the exact shape `roster::search_body` writes for a partial search. The Rust test
// `search_makes_at_most_five_live_fetches_and_reports_partial` pins that shape on the server side.
const partialAnswer = { teams: [], partial: true, degraded: false };

async function searchWith(answer) {
  const dom = new JSDOM("<!doctype html><body></body>");
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  const { mountFollows } = await import("./follows.mjs");
  const store = {
    competitions: [],
    competitionsByKey: new Map(),
    follows: [],
    teamsByCompetition: new Map(),
    reloadFollows: async () => {}
  };
  const api = { searchTeams: async () => answer };
  const view = mountFollows({ api, store });
  const input = view.el.querySelector("input");
  input.value = "zz";
  input.dispatchEvent(new dom.window.Event("input"));
  await new Promise((resolve) => setTimeout(resolve, 600));
  return view.el.textContent;
}

test("a partial search with no matches says more leagues are still loading", async () => {
  const text = await searchWith(partialAnswer);
  assert.match(text, /still covering more leagues/i);
  assert.doesNotMatch(text, /No teams or leagues match/);
});

test("a partial search with matches keeps the results and adds the notice", async () => {
  const text = await searchWith({
    ...partialAnswer,
    teams: [{ competitionKey: "x", key: "zzz", name: "Zed Town", shortName: "Zed" }]
  });
  assert.match(text, /Still covering more leagues…/);
});

test("a complete search with no matches says so plainly", async () => {
  const text = await searchWith({ teams: [], partial: false, degraded: false });
  assert.match(text, /No teams or leagues match your search/);
});

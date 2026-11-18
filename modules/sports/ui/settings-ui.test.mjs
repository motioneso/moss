import assert from "node:assert/strict";
import test from "node:test";
import { settingsApi } from "./settings-api.mjs";
import {
  assignmentFailureCopy,
  confirmBody,
  followControlState,
  followFor,
  groupCompetitions,
  indexFollows,
  initials,
  searchLeagueRows,
  showRebuild,
  targetDisplayLabel,
  targetKey
} from "./settings-logic.mjs";

const follow = (extra) => ({
  id: "f1",
  competitionKey: "eng.1",
  teamKey: "ars",
  sourceTeamId: "359",
  ...extra
});

test("a follow matches on the permanent team id, never on a shared short key", () => {
  const index = indexFollows([follow()]);
  assert.equal(followFor(index, "eng.1", "ars", "359")?.id, "f1");
  assert.equal(followFor(index, "eng.1", "ars", "999"), undefined);
  assert.equal(followFor(index, "eng.1", "ars", null)?.id, "f1");
});

test("follow control wording tracks the state", () => {
  assert.equal(followControlState("team", "Arsenal", false, null).ariaLabel, "Follow Arsenal");
  assert.equal(followControlState("team", "Arsenal", true, null).ariaLabel, "Unfollow Arsenal");
  assert.equal(followControlState("league", "NFL", true, null).visible, "Following all of NFL");
  assert.equal(followControlState("team", "Arsenal", false, "follow").visible, "Following…");
});

test("search rows add the parent league of every team result", () => {
  const competitions = [
    { competitionKey: "eng.1", label: "Premier League" },
    { competitionKey: "nfl", label: "NFL" }
  ];
  const rows = searchLeagueRows("arsenal", [{ competitionKey: "eng.1" }], competitions);
  assert.deepEqual(
    rows.map((c) => c.competitionKey),
    ["eng.1"]
  );
});

test("standings tree groups leagues by sport and country", () => {
  const groups = groupCompetitions([
    { competitionKey: "nfl", sportLabel: "Football", regionLabel: null, label: "NFL" },
    {
      competitionKey: "eng.1",
      sportLabel: "Soccer",
      regionLabel: "England",
      label: "Premier League"
    },
    { competitionKey: "eng.2", sportLabel: "Soccer", regionLabel: "England", label: "Championship" }
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[1].regions[0].competitions.length, 2);
});

test("initials fall back to the short name, then the first letters", () => {
  assert.equal(initials("Manchester United", "mun"), "MUN");
  assert.equal(initials("Real Madrid", null), "RM");
});

test("targets resolve to plain labels", () => {
  const follows = [follow()];
  const byKey = new Map([["eng.1", { label: "Premier League" }]]);
  const teams = new Map([["eng.1", [{ teamKey: "ars", name: "Arsenal", shortName: "Arsenal" }]]]);
  assert.equal(
    targetDisplayLabel({ kind: "follow", followId: "f1" }, follows, byKey, teams),
    "Arsenal"
  );
  assert.equal(
    targetDisplayLabel({ kind: "follow", followId: "gone" }, follows, byKey, teams),
    "Unavailable team or league"
  );
  assert.equal(targetKey({ kind: "sport", sportKey: "soccer" }), "sport:soccer");
});

test("a stored preview becomes the confirm body", () => {
  const body = confirmBody({
    confirmationId: "c",
    authorizationAcknowledgement: "ok",
    candidate: {
      canonicalDomain: "a.com",
      confirmedFetchHosts: ["a.com"],
      targets: [
        {
          target: { kind: "sport", sportKey: "soccer" },
          targetUrl: "https://a.com",
          label: "Soccer"
        }
      ]
    }
  });
  assert.deepEqual(body.targets, [
    { target: { kind: "sport", sportKey: "soccer" }, targetUrl: "https://a.com" }
  ]);
});

test("failed previews give plain copy", () => {
  assert.match(
    assignmentFailureCopy({ status: "rejected", reason: "unreachable" }),
    /couldn't reach/
  );
  assert.match(assignmentFailureCopy({ status: "unavailable" }), /AI model/);
  assert.match(assignmentFailureCopy({ status: "rejected" }), /could not be verified/);
});

test("rebuild shows only for a scraped source with a missing or drifted recipe", () => {
  assert.equal(showRebuild({ retrievalMethod: "scrape", recipeStatus: "drift" }), true);
  assert.equal(showRebuild({ retrievalMethod: "feed", recipeStatus: "drift" }), false);
  assert.equal(showRebuild({ retrievalMethod: "scrape", recipeStatus: "ok" }), false);
});

test("the settings api carries a failure's status and message", async () => {
  const api = settingsApi({
    request: async () => ({ status: 422, body: { error: "Nope" } })
  });
  await assert.rejects(api.sources(), (error) => error.status === 422 && error.detail === "Nope");
  const ok = settingsApi({ request: async (m, p) => ({ status: 200, body: { m, p } }) });
  assert.deepEqual(await ok.searchTeams("a b"), { m: "GET", p: "/teams/search?q=a%20b" });
});

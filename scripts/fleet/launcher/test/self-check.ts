import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchArgs, serviceFiles } from "../src/operations.js";
import { cloneDefaults, parseBuildAnswers } from "../src/setup.js";
import { loadState, spawnsSince } from "../src/state.js";
import { tabLanes } from "../src/view.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-launcher-"));
fs.mkdirSync(path.join(dir, "tasks"));
fs.writeFileSync(path.join(dir, "run-started"), "2026-08-23T00:00:00.000Z\n");
fs.writeFileSync(
  path.join(dir, "tasks", "1.json"),
  JSON.stringify({ issue: 1, status: "done", updated_at: "2026-08-23T01:00:00.000Z" })
);
fs.writeFileSync(path.join(dir, "tasks", "2.json"), "not json");
fs.writeFileSync(
  path.join(dir, "log.jsonl"),
  '{"ts":"2026-08-24T02:00:00.000Z","issue":1,"msg":"spawn: one"}\n'
);

const state = loadState(dir);
assert.equal(state.lanes.length, 1);
assert.equal(state.errors.length, 1);
assert.equal(spawnsSince(state.logs, new Date("2026-08-24T03:00:00.000Z")), 1);
assert.equal(cloneDefaults().deputyEnabled, false);
assert.equal(parseBuildAnswers("a/low, b/high, c/medium").buildModels.security.model, "c");
assert.equal(parseBuildAnswers("a/low, b/high, c/medium").buildModels.security.effort, "medium");
// A two-part answer keeps the program already set for that kind of work.
assert.equal(
  parseBuildAnswers("a/low").buildModels.routine.tool,
  cloneDefaults().buildModels.routine.tool
);
// A three-part answer sets the program as well.
const threePart = parseBuildAnswers("some-tool/some-model/low");
assert.equal(threePart.buildModels.routine.tool, "some-tool");
assert.equal(threePart.buildModels.routine.model, "some-model");
assert.equal(threePart.buildModels.routine.effort, "low");
// Every kind of work names the program that runs it.
for (const build of Object.values(cloneDefaults().buildModels)) assert.ok(build.tool);
// Each program gets the flags it actually understands.
assert.deepEqual(launchArgs("claude", "m", "high"), [
  "--model",
  "m",
  "--effort",
  "high",
  "--permission-mode",
  "bypassPermissions"
]);
assert.deepEqual(launchArgs("codex", "m", "high"), [
  "-m",
  "m",
  "-c",
  "model_reasoning_effort=high",
  "-s",
  "danger-full-access",
  "-a",
  "never"
]);
assert.deepEqual(launchArgs("something-else", "m", "high"), ["--model", "m"]);
assert.equal(tabLanes(state, "Done Tonight").length, 1);
const completed = state.lanes[0];
assert.ok(completed);
completed.updated_at = "2026-08-22T23:00:00.000Z";
assert.equal(tabLanes(state, "Done Tonight").length, 0);

const service = serviceFiles(dir, path.join(dir, "config"));
assert.match(service.serviceText, /Environment=JARV1S_FLEET_STATE=/);
assert.match(service.timerText, /WantedBy=timers\.target/);

const sourceDir = path.resolve(import.meta.dirname, "../src");
const seed = fs.readFileSync(path.join(sourceDir, "setup.ts"), "utf8");
const modelNames = [...seed.matchAll(/model: "([^"]+)"/g)].map((match) => match[1]);
for (const file of fs
  .readdirSync(sourceDir)
  .filter((name) => /\.(ts|tsx)$/.test(name) && name !== "setup.ts")) {
  const source = fs.readFileSync(path.join(sourceDir, file), "utf8");
  for (const name of modelNames)
    assert.doesNotMatch(
      source,
      new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b`)
    );
}
console.log("fleet launcher self-check passed");

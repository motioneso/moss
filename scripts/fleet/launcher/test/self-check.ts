import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serviceFiles } from "../src/operations.js";
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

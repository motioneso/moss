import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { rustGateEntries } from "../../scripts/rust-gate-matrix.mjs";

test("only touched modules produce entries, including an empty change", () => {
  assert.deepEqual(rustGateEntries([]), []);
  assert.deepEqual(rustGateEntries(["tasks"]), [
    { module: "tasks", suite: "full", gates: "test:rust-tasks" }
  ]);
});

test("Memory and News retain every database file and companion gate", () => {
  const entries = rustGateEntries(["memory", "news"]);
  assert.deepEqual(
    entries.map(({ module, suite }) => `${module}/${suite}`),
    [
      "memory/db",
      "memory/dashboard",
      "memory/recording",
      "memory/reembed",
      "memory/account",
      "memory/index",
      "memory/oracle",
      "news/installed",
      "news/reader"
    ]
  );
  assert.equal(entries.find(({ suite }) => suite === "index").gates, "test:rust-memory-index");
  assert.equal(entries.find(({ suite }) => suite === "oracle").gates, "test:rust-memory-oracle");
  assert.equal(entries.find(({ suite }) => suite === "reader").gates, "test:rust-news-reader");
});

test("Connectors partitions prerequisite files and database files without its PR benchmark", () => {
  const entries = rustGateEntries(["connectors"]);
  assert.deepEqual(entries.map(({ suite }) => suite).sort(), [
    "db",
    "google",
    "google_sync",
    "imap",
    "mail_probe",
    "outlook",
    "package",
    "refresh",
    "registry",
    "writes"
  ]);
  assert.ok(entries.every(({ gates }) => gates === "test:rust-connectors"));
});

test("manual runs retain the Connectors speed benchmark in its own entry", () => {
  const pr = rustGateEntries(["connectors"]);
  const manual = rustGateEntries(["connectors"], "workflow_dispatch");
  assert.deepEqual(manual.slice(0, -1), pr);
  assert.deepEqual(manual.at(-1), {
    module: "connectors",
    suite: "sync_speed",
    gates: "test:rust-connectors"
  });
});

test("other modules keep their original gates and every command exists", () => {
  const modules = [
    "backtrack",
    "briefings",
    "calendar",
    "commitments",
    "connectors",
    "email",
    "finance",
    "goals",
    "meals",
    "meetings",
    "memory",
    "news",
    "notes",
    "people",
    "scratchpad",
    "sports",
    "tasks",
    "weather",
    "web-research",
    "wellness"
  ];
  const entries = rustGateEntries(modules);
  const { scripts } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url)));
  for (const { gates } of entries) {
    for (const gate of gates.split(" ")) assert.ok(scripts[gate], `Missing script ${gate}`);
  }
  assert.equal(
    new Set(entries.map(({ module, suite }) => `${module}/${suite}`)).size,
    entries.length
  );
  assert.equal(
    entries.find(({ module }) => module === "finance").gates,
    "test:rust-finance test:rust-finance-ui-unit"
  );
  assert.equal(
    entries.find(({ module }) => module === "meetings").gates,
    "test:rust-meetings test:rust-meetings-oracle test:rust-recording-oracle"
  );
});

test("the CLI emits the JSON consumed by the workflow", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/rust-gate-matrix.mjs", '["memory","news","connectors"]'],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), rustGateEntries(["memory", "news", "connectors"]));
});

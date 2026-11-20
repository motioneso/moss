import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { rustGateEntries } from "../../scripts/rust-gate-matrix.mjs";
import {
  memoryControlArgs,
  memoryGuardControls
} from "../../modules/memory/tools/control-selection.ts";
import {
  connectorsControlArgs,
  connectorsGuardControls
} from "../../modules/connectors/tools/control-selection.ts";

test("only touched modules produce entries, including an empty change", () => {
  assert.deepEqual(rustGateEntries([]), []);
  assert.deepEqual(rustGateEntries(["tasks"]), [
    { module: "tasks", suite: "full", gates: "test:rust-tasks" }
  ]);
});

test("Memory and News retain every database file and companion gate", () => {
  const entries = rustGateEntries(["memory", "news"], "workflow_dispatch");
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
    "registry",
    "writes"
  ]);
  assert.ok(entries.every(({ gates }) => gates === "test:rust-connectors"));
});

test("manual runs retain the Connectors speed benchmark in its own entry", () => {
  const pr = rustGateEntries(["connectors"]);
  const manual = rustGateEntries(["connectors"], "workflow_dispatch");
  assert.deepEqual(
    manual
      .filter(({ suite }) => suite !== "refresh" && suite !== "sync_speed")
      .map(({ suite }) => suite),
    pr.map(({ suite }) => suite)
  );
  assert.ok(manual.some(({ suite }) => suite === "refresh"));
  assert.ok(manual.every(({ controls }) => controls === "all"));
  assert.deepEqual(manual.at(-1), {
    module: "connectors",
    suite: "sync_speed",
    gates: "test:rust-connectors",
    controls: "all"
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

test("kill tier moves only measured slow files and Memory controls off PRs", () => {
  const pr = rustGateEntries(["memory", "news"]);
  assert.deepEqual(
    pr.map(({ module, suite }) => `${module}/${suite}`),
    [
      "memory/dashboard",
      "memory/recording",
      "memory/reembed",
      "memory/account",
      "memory/index",
      "memory/oracle",
      "news/reader"
    ]
  );
  assert.ok(
    pr
      .filter(({ gates }) => gates === "test:rust-memory")
      .every(({ controls }) => controls === "skip")
  );
  const push = rustGateEntries(["memory", "news", "tasks"], "push");
  assert.deepEqual(
    push.map(({ module, suite }) => `${module}/${suite}`),
    ["memory/db", "memory/account", "memory/recording", "memory/reembed", "news/installed"]
  );
  assert.ok(
    push
      .filter(({ suite }) => suite !== "db" && suite !== "installed")
      .every(({ controls }) => controls === "only")
  );
  assert.deepEqual(rustGateEntries(["tasks"], "push"), []);
  assert.deepEqual(rustGateEntries([], "push"), []);
});

test("Memory PR and push filters partition existing test functions without losing controls", () => {
  for (const [suite, control] of Object.entries(memoryGuardControls)) {
    const source = readFileSync(
      new URL(`../../modules/memory/host/tests/${suite}.rs`, import.meta.url),
      "utf8"
    );
    const names = [...source.matchAll(/#\[test\][\s\S]*?fn (\w+)\(/g)].map((m) => m[1]);
    assert.ok(names.includes(control), `${suite}: control must exist`);
    const only = memoryControlArgs(suite, "only");
    const skip = memoryControlArgs(suite, "skip");
    assert.deepEqual(only, [control, "--exact"]);
    assert.deepEqual(skip, ["--skip", control, "--exact"]);
    const onPush = names.filter((name) => name === only[0]);
    const onPr = names.filter((name) => name !== skip[1]);
    assert.equal(onPush.length, 1);
    assert.equal(new Set([...onPush, ...onPr]).size, names.length);
    assert.deepEqual(memoryControlArgs(suite), []);
  }
  assert.throws(() => memoryControlArgs("account", "unknown"));
  assert.throws(() => memoryControlArgs("dashboard", "only"));
  assert.deepEqual(memoryControlArgs("dashboard", "skip"), []);
});

test("Connectors kill tier moves refresh and its existing removal controls to main", () => {
  const pr = rustGateEntries(["connectors"]);
  assert.equal(pr.length, 9);
  assert.ok(pr.every(({ suite, controls }) => suite !== "refresh" && controls === "skip"));
  const push = rustGateEntries(["connectors"], "push");
  assert.deepEqual(
    push.map(({ suite }) => suite),
    ["refresh", "db", "google_sync", "google", "imap", "writes"]
  );
  assert.ok(push.slice(1).every(({ controls }) => controls === "only"));
  assert.equal(push[0].controls, undefined);
});

test("Connectors PR/push filters preserve every existing test and every removal control", () => {
  const manual = rustGateEntries(["connectors"], "workflow_dispatch");
  for (const { suite } of manual) {
    const source = readFileSync(
      new URL(`../../modules/connectors/host/tests/${suite}.rs`, import.meta.url),
      "utf8"
    );
    const tests = [...source.matchAll(/#\[test\][\s\S]*?fn (\w+)\([\s\S]*?(?=\n#\[test\]|$)/g)];
    const names = tests.map((m) => m[1]);
    const controls = connectorsGuardControls[suite] ?? [];
    for (const control of controls)
      assert.ok(names.includes(control), `${suite}: missing ${control}`);
    for (const test of tests) {
      if (test[0].includes("DISABLE ROW LEVEL SECURITY")) {
        assert.ok(
          suite === "refresh" || controls.includes(test[1]),
          `${suite}: unpartitioned removal control ${test[1]}`
        );
      }
    }
    const only = suite === "refresh" ? names : names.filter((name) => controls.includes(name));
    const skip = suite === "refresh" ? [] : names.filter((name) => !controls.includes(name));
    assert.equal(new Set([...only, ...skip]).size, names.length);
    assert.deepEqual(connectorsControlArgs(suite), []);
    if (controls.length) {
      assert.deepEqual(connectorsControlArgs(suite, "only"), [...controls, "--exact"]);
      assert.deepEqual(connectorsControlArgs(suite, "skip"), [
        ...controls.flatMap((name) => ["--skip", name]),
        "--exact"
      ]);
    } else {
      assert.deepEqual(connectorsControlArgs(suite, "skip"), []);
      assert.throws(() => connectorsControlArgs(suite, "only"));
    }
  }
  assert.throws(() => connectorsControlArgs("google", "unknown"));
});

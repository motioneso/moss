import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CliSourceEngine } from "../../packages/chat/src/live/cli-source-engine.js";
import { createScopedSourceEngine } from "../../packages/cli-runner/src/source-engine.js";
import {
  publishGeminiCredential,
  scopedGeminiCredentialPath
} from "../../packages/cli-runner/src/gemini-credential-store.js";

const scope = { actorUserId: "actor-a", providerConfigId: "config-a" };
const model = "configured-gemini-model";
const record = (token: string) => ({
  account: "fixture@example.invalid",
  oauth: {
    access_token: token,
    refresh_token: "synthetic-refresh",
    token_type: "Bearer",
    expiry_date: 1
  }
});
const guard = () => ({ kind: "login" as const, isCurrent: () => true, onPublished: () => {} });
let root: string;
let credential: string;
const engines: CliSourceEngine[] = [];
const opts = { model, schema: {}, neutralDir: "unused", personaPath: "unused" };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gemini-engine-test-"));
  await mkdir(join(root, "bin"));
  credential = scopedGeminiCredentialPath(root, scope);
  await publishGeminiCredential(root, scope, record("original"), guard());
  vi.stubEnv("JARVIS_CLI_TOOLS_PREFIX", root);
  vi.stubEnv("GEMINI_API_KEY", "ambient-must-not-inherit");
});
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.kill()));
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function script(body = "") {
  await writeFile(
    join(root, "bin/gemini"),
    `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
if (process.env.GEMINI_API_KEY) process.exit(3);
const file = path.join(process.env.HOME, '.gemini/oauth_creds.json');
const original = JSON.parse(fs.readFileSync(file, 'utf8'));
if (original.access_token !== 'original') process.exit(4);
let input = ''; process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const refreshed = {...original, access_token: 'rotated', expiry_date: 99};
  fs.writeFileSync(file, JSON.stringify(refreshed));
  const value = {home: process.env.HOME, word: 'café 🐈', received: input.includes('source-task')};
  ${body}
  fs.writeSync(1, JSON.stringify({type:'init',model:${JSON.stringify(model)}})+'\\n'+JSON.stringify({type:'message',role:'assistant',content:JSON.stringify(value)})+'\\n'+JSON.stringify({type:'result',status:'success'})+'\\n');
});`,
    { mode: 0o700 }
  );
}
async function launch(
  engine = createScopedSourceEngine(root, {
    provider: "google",
    model,
    personaText: "source only",
    schema: {},
    scope
  })
) {
  engines.push(engine);
  await engine.launchStructured(opts);
  return engine;
}
async function complete(engine: CliSourceEngine) {
  await vi.waitFor(async () => expect(await engine.isAlive()).toBe(false));
  return engine.readStructured(0);
}

it("composes scoped source and native refresh, returns no partial output and publishes only once", async () => {
  await script();
  const engine = await launch();
  expect(await engine.readStructured(0)).toEqual({ offset: 0, complete: false });
  await engine.submitStructured("source-task");
  const result = await complete(engine);
  const value = JSON.parse(result.text!);
  expect(value).toMatchObject({ word: "café 🐈", received: true });
  expect(JSON.parse(await readFile(credential, "utf8"))).toEqual({
    ...record("rotated"),
    oauth: { ...record("rotated").oauth, expiry_date: 99 }
  });
  await publishGeminiCredential(root, scope, record("new-login"), guard());
  expect(await engine.readStructured(0)).toEqual(result);
  expect(JSON.parse(await readFile(credential, "utf8"))).toEqual(record("new-login"));
  await engine.kill();
  await expect(access(value.home)).rejects.toThrow();
  await expect(engine.readStructured(0)).rejects.toThrow("stopped");
  const foreign = createScopedSourceEngine(root, {
    provider: "google",
    model,
    schema: {},
    personaText: "source",
    scope: { ...scope, actorUserId: "foreign" }
  });
  engines.push(foreign);
  await expect(foreign.launchStructured(opts)).rejects.toThrow("credential is unavailable");
});

it("rejects tool activity, rotated token echoes, overflow and unsuccessful exit without credential publication", async () => {
  for (const body of [
    "fs.writeSync(1, JSON.stringify({type:'tool_use',tool_name:'read_file'})+'\\n');",
    "value.word = 'rotated';",
    "fs.writeSync(2, 'x'.repeat(65537));",
    "process.exit(2);"
  ]) {
    await script(body);
    const engine = await launch();
    await engine.submitStructured("source-task");
    await expect(complete(engine)).rejects.toThrow();
    expect(JSON.parse(await readFile(credential, "utf8"))).toEqual(record("original"));
    await engine.kill();
  }
});

it("fences a newer login and cancellation during asynchronous refresh publication", async () => {
  await script();
  const stale = await launch();
  await publishGeminiCredential(root, scope, record("new-login"), guard());
  await stale.submitStructured("source-task");
  expect((await complete(stale)).complete).toBe(true);
  expect(JSON.parse(await readFile(credential, "utf8"))).toEqual(record("new-login"));
  await stale.kill();
  await publishGeminiCredential(root, scope, record("original"), guard());
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let published: boolean | undefined;
  const engine = await launch(
    new CliSourceEngine("google", credential, async (version, updated, isCurrent) => {
      entered();
      await barrier;
      published = await publishGeminiCredential(root, scope, updated, {
        kind: "refresh",
        expectedVersion: version,
        isCurrent,
        onPublished: () => {}
      });
    })
  );
  await engine.submitStructured("source-task");
  const reading = complete(engine);
  const rejected = expect(reading).rejects.toThrow("stopped");
  await started;
  const killing = engine.kill();
  release();
  await killing;
  await rejected;
  expect(published).toBe(false);
  expect(JSON.parse(await readFile(credential, "utf8"))).toEqual(record("original"));
});

it("reaps inherited-group descendants on successful parent exit without stopping an unrelated process", async () => {
  const peer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const peerClosed = new Promise<void>((resolve) => peer.once("close", () => resolve()));
  const marker = join(root, "descendant-pid");
  await script(`
    const kid = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'inherit'});
    fs.writeFileSync(${JSON.stringify(marker)}, String(kid.pid));
    process.nextTick(() => process.exit(0));
  `);
  try {
    const engine = await launch();
    await engine.submitStructured("source-task");
    expect((await complete(engine)).complete).toBe(true);
    const pid = Number(await readFile(marker, "utf8"));
    await vi.waitFor(async () => {
      const state = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
      expect(!state || /\) Z /.test(state)).toBe(true);
    });
    expect(() => process.kill(peer.pid!, 0)).not.toThrow();
  } finally {
    peer.kill("SIGKILL");
    await peerClosed;
  }
});

it("cancellation during private preparation cannot start a late source process", async () => {
  await script();
  const engine = new CliSourceEngine("google", credential);
  engines.push(engine);
  const starting = expect(engine.launchStructured(opts)).rejects.toThrow("could not launch");
  await engine.kill();
  await starting;
  expect(await engine.isAlive()).toBe(false);
  await expect(engine.submitStructured("late")).rejects.toThrow("unavailable");
});

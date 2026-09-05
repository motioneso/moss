import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TmuxIo } from "@moss/ai";

import { ClaudePrintChatEngine } from "../../packages/chat/src/live/claude-print-chat-engine.js";
import {
  createClaudeSourceLaunch,
  SOURCE_CLI_TIMEOUT_MS
} from "../../packages/chat/src/live/claude-source-policy.js";

const token = "synthetic-source-test-token";
const model = "claude-sonnet-4-6";
const init = {
  type: "system",
  subtype: "init",
  model,
  mcp_servers: [],
  tools: ["StructuredOutput"]
};
const result = {
  type: "result",
  subtype: "success",
  is_error: false,
  structured_output: { text: "café 🐈" }
};
const records = (...items: unknown[]) =>
  items.map((item) => JSON.stringify(item)).join("\n") + "\n";
let root: string;
let credential: string;
let engine: ClaudePrintChatEngine | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "moss-source-test-"));
  credential = join(root, "credential");
  await writeFile(credential, token, { mode: 0o600 });
  await mkdir(join(root, "bin"));
  vi.stubEnv("JARVIS_CLI_TOOLS_PREFIX", root);
  vi.stubEnv("SOURCE_AMBIENT_SECRET", "must-not-inherit");
});

afterEach(async () => {
  vi.useRealTimers();
  await engine?.kill();
  engine = undefined;
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it("uses an empty private home, explicit no-tool policy and a minimal environment", async () => {
  const launch = await createClaudeSourceLaunch({ model, schema: {} }, credential);
  try {
    expect(launch.cwd).not.toBe(root);
    expect(launch.env.HOME).toBe(launch.cwd);
    expect(Object.keys(launch.env).sort()).toEqual([
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CONFIG_DIR",
      "HOME",
      "PATH"
    ]);
    expect(launch.args).toEqual(
      expect.arrayContaining([
        "--no-session-persistence",
        "--strict-mcp-config",
        "--tools",
        "--setting-sources"
      ])
    );
    expect(launch.args[launch.args.indexOf("--tools") + 1]).toBe("");
    expect(launch.args[launch.args.indexOf("--setting-sources") + 1]).toBe("");
    expect(JSON.parse(launch.args[launch.args.indexOf("--mcp-config") + 1]!)).toEqual({
      mcpServers: {}
    });
    expect(JSON.parse(launch.args[launch.args.indexOf("--settings") + 1]!)).toEqual({
      disableAllHooks: true,
      autoMemoryEnabled: false
    });
    expect(launch.args.join(" ")).not.toContain(token);
    expect(launch.readResult(records(init, result))).toBe(JSON.stringify(result.structured_output));
  } finally {
    await launch.dispose();
  }
  await expect(access(launch.cwd)).rejects.toThrow();
});

it("rejects unavailable credentials and non-concrete models before launch", async () => {
  for (const selected of [undefined, "", "default"]) {
    await expect(
      createClaudeSourceLaunch({ model: selected, schema: {} }, credential)
    ).rejects.toThrow("requires");
  }
  await expect(
    createClaudeSourceLaunch({ model, schema: {} }, join(root, "missing"))
  ).rejects.toThrow("credential is unavailable");
});

it("rejects authority changes, malformed or failed results and credential echoes", async () => {
  const launch = await createClaudeSourceLaunch({ model, schema: {} }, credential);
  try {
    for (const output of [
      records({ ...init, model: "other-model" }, result),
      records({ ...init, tools: ["Bash"] }, result),
      records({ ...init, mcp_servers: [{ name: "ambient" }] }, result),
      records(
        init,
        { type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } },
        result
      ),
      records(init, { ...result, is_error: true }),
      records(init, { ...result, structured_output: [] }),
      records(init, result, result),
      records(result),
      records(null),
      "private invalid output"
    ])
      expect(() => launch.readResult(output)).toThrow("failed policy validation");
    expect(() =>
      launch.readResult(records(init, { ...result, structured_output: { token } }))
    ).toThrow("protected data");
    expect(() =>
      launch.readResult(
        records(init, { ...result, structured_output: { token } }).replace(
          token,
          "\\u0073" + token.slice(1)
        )
      )
    ).toThrow("protected data");
  } finally {
    await launch.dispose();
  }
});

async function launchFake(body: string) {
  const executable = join(root, "bin/claude");
  await writeFile(executable, `#!${process.execPath}\n${body}\n`);
  await chmod(executable, 0o700);
  const io: TmuxIo = {
    run: vi.fn(async () => ({ code: 0, stdout: "" })),
    readFile: vi.fn(async () => ""),
    writeFile: vi.fn(async () => undefined),
    sleep: vi.fn(async () => undefined)
  };
  engine = new ClaudePrintChatEngine("source-test", io, { credentialFile: credential });
  await engine.launchStructured({
    sourceGeneration: true,
    model,
    schema: {},
    neutralDir: root,
    personaPath: "unused"
  });
  return engine;
}

it("spawns directly, preserves split UTF-8, waits for close and removes the private home", async () => {
  const marker = join(root, "ready");
  const source = await launchFake(`
    const fs = require('node:fs');
    process.stdin.resume();
    process.stdin.on('end', () => {
      const reply = ${JSON.stringify(result)};
      reply.structured_output.home = process.cwd();
      reply.structured_output.ambient = process.env.SOURCE_AMBIENT_SECRET ?? null;
      const output = Buffer.from(JSON.stringify(${JSON.stringify(init)}) + '\\n' + JSON.stringify(reply) + '\\n');
      let i = 0;
      function write() {
        if (i < output.length) { fs.writeSync(1, output.subarray(i, ++i)); setImmediate(write); }
        else {
          fs.writeFileSync(${JSON.stringify(marker)}, process.cwd());
          setInterval(() => { if (fs.existsSync(${JSON.stringify(marker + ".release")})) process.exit(0); }, 10);
        }
      }
      write();
    });
  `);
  await source.submitStructured("source please");
  await vi.waitFor(async () => expect(await readFile(marker, "utf8")).toBeTruthy());
  expect((await source.readStructured(0)).complete).toBe(false);
  await writeFile(marker + ".release", "");
  await vi.waitFor(async () => expect(await source.isAlive()).toBe(false));
  const reply = JSON.parse((await source.readStructured(0)).text!);
  expect(reply.text).toBe("café 🐈");
  expect(reply.ambient).toBeNull();
  await source.kill();
  await expect(access(reply.home)).rejects.toThrow();
});

it.each([
  [
    "require('node:fs').writeSync(1, " +
      JSON.stringify(records(init, result)) +
      "); process.exitCode = 7;",
    "exited unsuccessfully"
  ],
  ["require('node:fs').writeSync(2, 'x'.repeat(70000));", "output exceeded its limit"]
])("rejects process failure or excess output: %s", async (body, error) => {
  const source = await launchFake(
    `process.stdin.resume(); process.stdin.on('end', () => { ${body} });`
  );
  await source.submitStructured("source please");
  await vi.waitFor(async () => expect(await source.isAlive()).toBe(false));
  await expect(source.readStructured(0)).rejects.toThrow(error);
});

it("enforces its own deadline and cannot return a result after kill", async () => {
  vi.useFakeTimers();
  const source = await launchFake("process.stdin.resume(); setInterval(() => {}, 1000);");
  await vi.advanceTimersByTimeAsync(SOURCE_CLI_TIMEOUT_MS + 1);
  await expect(source.readStructured(0)).rejects.toThrow("timed out");
  await source.kill();
  await expect(source.readStructured(0)).rejects.toThrow();
});

it("sanitizes missing-executable errors", async () => {
  const source = await launchFake("process.stdin.resume();");
  await source.kill();
  await rm(join(root, "bin/claude"));
  await source.launchStructured({
    sourceGeneration: true,
    model,
    schema: {},
    neutralDir: root,
    personaPath: "unused"
  });
  await vi.waitFor(async () => expect(await source.isAlive()).toBe(false));
  await expect(source.readStructured(0)).rejects.toThrow("could not launch");
});

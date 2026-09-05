// Run through `docker exec -i Moss node --input-type=module` in the trusted provider
// environment. Only validated source goes to stdout; never execute returned code here.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "workshop-a0-claude-"));
const web = process.env.WORKSHOP_PROOF_WEB === "1";
const paths = web
  ? ["src/worker/index.ts", "src/web/index.ts", "src/web/styles.css"]
  : ["src/worker/index.ts"];
const schema = {
  type: "object",
  additionalProperties: false,
  required: ["files"],
  properties: {
    files: {
      type: "array",
      minItems: paths.length,
      maxItems: paths.length,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content"],
        properties: {
          path: { enum: paths },
          content: { type: "string", maxLength: 12000 }
        }
      }
    }
  }
};
const prompt =
  "Generate one minimal TypeScript worker for a word-of-the-day module. " +
  "Import defineModuleWorker from @moss/module-sdk/worker. Its API takes an object " +
  "with handlers: Record<string, (context) => Promise<unknown>> and starts the JSON-RPC " +
  "worker itself. Register word.read to return the object {word: 'quasar'}. " +
  "Use no other imports, I/O, tools, dependencies, or manual protocol handling. " +
  "Return only the source artifact matching the supplied schema. Do not read any files." +
  (web
    ? " Also generate src/web/index.ts and src/web/styles.css. The web entry imports h, useState, " +
      "and Button from @moss/module-web-sdk and CSS text from ./styles.css. Export default " +
      "{contractVersion: 2, Root, css}. Root is a React component using h (no JSX), a main " +
      "with className workshop-word, heading Daily word, and a Button labeled Show word. " +
      "Its onClick sets local state to quasar, displayed in a paragraph. Use Button with " +
      "only type, onClick and children props. CSS must contain a .workshop-word rule. " +
      "No fetch, effects, storage or other imports. Return the worker first, web entry second, CSS third."
    : "");

let child;
let timer;
function killOwnedGroup() {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
try {
  await mkdir(join(home, "config"));
  const credential = (await readFile("/data/cli-auth/.jarvis/cli-tokens/anthropic", "utf8")).trim();
  assert.ok(credential.length > 0, "Existing Moss Claude credential is empty");
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "sonnet",
    "--max-budget-usd",
    "0.50",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--setting-sources",
    "",
    "--settings",
    '{"disableAllHooks":true,"autoMemoryEnabled":false}',
    "--system-prompt",
    "Generate source data only. Use no tools.",
    "--json-schema",
    JSON.stringify(schema)
  ];
  const output = await new Promise((resolve, reject) => {
    child = spawn("/data/cli-tools/bin/claude", args, {
      cwd: home,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, "config"),
        PATH: "/data/cli-tools/bin:/usr/local/bin:/usr/bin:/bin",
        CLAUDE_CODE_OAUTH_TOKEN: credential,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
      }
    });
    let stdout = "";
    let bytes = 0;
    const fail = (message) => {
      killOwnedGroup();
      reject(new Error(message));
    };
    timer = setTimeout(() => fail("Claude proof exceeded 120-second deadline"), 120_000);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 65_536) return fail("Claude proof exceeded output limit");
        if (stream === child.stdout) stdout += chunk.toString();
      });
    }
    child.on("error", () => fail("Claude proof could not launch"));
    child.stdin.on("error", () => fail("Claude proof input failed"));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Claude proof exited ${code}; raw output withheld`));
      else resolve(stdout);
    });
    child.stdin.end(prompt);
  });
  assert.ok(!output.includes(credential), "Credential appeared in provider output");
  const records = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const init = records.find((record) => record.type === "system" && record.subtype === "init");
  assert.ok(init && typeof init.model === "string");
  assert.deepEqual(init.mcp_servers, []);
  assert.ok(Array.isArray(init.tools) && init.tools.every((tool) => tool === "StructuredOutput"));
  for (const record of records) {
    for (const block of record.message?.content ?? []) {
      if (block.type === "tool_use") assert.equal(block.name, "StructuredOutput");
    }
  }
  const results = records.filter((record) => record.type === "result");
  assert.equal(results.length, 1);
  const result = results[0];
  assert.equal(result.subtype, "success");
  assert.equal(result.is_error, false);
  const artifact = result.structured_output;
  assert.deepEqual(Object.keys(artifact), ["files"]);
  assert.ok(Array.isArray(artifact.files) && artifact.files.length === paths.length);
  for (const [index, entry] of artifact.files.entries()) {
    assert.deepEqual(Object.keys(entry).sort(), ["content", "path"]);
    assert.equal(entry.path, paths[index]);
    assert.equal(typeof entry.content, "string");
  }
  const encoded = JSON.stringify(artifact);
  assert.ok(Buffer.byteLength(encoded) <= 16_384);
  console.error(
    JSON.stringify({
      check: "authenticated-claude-source-generation",
      status: "pass",
      web,
      model: init.model,
      cliVersion: init.claude_code_version,
      tools: init.tools,
      mcpServers: init.mcp_servers,
      artifactSha256: createHash("sha256").update(encoded).digest("hex"),
      bytes: Buffer.byteLength(encoded)
    })
  );
  process.stdout.write(encoded);
} finally {
  clearTimeout(timer);
  killOwnedGroup();
  await rm(home, { recursive: true, force: true });
  console.error(
    JSON.stringify({ check: "trusted-provider-temporary-home-cleanup", status: "pass" })
  );
}

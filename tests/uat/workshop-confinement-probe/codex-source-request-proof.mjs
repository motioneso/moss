// Installed CLI + local Responses fixture only. No real credentials or vendor model calls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { crc32 } from "node:zlib";

const root = await mkdtemp("/tmp/workshop-codex-source-");
const home = join(root, "home");
const cwd = join(root, "neutral");
const model = "workshop-synthetic-source-model";
const artifact = JSON.stringify({ word: "quasar" });
const sentinel = join(root, "synthetic-private.png");
const requests = [];
let failure;
let child;
let closed;
let timer;
let stage = "setup";
const stop = () => {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/responses");
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      assert.ok(size <= 1_048_576);
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    assert.equal(body.model, model);
    assert.deepEqual(body.tools.map((tool) => tool.name).sort(), [
      "request_user_input",
      "update_plan",
      "view_image"
    ]);
    assert.ok(requests.length <= 2, "Unexpected extra model request");
    const containsImage = (value) => {
      if (!value || typeof value !== "object") return false;
      if (
        value.type === "input_image" &&
        typeof value.image_url === "string" &&
        value.image_url.startsWith("data:image/")
      )
        return true;
      return Object.values(value).some(containsImage);
    };
    if (requests.length === 2) {
      assert.equal(containsImage(body.input), false, "Native tool unexpectedly attached an image");
      const toolReply = body.input.find(
        (item) => item.type === "function_call_output" && item.call_id === "call_probe"
      );
      assert.ok(toolReply, "No native-tool result returned to the model");
      assert.match(JSON.stringify(toolReply.output), /No permissions to create new namespace/);
    }
    const item =
      requests.length === 1
        ? {
            id: "fc_probe",
            type: "function_call",
            call_id: "call_probe",
            name: "view_image",
            arguments: JSON.stringify({ path: sentinel }),
            status: "completed"
          }
        : {
            id: "msg_probe",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: artifact, annotations: [] }]
          };
    const response = {
      id: "resp_probe",
      object: "response",
      model,
      status: "completed",
      output: [item],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        output_tokens_details: { reasoning_tokens: 0 }
      }
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const events = [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response }
    ];
    for (const event of events)
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  } catch (error) {
    failure = error;
    res.writeHead(400);
    res.end();
    stop();
  }
});
try {
  await mkdir(home);
  await mkdir(cwd);
  await writeFile(
    sentinel,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
      "base64"
    )
  );
  const png = await readFile(sentinel);
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    assert.equal(
      crc32(png.subarray(offset + 4, offset + 8 + length)),
      png.readUInt32BE(offset + 8 + length)
    );
    offset += length + 12;
  }
  await server.listen(0, "127.0.0.1");
  if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const schema = join(root, "schema.json");
  const output = join(root, "result.json");
  await writeFile(
    schema,
    JSON.stringify({
      type: "object",
      properties: { word: { const: "quasar" } },
      required: ["word"],
      additionalProperties: false
    })
  );
  await writeFile(
    join(home, "config.toml"),
    [
      'model_provider = "source_probe"',
      "[model_providers.source_probe]",
      'name = "Local source proof"',
      `base_url = "http://127.0.0.1:${address.port}"`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "request_max_retries = 0",
      "stream_max_retries = 0",
      "supports_websockets = false"
    ].join("\n")
  );
  stage = "installed-cli-request";
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--model",
    model,
    "--output-schema",
    schema,
    "--output-last-message",
    output
  ];
  for (const value of [
    'approval_policy="never"',
    'web_search="disabled"',
    "tools.view_image=false",
    "features.shell_tool=false",
    "features.apply_patch_tool=false",
    "features.multi_agent=false",
    "features.hooks=false",
    "features.apps=false",
    "features.plugins=false",
    "features.code_mode.enabled=false",
    "check_for_update_on_startup=false",
    "analytics.enabled=false",
    "feedback.enabled=false"
  ])
    args.push("-c", value);
  args.push("Return the word quasar as JSON. Use no tools.");
  child = spawn("/data/cli-tools/bin/codex", args, {
    cwd,
    detached: true,
    env: { HOME: home, CODEX_HOME: home, PATH: "/data/cli-tools/bin:/usr/local/bin:/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let bytes = 0;
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 65_536) {
        failure = new Error("Output overflow");
        stop();
      }
    });
  closed = new Promise((resolve) => {
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", resolve);
  });
  timer = setTimeout(() => {
    failure = new Error("CLI timeout");
    stop();
  }, 30_000);
  const code = await closed;
  // Never include raw CLI output in evidence records.
  if (code !== 0 || failure) {
    console.error(
      JSON.stringify({
        check: stage,
        status: "fail",
        requests: requests.length,
        tools: requests.map((r) => r.tools?.map((t) => ({ type: t.type, name: t.name })))
      })
    );
    throw new Error("Installed source request did not pass");
  }
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), { word: "quasar" });
  console.log(
    JSON.stringify({
      check: "codex-source-policy-negative-control",
      status: "pass",
      requests: 2,
      tools: requests[0].tools.map((tool) => tool.name),
      candidateRejected: true,
      nativeSyntheticImageReadAttempted: true,
      filesystemHelperBlockedByContainer: true,
      imageAttached: false,
      concreteModel: model,
      credentialFilesSupplied: false,
      vendorModelCalls: 0
    })
  );
} catch {
  process.exitCode = 1;
  console.error(JSON.stringify({ check: "codex-source-request", status: "fail", stage }));
} finally {
  if (timer) clearTimeout(timer);
  stop();
  await closed;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ check: "codex-source-request-cleanup", status: "pass" }));
}

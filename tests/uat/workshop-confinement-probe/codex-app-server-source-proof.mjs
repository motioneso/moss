// Public pinned CLI + synthetic local Responses only; this is a rejected-policy control.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";

const binary = "/probe/codex";
const version = execFileSync(binary, ["--version"], {
  env: { HOME: "/tmp", CODEX_HOME: "/tmp", PATH: "/usr/bin:/bin" },
  timeout: 10000,
  maxBuffer: 65536,
  encoding: "utf8"
}).trim();
assert.equal(version, "codex-cli 0.144.5");
for (const variant of ["default", "empty-environment", "empty-roots"]) {
  const emptyEnvironment = variant !== "default";
  const root = await mkdtemp("/tmp/workshop-codex-app-server-");
  await mkdir(`${root}/home`);
  await mkdir(`${root}/cwd`);
  const requests = [];
  let fixtureError;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/responses");
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        assert.ok(bytes <= 1048576);
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(body);
      assert.equal(body.model, "workshop-synthetic-source-model");
      assert.equal(requests.length, 1);
      const item = {
        id: "msg_probe",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: '{"word":"quasar"}', annotations: [] }]
      };
      const response = {
        id: "resp_probe",
        object: "response",
        model: body.model,
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
      for (const event of [
        { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response }
      ])
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    } catch (error) {
      fixtureError = error;
      res.writeHead(400);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const child = spawn(binary, ["app-server"], {
    cwd: `${root}/cwd`,
    detached: true,
    env: { HOME: `${root}/home`, CODEX_HOME: `${root}/home`, PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  const pending = new Map();
  let id = 0,
    buffer = "",
    bytes = 0;
  const events = [];
  let finish;
  const completed = new Promise((resolve) => {
    finish = resolve;
  });
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const timer = setTimeout(stop, 30000);
  child.once("close", () => {
    for (const handler of pending.values()) handler.reject(new Error("app-server closed"));
    finish({ error: "closed" });
  });
  child.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 262144) {
      stop();
      return;
    }
    buffer += chunk.toString("utf8");
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        const handler = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) handler.reject(new Error(JSON.stringify(message.error)));
        else handler.resolve(message.result);
      } else {
        events.push(message);
        if (message.method === "turn/completed") finish(message.params);
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 262144) stop();
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  try {
    await rpc("initialize", {
      clientInfo: { name: "workshop-proof", version: "1" },
      capabilities: { experimentalApi: true }
    });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const config = {
      model_provider: "source_probe",
      model_providers: {
        source_probe: {
          name: "Local proof",
          base_url: `http://127.0.0.1:${port}`,
          wire_api: "responses",
          requires_openai_auth: false,
          request_max_retries: 0,
          stream_max_retries: 0,
          supports_websockets: false
        }
      },
      approval_policy: "never",
      web_search: "disabled",
      tools: { view_image: false },
      features: {
        shell_tool: false,
        apply_patch_tool: false,
        multi_agent: false,
        hooks: false,
        apps: false,
        plugins: false,
        code_mode: { enabled: false }
      },
      check_for_update_on_startup: false,
      analytics: { enabled: false },
      feedback: { enabled: false }
    };
    const thread = await rpc("thread/start", {
      model: "workshop-synthetic-source-model",
      modelProvider: "source_probe",
      cwd: `${root}/cwd`,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      dynamicTools: [],
      config,
      ...(emptyEnvironment ? { environments: [] } : {}),
      ...(variant === "empty-roots" ? { selectedCapabilityRoots: [] } : {}),
      experimentalRawEvents: false
    });
    await rpc("turn/start", {
      threadId: thread.thread.id,
      input: [{ type: "text", text: "Return the word quasar as JSON. Use no tools." }],
      outputSchema: {
        type: "object",
        properties: { word: { const: "quasar" } },
        required: ["word"],
        additionalProperties: false
      }
    });
    const done = await completed;
    assert.equal(fixtureError, undefined);
    assert.equal(done.turn?.status, "completed");
    assert.equal(requests.length, 1);
    assert.ok(
      events.some(
        (e) => e.method === "item/completed" && e.params?.item?.text === '{"word":"quasar"}'
      )
    );
    const toolNames = requests[0].tools.map((tool) => tool.name ?? tool.type);
    assert.deepEqual(
      toolNames,
      emptyEnvironment
        ? ["update_plan", "request_user_input", "skills"]
        : ["update_plan", "request_user_input", "view_image"]
    );
    if (emptyEnvironment) {
      const skills = requests[0].tools.find((tool) => tool.name === "skills");
      assert.deepEqual(
        skills.tools.map((tool) => tool.name),
        ["list", "read"]
      );
    }
    console.log(
      JSON.stringify({
        check: "codex-app-server-tool-inventory",
        status: "pass",
        version,
        variant,
        requests: 1,
        tools: toolNames,
        candidateRejected: true
      })
    );
  } finally {
    clearTimeout(timer);
    stop();
    await closed;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ check: "codex-app-server-proof-cleanup", status: "pass" }));

import { scopedClaudeTokenPath } from "../../packages/cli-runner/src/fresh-cli-login.js";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import type { TmuxIo } from "@moss/ai";

import { serveConnection } from "../../packages/cli-runner/src/connection.js";
import { CliChatEngineHost } from "../../packages/cli-runner/src/engine-host.js";
import { TerminalHost } from "../../packages/cli-runner/src/terminal-host.js";
import {
  RpcConnection,
  ChatEngineRpcClient
} from "../../packages/chat/src/live/chat-engine-rpc-client.js";

const model = "claude-sonnet-4-6";
const secret = "source-rpc-test-secret";
const init = {
  type: "system",
  subtype: "init",
  model,
  mcp_servers: [],
  tools: ["StructuredOutput"]
};

let root: string | undefined;
let server: net.Server | undefined;
let rpc: RpcConnection | undefined;
let host: CliChatEngineHost | undefined;
const previousToolsPrefix = process.env.JARVIS_CLI_TOOLS_PREFIX;

class TestConnection extends RpcConnection {
  protected async assertSocketUnderRunDir(): Promise<void> {
    // The realpath guard has separate coverage; this test uses a temporary socket.
  }
}

afterEach(async () => {
  await host?.kill("source-attempt");
  host = undefined;
  rpc?.close();
  rpc = undefined;
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  server = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  if (previousToolsPrefix === undefined) delete process.env.JARVIS_CLI_TOOLS_PREFIX;
  else process.env.JARVIS_CLI_TOOLS_PREFIX = previousToolsPrefix;
});

it("round-trips source generation through the real RPC runner and cleans its private home", async () => {
  root = await mkdtemp(join(tmpdir(), "moss-source-rpc-"));
  const bin = join(root, "bin");
  const home = join(root, "cli-home");
  const credential = scopedClaudeTokenPath(home, {
    actorUserId: "user-1",
    providerConfigId: "provider-1"
  });
  await mkdir(bin, { recursive: true, mode: 0o700 });
  await mkdir(join(credential, ".."), { recursive: true, mode: 0o700 });
  await writeFile(credential, "synthetic-token", { mode: 0o600 });
  const executable = join(bin, "claude");
  await writeFile(
    executable,
    `#!${process.execPath}
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const init = ${JSON.stringify(init)};
  const result = { type: "result", subtype: "success", is_error: false,
    structured_output: { cwd: process.cwd(), promptReceived: input.length > 0,
      credentialPresent: process.env.CLAUDE_CODE_OAUTH_TOKEN === "synthetic-token" } };
  fs.writeSync(1, JSON.stringify(init) + "\\n" + JSON.stringify(result) + "\\n");
});
`,
    { mode: 0o700 }
  );

  const verbs: string[] = [];
  const io: TmuxIo = {
    run: async (command, args) => {
      if (command === "tmux") verbs.push(args.join(" "));
      return { code: 1, stdout: "", stderr: "" };
    },
    readFile: async () => "",
    writeFile: async () => undefined,
    sleep: async () => undefined
  };
  host = new CliChatEngineHost({
    io,
    homeBase: home,
    neutralBase: join(root, "neutral"),
    singleUser: false,
    cliPresent: async () => true,
    launchTimeoutMs: 5_000
  });
  const socketPath = join(root, "rpc.sock");
  server = net.createServer((socket) =>
    serveConnection(socket, {
      host: host!,
      bootId: "source-rpc-boot",
      secret,
      terminalHost: new TerminalHost({ homeBase: home, toolsBinDir: bin })
    })
  );
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(socketPath, () => resolve());
  });
  process.env.JARVIS_CLI_TOOLS_PREFIX = root;
  rpc = new TestConnection({
    socketPath,
    rpcSecret: secret,
    reconnectMinMs: 1,
    reconnectMaxMs: 2
  });
  const client = new ChatEngineRpcClient(
    "anthropic",
    "source-attempt",
    rpc,
    "interactive",
    undefined,
    true
  );

  await client.launchStructured({
    neutralDir: join(root, "unused-neutral"),
    personaPath: join(root, "unused-persona"),
    personaText: "source only",
    model,
    schema: { type: "object", properties: {} },
    sourceCredentialScope: { actorUserId: "user-1", providerConfigId: "provider-1" },
    sourceGeneration: true
  });
  await expect(
    host.launch("source-attempt", {
      provider: "anthropic",
      personaText: "ordinary chat",
      executionMode: "interactive"
    })
  ).rejects.toThrow("launch is already active");
  await client.submitStructured("generate source");
  let result: { text?: string; complete: boolean; offset: number } = {
    complete: false,
    offset: 0
  };
  await vi.waitFor(async () => {
    result = await client.readStructured(result.offset);
    expect(result.complete).toBe(true);
  });
  const output = JSON.parse(result.text!);
  expect(output.promptReceived).toBe(true);
  expect(output.credentialPresent).toBe(true);
  expect(output.cwd).toContain("moss-source-claude-");
  await client.kill();
  await expect(access(output.cwd)).rejects.toThrow();
  expect(verbs.some((verb) => verb.includes("new-session"))).toBe(false);
});

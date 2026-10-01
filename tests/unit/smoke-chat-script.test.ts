import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Who tests the tester.
 *
 * `scripts/smoke-chat.mjs` runs after every deploy and decides whether chat can reach its tools. A
 * smoke check that cannot go red is worse than no check at all — it converts an outage into a green
 * tick — and this one CANNOT be proven red against a live deployment: every session is seeded with
 * a memory block, and in practice the model opens with a notes search no matter what the prompt
 * says, so there is no prompt that produces a tool-free turn on demand.
 *
 * So the discrimination is proven here instead, against a fake chat server that emits exactly the
 * records each case needs. The three cases are the three answers the script may give: a grounded
 * reply passes, an ungrounded reply fails, and a stream it could never read is an error rather than
 * a silent "no tools were called" — the misdiagnosis that would otherwise send someone hunting a
 * chat bug that was really an expired token.
 */
const SCRIPT_PATH = fileURLToPath(new URL("../../scripts/smoke-chat.mjs", import.meta.url));

type StreamRecord = { readonly kind: string; readonly text?: string };

interface FakeChat {
  readonly url: string;
  readonly close: () => Promise<void>;
}

/**
 * A chat server with just enough behaviour to drive the script: it holds the SSE response open,
 * and emits `records` onto it when the turn is posted — the same ordering the real server has,
 * where tool activity reaches the stream before the turn resolves.
 */
async function startFakeChat(options: {
  readonly records: readonly StreamRecord[];
  readonly streamStatus?: number;
}): Promise<FakeChat> {
  let stream: ServerResponse | null = null;

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    if (request.url?.startsWith("/api/chat/stream")) {
      if (options.streamStatus && options.streamStatus !== 200) {
        response.writeHead(options.streamStatus).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(": connected\n\n");
      stream = response;
      return;
    }

    // The turn: publish the activity, then answer.
    request.resume();
    request.on("end", () => {
      for (const record of options.records) {
        stream?.write(`data: ${JSON.stringify(record)}\n\n`);
      }
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ reply: "a reply", userMessageId: "u", assistantMessageId: "a" }));
    });
  };

  const server: Server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        stream?.end();
        server.close(() => resolve());
      })
  };
}

async function runScript(baseUrl: string): Promise<{ code: number; output: string }> {
  const child = spawn(process.execPath, [SCRIPT_PATH], {
    env: {
      ...process.env,
      JARVIS_SMOKE_BASE_URL: baseUrl,
      JARVIS_SMOKE_TOKEN: "00000000-0000-0000-0000-000000000000",
      JARVIS_SMOKE_TIMEOUT_MS: "15000"
    }
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? -1)));
  return { code, output };
}

describe("scripts/smoke-chat.mjs", () => {
  let chat: FakeChat | null = null;
  afterEach(async () => {
    await chat?.close();
    chat = null;
  });

  it("passes when the assistant called a Jarv1s tool before replying", async () => {
    chat = await startFakeChat({
      records: [
        { kind: "user", text: "..." },
        // The CLI path puts the tool name in `text` and leaves `toolName` unset. Reading only
        // `toolName` made every real tool call look unnamed, so keep a case honest about the shape.
        { kind: "tool", text: "mcp__jarvis__notes_search" },
        { kind: "reply", text: "..." }
      ]
    });
    const { code, output } = await runScript(chat.url);
    expect(output).toContain("mcp__jarvis__notes_search");
    expect(code).toBe(0);
  });

  it("passes when the tool carries the current mcp__moss__ prefix", async () => {
    chat = await startFakeChat({
      records: [
        { kind: "user", text: "..." },
        { kind: "tool", text: "mcp__moss__notes_search" },
        { kind: "reply", text: "..." }
      ]
    });
    const { code, output } = await runScript(chat.url);
    expect(output).toContain("mcp__moss__notes_search");
    expect(code).toBe(0);
  });

  it("fails when the reply came without one, which is what an outage looks like", async () => {
    chat = await startFakeChat({
      records: [
        { kind: "user", text: "..." },
        // A built-in tool is not grounding: during #1361 the model still moved, it just could not
        // reach anything of ours. Counting any tool at all would have called that outage green.
        { kind: "tool", text: "Bash" },
        { kind: "reply", text: "..." }
      ]
    });
    const { code, output } = await runScript(chat.url);
    expect(output).toContain("without calling a single Jarv1s tool");
    expect(code).toBe(1);
  });

  it("reports a stream it could not open as an error, not as a tool-free reply", async () => {
    chat = await startFakeChat({ records: [], streamStatus: 401 });
    const { code, output } = await runScript(chat.url);
    expect(output).toContain("transcript stream never opened");
    expect(code).toBe(2);
  });
});

#!/usr/bin/env node
/**
 * Post-deploy chat smoke test — proves the assistant can actually reach its tools.
 *
 * WHY THIS EXISTS. Two outages in a row were invisible to every gate we had:
 *
 *   #1361 — the one-shot permission hook denied `ToolSearch`, the CLI's deferred-schema loader, so
 *           the model concluded it had no tools at all and told users "tool access is restricted".
 *   #1363 — `app.getMapSlice` carried a top-level `anyOf`, which the Anthropic API rejects, so the
 *           CLI silently dropped the whole tool while the persona kept instructing the model to
 *           call it.
 *
 * In both cases unit tests passed, CI was green, `/api/mcp` returned 200, and the chat endpoint
 * returned 200 with a fluent, plausible, tool-free answer. The UAT suite cannot catch these either:
 * it runs a fake provider with no CLI engine in the image (see #1121), so no UAT case can prove a
 * real model reached a real tool. Nothing between a green build and a user noticing.
 *
 * WHAT IT ASSERTS. One thing, deterministically: a turn that can only be answered with a tool
 * produces at least one `mcp__moss__*` (or legacy `mcp__jarvis__*`) tool record on the live stream before the reply lands.
 * It deliberately does NOT assert anything about the reply's wording — model phrasing is not a
 * contract, and a test that greps prose goes red on a paraphrase and green on a hallucination.
 * The tool record is the ground truth: it exists only if the CLI advertised the tool, the model
 * chose it, and the permission hook allowed it. All three links, one assertion.
 *
 * HOW TO RUN. Needs a base URL and a bearer session; both come from the environment so no
 * credential is ever an argument (arguments show up in `ps` and shell history):
 *
 *   JARVIS_SMOKE_BASE_URL=http://127.0.0.1:3000 \
 *   JARVIS_SMOKE_TOKEN="$(cat /run/secrets/smoke-session)" \
 *     node scripts/smoke-chat.mjs
 *
 * `scripts/smoke-chat-prod.sh` is the production wrapper: it mints a short-lived session, runs
 * this, and revokes the session whether or not the run passed.
 *
 * OUTPUT DISCIPLINE. A chat transcript is private user content, and the token is a live
 * credential. This script prints record KINDS, TOOL NAMES, and error flags — never message bodies,
 * never the prompt's answer, never the token. Read it as a heartbeat, not a transcript viewer.
 *
 * Exit codes: 0 pass · 1 assertion failed (chat is degraded) · 2 could not run the check at all.
 */

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_ERROR = 2;

/**
 * Records whose toolName starts with one of these came from the Moss MCP server, not a built-in.
 * The ACP engine names the server "moss"; the Claude CLI engine still registers it as "jarvis".
 */
const MOSS_TOOL_PREFIXES = ["mcp__moss__", "mcp__jarvis__"];

/**
 * The default probe. Two properties matter more than the wording:
 *   1. It cannot be answered from the model's priors — only the user's own notes hold the answer.
 *   2. It does not depend on what is actually IN those notes. Zero results still means the tool
 *      fired, which is the whole assertion, so the check never goes red because prod data changed.
 */
const DEFAULT_PROMPT =
  "Search my notes for the exact phrase “deploy smoke check” and tell me how many " +
  "matches you found. Use your tools to look — do not answer from memory.";

function readConfig() {
  const baseUrl = (process.env.JARVIS_SMOKE_BASE_URL || "").replace(/\/+$/, "");
  const token = process.env.JARVIS_SMOKE_TOKEN || "";
  if (!baseUrl) throw new Error("JARVIS_SMOKE_BASE_URL is required (e.g. http://127.0.0.1:3000)");
  if (!token) throw new Error("JARVIS_SMOKE_TOKEN is required (a bearer session id)");
  return {
    baseUrl,
    token,
    // Surfaces are independent transcripts keyed by owner + surface, so the check gets its own
    // rather than dropping probe messages into the user's real drawer conversation. This also
    // means every run starts a cold session — CLI startup, MCP handshake, schema load — which is
    // precisely the path #1361 broke. The stream and the turn must name the SAME surface or the
    // subscription sees nothing.
    surface: process.env.JARVIS_SMOKE_SURFACE || "smoke",
    prompt: process.env.JARVIS_SMOKE_PROMPT || DEFAULT_PROMPT,
    // A cold one-shot turn pays CLI startup, MCP handshake, and schema loading before the model
    // says anything, so this is generous by design. A real hang still trips it.
    timeoutMs: Number(process.env.JARVIS_SMOKE_TIMEOUT_MS || 180_000)
  };
}

/**
 * How long to give the stream to report its status before submitting the turn anyway.
 *
 * The subscription is registered server-side while the GET is handled, which is well before any
 * client can observe it, so this is only about learning whether the GET was ACCEPTED. On a
 * deployment that flushes the response head up front we learn that in milliseconds and never wait.
 * On one that does not, the head sits in Node's buffer until the first record — a minute or more on
 * a cold turn — and waiting for it would deadlock: the record we are waiting for is caused by the
 * turn we have not sent yet. So we give up waiting and post regardless; a stream that turns out to
 * have been rejected is caught at the end, where it explains the failure instead of hanging.
 */
const STREAM_OPEN_GRACE_MS = 2_000;

/**
 * Subscribe to the live transcript and hand every record to `onRecord`. Returns a handle whose
 * `head` promise settles as soon as the status is known and whose `failure()` reports a stream that
 * never opened. The caller subscribes BEFORE posting its turn — subscribing after would race the
 * first tool record, which is the one record the whole check is about.
 */
function openStream(config, onRecord, signal) {
  const url = `${config.baseUrl}/api/chat/stream?surface=${encodeURIComponent(config.surface)}`;
  let failure = null;
  let settleHead = () => {};
  const head = new Promise((resolve) => {
    settleHead = resolve;
  });

  // Deliberately not awaited: the body is consumed for the life of the run, and the caller drives
  // its own completion. Anything that goes wrong lands in `failure` for the final report.
  void (async () => {
    try {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${config.token}`, accept: "text/event-stream" },
        signal
      });
      if (!response.ok) throw new Error(`stream returned ${response.status} (expected 200)`);
      if (!response.body) throw new Error("stream returned no body");
      settleHead();

      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        // SSE frames are separated by a blank line. Keep the trailing partial frame in the buffer.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              onRecord(JSON.parse(line.slice(5).trim()));
            } catch {
              // A frame we cannot parse is not worth failing the deploy over; the assertion below
              // is about what DID arrive, and a malformed frame simply is not a tool record.
            }
          }
        }
      }
    } catch (error) {
      // The abort we issue once the run is decided lands here too, and is not a failure.
      if (!signal.aborted) failure = error;
      settleHead();
    }
  })();

  return { head, failure: () => failure };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function submitTurn(config, signal) {
  const response = await fetch(`${config.baseUrl}/api/chat/turn`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ text: config.prompt, surface: config.surface }),
    signal
  });
  if (!response.ok) {
    // The body can echo user content, so report the status only.
    throw new Error(`POST /api/chat/turn returned ${response.status} (expected 200)`);
  }
  const body = await response.json();
  if (typeof body?.reply !== "string" || body.reply.trim() === "") {
    throw new Error("turn succeeded but returned an empty reply");
  }
  return body.reply.length;
}

async function main() {
  const config = readConfig();
  const controller = new AbortController();
  /** @type {{kind: string, toolName?: string, outcome?: string}[]} */
  const records = [];

  // Recorded by the timer rather than read off `controller.signal`: the catch below aborts the
  // controller itself, so asking the signal afterwards always answers "aborted" and every failure
  // would be reported as a timeout no matter what actually went wrong.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);

  const stream = openStream(config, (record) => records.push(record), controller.signal);
  await Promise.race([stream.head, delay(STREAM_OPEN_GRACE_MS)]);
  if (stream.failure()) {
    clearTimeout(timer);
    controller.abort();
    console.error(`SMOKE ERROR  the transcript stream never opened: ${stream.failure().message}`);
    // Never reaching the transcript is a harness problem — an expired session, the wrong URL. Say
    // so, rather than reporting the empty record list as "the assistant called no tools".
    return EXIT_ERROR;
  }

  let replyLength;
  try {
    replyLength = await submitTurn(config, controller.signal);
  } catch (error) {
    clearTimeout(timer);
    controller.abort();
    const reason = timedOut
      ? `no reply within ${config.timeoutMs}ms`
      : error instanceof Error
        ? error.message
        : String(error);
    console.error(`SMOKE FAIL  chat turn did not complete: ${reason}`);
    // A turn that never completed is a real chat failure, not a harness problem — fail, not error.
    return EXIT_FAIL;
  }
  clearTimeout(timer);

  // /turn resolves when the reply is persisted; the last stream frames can still be in flight.
  await delay(1_000);
  controller.abort();

  // A stream rejected after we stopped waiting for it (an expired session, say) shows up as zero
  // records, which would otherwise be reported as "the model called no tools" — the wrong diagnosis
  // entirely. Say so plainly instead, and report it as a harness problem rather than a chat one.
  const streamFailure = stream.failure();
  if (streamFailure) {
    console.error(`SMOKE ERROR  the transcript stream never opened: ${streamFailure.message}`);
    return EXIT_ERROR;
  }

  // Two different producers fill in the name. Module action records carry `toolName`; records
  // derived from the CLI transcript put the raw `tool_use.name` in `text` and leave `toolName`
  // unset (packages/ai/src/adapters/transcript-reader.ts). The CLI path is the one that matters
  // here, so read both or the check silently sees every tool as unnamed.
  const toolRecords = records.filter((record) => record.kind === "tool");
  const nameOf = (record) => record.toolName ?? record.text ?? "";
  const jarvisTools = toolRecords.filter((record) =>
    MOSS_TOOL_PREFIXES.some((prefix) => nameOf(record).startsWith(prefix))
  );

  // Our own tool names are safe to print in full and are the only thing that makes a failure
  // diagnosable without opening the container. Everything else is summarised by count: a built-in
  // tool record's text is its argument (a Bash record holds the whole command line), which is
  // exactly the user content this script promises never to echo.
  const jarvisNames = [...new Set(jarvisTools.map(nameOf))];
  const otherCount = toolRecords.length - jarvisTools.length;
  console.log(`kinds        ${[...new Set(records.map((record) => record.kind))].join(", ")}`);
  console.log(`jarv1s tools ${jarvisNames.length > 0 ? jarvisNames.join(", ") : "(none)"}`);
  console.log(`other tools  ${otherCount} record(s)`);
  console.log(`reply        ${replyLength} chars`);

  if (jarvisTools.length === 0) {
    console.error(
      "SMOKE FAIL  the assistant replied without calling a single Jarv1s tool.\n" +
        "            The reply is therefore ungrounded — it came from the model's priors.\n" +
        "            Check, in order: the permission hook (does it allow ToolSearch? #1361),\n" +
        "            the CLI's MCP client log for a dropped tool (#1363), then the gateway."
    );
    return EXIT_FAIL;
  }

  console.log(`SMOKE PASS   ${jarvisTools.length} Jarv1s tool call(s) before the reply`);
  return EXIT_PASS;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`SMOKE ERROR  ${error instanceof Error ? error.message : String(error)}`);
    process.exit(EXIT_ERROR);
  });

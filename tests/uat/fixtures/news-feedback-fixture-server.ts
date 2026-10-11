import { createServer } from "node:http";
export const NEWS_FEEDBACK_FIXTURE_PORT = 4319;

/** Third-party RSS/model stand-in only; never serves a Moss API response. */
export function newsFeedbackRss(now = new Date()): string {
  const items = Array.from(
    { length: 12 },
    (_, index) =>
      `<item><title>Declared synthetic audit story ${index + 1}</title><link>https://www.bbc.com/news/audit-fixture-${index + 1}</link><description>Synthetic feed input for feedback UAT.</description><pubDate>${now.toUTCString()}</pubDate></item>`
  ).join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Declared synthetic publisher fixture</title>${items}</channel></rss>`;
}
export function newsFeedbackModelResponse(body: string): { status: number; body: string } {
  try {
    const request = JSON.parse(body) as { messages?: Array<{ content?: unknown }> };
    const prompt =
      request.messages
        ?.map((message) => (typeof message.content === "string" ? message.content : ""))
        .join("\n") ?? "";
    const ids = [...new Set([...prompt.matchAll(/"id":"(c\d+)"/g)].map((match) => match[1]!))];
    if (ids.length === 0)
      return { status: 400, body: JSON.stringify({ error: "No compilation candidate IDs" }) };
    const content = JSON.stringify({
      rankings: ids.map((id, index) => ({ id, relevance: 100 - index, eligible: true }))
    });
    return {
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }]
      })
    };
  } catch {
    return { status: 400, body: JSON.stringify({ error: "Invalid fixture request" }) };
  }
}
export async function startNewsFeedbackFixtureServer(port = 0) {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
    if (request.method === "GET" && path === "/rss") {
      response.writeHead(200, { "content-type": "application/rss+xml" });
      response.end(newsFeedbackRss());
      return;
    }
    if (request.method === "POST" && path === "/v1/chat/completions") {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1_000_000) request.destroy();
        else chunks.push(chunk);
      });
      request.on("end", () => {
        const result = newsFeedbackModelResponse(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(result.status, { "content-type": "application/json" });
        response.end(result.body);
      });
      return;
    }
    response.writeHead(404);
    response.end("Unknown third-party fixture path");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture did not acquire a TCP port");
  return {
    port: address.port,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  };
}

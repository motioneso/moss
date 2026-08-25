import { stat } from "node:fs/promises";

import {
  SportsBrowserBroker,
  SportsBrowserBrokerServer
} from "../packages/sports/src/source/browser-broker.js";
import { SportsBrowserClient } from "../packages/sports/src/source/browser-client.js";
import { SPORTS_BROWSER_SOCKETS } from "../packages/sports/src/source/browser-protocol.js";

const SHARED_GROUP_ID = 1001;
const FOTMOB_SHAPED_DOCUMENT = `<!doctype html><html><body>
  <main id="news">Loading Liverpool news…</main>
  <script>
    fetch("/api/team-news?id=8650")
      .then((response) => response.json())
      .then(({ title }) => { document.querySelector("#news").textContent = title; });
  </script>
</body></html>`;

function mode(value: number): number {
  return value & 0o7777;
}

async function main(): Promise<void> {
  if (!process.getgroups?.().includes(SHARED_GROUP_ID)) {
    throw new Error("Sports renderer smoke process is missing shared group 1001");
  }
  const fetched: string[] = [];
  const broker = new SportsBrowserBroker({
    fetch: async (url, options) => {
      await options.beforeRequest({
        url: new URL(url),
        address: "93.184.216.34",
        family: 4,
        method: options.method,
        redirectCount: 0
      });
      fetched.push(url);
      const body = Buffer.from(
        url.includes("/api/team-news") ? '{"title":"Liverpool team news"}' : FOTMOB_SHAPED_DOCUMENT
      );
      return {
        ok: true as const,
        status: 200,
        finalUrl: url,
        contentType: url.includes("/api/team-news") ? "application/json" : "text/html",
        body,
        truncated: false,
        bytesRead: body.byteLength
      };
    }
  });
  const server = new SportsBrowserBrokerServer({
    broker,
    socketPath: SPORTS_BROWSER_SOCKETS.broker
  });
  await server.start();
  try {
    const client = new SportsBrowserClient({
      broker,
      socketPath: SPORTS_BROWSER_SOCKETS.renderer
    });
    const result = await client.render({
      url: "https://publisher.example/teams/8650/liverpool",
      allowedHosts: ["publisher.example"]
    });
    if (!result.ok) {
      throw new Error(`Exact Moss image did not complete brokered render: ${result.reason}`);
    }
    if (!result.domHtml.includes("Liverpool team news")) {
      throw new Error("Exact renderer image omitted brokered XHR content");
    }
    const directory = await stat("/run/moss-sports-browser");
    const brokerSocket = await stat(SPORTS_BROWSER_SOCKETS.broker);
    const rendererSocket = await stat(SPORTS_BROWSER_SOCKETS.renderer);
    if (
      directory.gid !== SHARED_GROUP_ID ||
      mode(directory.mode) !== 0o2770 ||
      brokerSocket.gid !== SHARED_GROUP_ID ||
      rendererSocket.gid !== SHARED_GROUP_ID ||
      mode(brokerSocket.mode) !== 0o660 ||
      mode(rendererSocket.mode) !== 0o660
    ) {
      throw new Error("Sports renderer shared socket identity or mode is unsafe");
    }
    const expected = [
      "https://publisher.example/teams/8650/liverpool",
      "https://publisher.example/api/team-news?id=8650"
    ];
    if (JSON.stringify(fetched) !== JSON.stringify(expected)) {
      throw new Error(`Unexpected brokered renderer requests: ${JSON.stringify(fetched)}`);
    }
    console.log(
      JSON.stringify({
        event: "sports_renderer_exact_moss_image_smoke_passed",
        directory: { gid: directory.gid, mode: mode(directory.mode).toString(8) },
        brokerSocket: { uid: brokerSocket.uid, gid: brokerSocket.gid, mode: "660" },
        rendererSocket: { uid: rendererSocket.uid, gid: rendererSocket.gid, mode: "660" },
        fetched
      })
    );
  } finally {
    await server.stop();
  }
}

await main();

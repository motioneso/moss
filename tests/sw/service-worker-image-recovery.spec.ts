import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";

// 1x1 transparent PNG.
const ONE_PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

interface FlakyImageServer {
  url: string;
  close: () => Promise<void>;
}

// Destroys the socket on the first request to any given path (a deterministic transient
// network failure, no real network involved) and serves a real PNG on every request after.
function startFlakyImageServer(): Promise<FlakyImageServer> {
  const seenPaths = new Set<string>();
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = req.url ?? "/";
      if (!seenPaths.has(path)) {
        seenPaths.add(path);
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(ONE_PX_PNG);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(() => res()))
      });
    });
  });
}

test("registered service worker recovers a flaky cross-origin image without a page reload", async ({
  page
}) => {
  const flaky = await startFlakyImageServer();
  const consoleMessages: string[] = [];
  page.on("console", (message) => consoleMessages.push(message.text()));
  page.on("pageerror", (error) => consoleMessages.push(error.message));

  try {
    await page.goto("/");
    await page.waitForFunction(() => "serviceWorker" in navigator);
    await page.evaluate(() => navigator.serviceWorker.ready);

    let controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
    if (!controlled) {
      await page.reload();
      await page.evaluate(() => navigator.serviceWorker.ready);
      controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
    }
    expect(controlled, "page must be controlled by the registered service worker").toBe(true);

    const naturalWidth = await page.evaluate(
      async ({ src }) => {
        const img = document.createElement("img");
        img.src = src;
        document.body.appendChild(img);
        await new Promise<void>((resolve, reject) => {
          img.addEventListener("load", () => resolve());
          img.addEventListener("error", () => reject(new Error("image failed to load")));
          setTimeout(() => reject(new Error("timeout waiting for image to load")), 15_000);
        });
        return img.naturalWidth;
      },
      { src: `${flaky.url}/flaky-photo.png` }
    );

    expect(naturalWidth).toBeGreaterThan(0);

    const rejectionMessages = consoleMessages.filter((text) =>
      /respondWith|FetchEvent.*network error/i.test(text)
    );
    expect(rejectionMessages).toEqual([]);
  } finally {
    await flaky.close();
  }
});

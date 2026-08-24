import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import {
  chromium,
  type Browser,
  type Request as BrowserRequest,
  type Route
} from "playwright-core";
import { getDomain } from "tldts";

import {
  type BrowserFetchRequest,
  type BrowserRenderRequest,
  type BrowserRenderResult,
  type BrowserResourceType,
  parseBrowserRenderBody,
  SPORTS_BROWSER_LIMITS,
  SPORTS_BROWSER_ROUTES,
  SPORTS_BROWSER_SOCKETS
} from "./browser-protocol.js";

export interface SportsBrowserSidecarDependencies {
  readonly brokerSocketPath?: string;
  readonly socketPath?: string;
}

interface BrokerResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
  readonly finalUrl: string;
}

const ALLOWED_RESOURCE_TYPES = new Set<BrowserResourceType>([
  "document",
  "fetch",
  "xhr",
  "script",
  "stylesheet"
]);
const TRACKING_PATH = /(^|[./_-])(ads?|analytics?|metrics?|telemetry|tracking)([./_?-]|$)/i;

class InvalidControlRequestError extends Error {}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

async function readControlBody(request: IncomingMessage): Promise<Buffer> {
  const declared = headerValue(request.headers["content-length"]);
  if (
    declared === undefined ||
    !/^(0|[1-9]\d*)$/.test(declared) ||
    Number(declared) > SPORTS_BROWSER_LIMITS.maxJsonBodyBytes
  ) {
    throw new InvalidControlRequestError();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array);
    total += bytes.byteLength;
    if (total > SPORTS_BROWSER_LIMITS.maxJsonBodyBytes) throw new InvalidControlRequestError();
    chunks.push(bytes);
  }
  if (total !== Number(declared)) throw new InvalidControlRequestError();
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
    "content-length": body.byteLength
  });
  response.end(body);
}

function isRelatedPublisherHost(initialUrl: URL, requestedUrl: URL): boolean {
  const initialDomain = getDomain(initialUrl.hostname) ?? initialUrl.hostname;
  const requestedDomain = getDomain(requestedUrl.hostname) ?? requestedUrl.hostname;
  return initialDomain === requestedDomain;
}

function allowedBrowserRequest(
  request: BrowserRequest,
  initialUrl: URL,
  documentSeen: boolean
): request is BrowserRequest & { resourceType(): BrowserResourceType } {
  const method = request.method();
  const resourceType = request.resourceType();
  if (
    (method !== "GET" && method !== "HEAD") ||
    !ALLOWED_RESOURCE_TYPES.has(resourceType as BrowserResourceType) ||
    (resourceType === "document" && documentSeen)
  ) {
    return false;
  }
  try {
    const url = new URL(request.url());
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      isRelatedPublisherHost(initialUrl, url) &&
      !TRACKING_PATH.test(`${url.hostname}${url.pathname}`)
    );
  } catch {
    return false;
  }
}

async function fetchFromBroker(
  socketPath: string,
  message: BrowserFetchRequest,
  signal: AbortSignal
): Promise<BrokerResponse> {
  const body = Buffer.from(JSON.stringify(message));
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath,
        path: SPORTS_BROWSER_ROUTES.fetch,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": body.byteLength
        }
      },
      async (response) => {
        try {
          if (response.statusCode !== 200) throw new Error("Broker rejected browser request");
          const declared = headerValue(response.headers["content-length"]);
          if (
            declared === undefined ||
            !/^(0|[1-9]\d*)$/.test(declared) ||
            Number(declared) > SPORTS_BROWSER_LIMITS.maxResponseBytes
          ) {
            throw new Error("Invalid broker response length");
          }
          const chunks: Buffer[] = [];
          let total = 0;
          for await (const chunk of response) {
            const bytes = Buffer.from(chunk as Uint8Array);
            total += bytes.byteLength;
            if (total > SPORTS_BROWSER_LIMITS.maxResponseBytes) {
              throw new Error("Broker response too large");
            }
            chunks.push(bytes);
          }
          if (total !== Number(declared)) throw new Error("Mismatched broker response length");
          const contentType = headerValue(response.headers["content-type"]);
          const finalUrlHeader = headerValue(response.headers["x-moss-sports-final-url"]);
          const statusHeader = headerValue(response.headers["x-moss-sports-status"]);
          if (!contentType || !finalUrlHeader || !statusHeader || !/^\d{3}$/.test(statusHeader)) {
            throw new Error("Invalid broker response metadata");
          }
          const finalUrl = decodeURIComponent(finalUrlHeader);
          const parsedFinalUrl = new URL(finalUrl);
          const status = Number(statusHeader);
          if (parsedFinalUrl.protocol !== "https:" || status < 100 || status > 599) {
            throw new Error("Invalid broker response metadata");
          }
          resolve({ status, contentType, finalUrl, body: Buffer.concat(chunks) });
        } catch (error) {
          reject(error);
        }
      }
    );
    const onAbort = (): void => {
      request.destroy(new Error("Browser render cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    request.once("close", () => signal.removeEventListener("abort", onAbort));
    request.once("error", reject);
    request.setTimeout(SPORTS_BROWSER_LIMITS.deadlineMs, () => {
      request.destroy(new Error("Broker request timed out"));
    });
    request.end(body);
  });
}

function boundedSuccessResult(
  control: BrowserRenderRequest,
  finalUrl: string,
  domHtml: string
): BrowserRenderResult {
  let low = 0;
  let high = domHtml.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const bytes = Buffer.byteLength(
      JSON.stringify({
        ok: true,
        jobId: control.jobId,
        finalUrl,
        domHtml: domHtml.slice(0, middle)
      })
    );
    if (bytes <= SPORTS_BROWSER_LIMITS.maxRenderResultBytes) low = middle;
    else high = middle - 1;
  }
  return { ok: true, jobId: control.jobId, finalUrl, domHtml: domHtml.slice(0, low) };
}

async function fulfillFromBroker(
  route: Route,
  control: BrowserRenderRequest,
  socketPath: string,
  requestId: string,
  signal: AbortSignal
): Promise<string> {
  const request = route.request();
  const result = await fetchFromBroker(
    socketPath,
    {
      ...control,
      requestId,
      url: request.url(),
      method: request.method() as "GET" | "HEAD",
      resourceType: request.resourceType() as BrowserResourceType
    },
    signal
  );
  await route.fulfill({
    status: result.status,
    contentType: result.contentType,
    body: request.method() === "HEAD" ? Buffer.alloc(0) : result.body
  });
  return result.finalUrl;
}

async function render(control: BrowserRenderRequest, socketPath: string, signal: AbortSignal) {
  let browser: Browser | undefined;
  const closeOnAbort = (): void => void browser?.close();
  signal.addEventListener("abort", closeOnAbort, { once: true });
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-domain-reliability",
        "--disable-sync",
        "--metrics-recording-only",
        "--no-first-run"
      ]
    });
    if (signal.aborted) throw new Error("Browser render cancelled");
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
    await context.addInitScript(() => {
      Object.defineProperty(globalThis, "RTCPeerConnection", {
        configurable: false,
        value: undefined,
        writable: false
      });
      Object.defineProperty(globalThis, "webkitRTCPeerConnection", {
        configurable: false,
        value: undefined,
        writable: false
      });
    });
    await context.routeWebSocket("**/*", (socket) => socket.close({ code: 1008 }));

    const initialUrl = new URL(control.url);
    let documentSeen = false;
    let finalUrl = control.url;
    let requestSequence = 0;
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (signal.aborted || !allowedBrowserRequest(request, initialUrl, documentSeen)) {
        await route.abort("blockedbyclient");
        return;
      }
      if (request.resourceType() === "document") documentSeen = true;
      requestSequence += 1;
      try {
        const fetchedFinalUrl = await fulfillFromBroker(
          route,
          control,
          socketPath,
          `request_${requestSequence}`,
          signal
        );
        if (request.resourceType() === "document") finalUrl = fetchedFinalUrl;
      } catch {
        await route.abort("failed").catch(() => undefined);
      }
    });

    const page = await context.newPage();
    context.on("page", (openedPage) => {
      if (openedPage !== page) void openedPage.close();
    });
    page.on("download", (download) => void download.cancel());
    page.setDefaultTimeout(SPORTS_BROWSER_LIMITS.deadlineMs);
    await page.goto(control.url, {
      waitUntil: "domcontentloaded",
      timeout: SPORTS_BROWSER_LIMITS.deadlineMs
    });
    await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => undefined);
    if (signal.aborted) throw new Error("Browser render cancelled");
    return boundedSuccessResult(control, finalUrl, await page.content());
  } finally {
    signal.removeEventListener("abort", closeOnAbort);
    await browser?.close().catch(() => undefined);
  }
}

export class SportsBrowserSidecar {
  private server: Server | undefined;
  private readonly active = new Set<AbortController>();
  private readonly brokerSocketPath: string;
  private readonly socketPath: string;

  constructor(dependencies: SportsBrowserSidecarDependencies = {}) {
    this.brokerSocketPath = dependencies.brokerSocketPath ?? SPORTS_BROWSER_SOCKETS.broker;
    this.socketPath = dependencies.socketPath ?? SPORTS_BROWSER_SOCKETS.renderer;
  }

  async start(): Promise<void> {
    if (this.server) return;
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o770 });
    const existing = await lstat(this.socketPath).catch(() => undefined);
    if (existing && !existing.isSocket()) {
      throw new Error("Refusing to replace a non-socket Sports renderer path");
    }
    if (existing) await unlink(this.socketPath);
    const server = createServer((request, response) => void this.handleRequest(request, response));
    server.requestTimeout = SPORTS_BROWSER_LIMITS.deadlineMs;
    server.headersTimeout = 5_000;
    server.on("clientError", (_error, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, resolve);
    });
    this.server = server;
    await chmod(this.socketPath, 0o660);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const controller of this.active) controller.abort();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(this.socketPath).catch(() => undefined);
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (
      request.method !== "POST" ||
      request.url !== SPORTS_BROWSER_ROUTES.render ||
      headerValue(request.headers["content-type"])?.split(";", 1)[0]?.trim().toLowerCase() !==
        "application/json"
    ) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    const controller = new AbortController();
    this.active.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, SPORTS_BROWSER_LIMITS.deadlineMs);
    timer.unref();
    const cancel = (): void => {
      if (!response.writableEnded) controller.abort();
    };
    request.once("aborted", cancel);
    response.once("close", cancel);
    try {
      const parsed = parseBrowserRenderBody(await readControlBody(request));
      if (!parsed.ok) {
        sendJson(response, 400, { error: parsed.reason });
        return;
      }
      let result: BrowserRenderResult;
      try {
        result = await render(parsed.value, this.brokerSocketPath, controller.signal);
      } catch {
        result = {
          ok: false,
          jobId: parsed.value.jobId,
          reason: timedOut ? "timeout" : controller.signal.aborted ? "cancelled" : "render_failed"
        };
      }
      if (!response.destroyed) sendJson(response, 200, result);
    } catch (error) {
      if (!response.destroyed) {
        sendJson(response, error instanceof InvalidControlRequestError ? 400 : 500, {
          error: "invalid_request"
        });
      }
    } finally {
      clearTimeout(timer);
      request.off("aborted", cancel);
      response.off("close", cancel);
      this.active.delete(controller);
      controller.abort();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sidecar = new SportsBrowserSidecar();
  await sidecar.start();
  const stop = (): void => void sidecar.stop().finally(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

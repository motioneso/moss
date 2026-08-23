import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { Readable } from "node:stream";

import {
  type BrowserFetchRequest,
  type BrowserRenderRequest,
  type BrowserResourceType,
  parseBrowserFetchBody,
  SPORTS_BROWSER_LIMITS,
  SPORTS_BROWSER_ROUTES
} from "./browser-protocol.js";

interface BrowserSafeFetchHop {
  readonly url: URL;
  readonly address: string;
  readonly family: number;
  readonly method: "GET" | "HEAD";
  readonly redirectCount: number;
}

interface BrowserSafeFetchOptions {
  readonly requireHttps: true;
  readonly allowedHosts: readonly string[];
  readonly method: "GET" | "HEAD";
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly allowedContentTypes: readonly string[];
  readonly beforeRequest: (hop: BrowserSafeFetchHop) => boolean;
  readonly maxBytes: number;
  readonly rejectOversizedResponses: true;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

type BrowserSafeFetchResult =
  | {
      readonly ok: true;
      readonly status: number;
      readonly finalUrl: string;
      readonly contentType: string | null;
      readonly body: Uint8Array;
      readonly truncated: boolean;
      readonly bytesRead: number;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly detail?: string;
      readonly status?: number;
      readonly bytesRead?: number;
    };

type BrowserSafeFetch = (
  url: string,
  options: BrowserSafeFetchOptions
) => Promise<BrowserSafeFetchResult>;

interface BrowserJob {
  readonly control: BrowserRenderRequest;
  readonly allowedHosts: readonly string[];
  readonly requestIds: Set<string>;
  readonly evidence: BrowserFetchEvidence[];
  readonly abortController: AbortController;
  readonly deadlineAt: number;
  readonly timer: NodeJS.Timeout;
  requests: number;
  bytesRead: number;
  activeRequests: number;
  documentSeen: boolean;
}

export type BrowserBrokerFetchResult =
  | Extract<BrowserSafeFetchResult, { readonly ok: true }>
  | {
      readonly ok: false;
      readonly reason: string;
      readonly status?: number;
      readonly bytesRead?: number;
    };

export interface BrowserFetchEvidence {
  readonly requestId: string;
  readonly resourceType: "document" | "fetch" | "xhr";
  readonly finalUrl: string;
  readonly contentType: string | null;
  readonly body: Uint8Array;
}

export type BrowserJobCompletion =
  | { readonly ok: true; readonly evidence: readonly BrowserFetchEvidence[] }
  | { readonly ok: false; readonly reason: "unknown_job" | "unauthorized" };

export interface SportsBrowserBrokerDependencies {
  readonly fetch: BrowserSafeFetch;
  readonly now?: () => number;
}

export interface SportsBrowserBrokerServerDependencies {
  readonly broker: SportsBrowserBroker;
  readonly socketPath: string;
}

const CONTENT_TYPES: Readonly<Record<BrowserResourceType, readonly string[]>> = {
  document: ["text/html", "application/xhtml+xml"],
  fetch: ["application/json", "text/json", "text/plain", "text/html"],
  xhr: ["application/json", "text/json", "text/plain", "text/html"],
  script: ["text/javascript", "application/javascript"],
  stylesheet: ["text/css"]
};

const ACCEPT_HEADERS: Readonly<Record<BrowserResourceType, string>> = {
  document: "text/html,application/xhtml+xml",
  fetch: "application/json,text/plain;q=0.9,*/*;q=0.1",
  xhr: "application/json,text/plain;q=0.9,*/*;q=0.1",
  script: "text/javascript,application/javascript",
  stylesheet: "text/css"
};

function capabilitiesMatch(expected: string, received: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function normalizeAllowedHosts(hosts: readonly string[], initialUrl: URL): readonly string[] {
  const normalized = [...new Set(hosts.map((host) => host.toLowerCase()))];
  if (normalized.length === 0 || normalized.length > 6) {
    throw new Error("Sports browser jobs require one to six exact publisher hosts");
  }
  for (const host of normalized) {
    const parsed = new URL(`https://${host}`);
    if (parsed.hostname !== host || parsed.port || parsed.pathname !== "/") {
      throw new Error("Sports browser jobs require exact hostnames");
    }
  }
  if (!normalized.includes(initialUrl.hostname.toLowerCase())) {
    throw new Error("Initial Sports browser URL must use an allowed publisher host");
  }
  return normalized;
}

class RequestBodyTooLargeError extends Error {}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    if (!/^(0|[1-9]\d*)$/.test(declared)) throw new Error("Invalid Content-Length");
    if (Number(declared) > SPORTS_BROWSER_LIMITS.maxJsonBodyBytes) {
      throw new RequestBodyTooLargeError();
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.byteLength;
    if (total > SPORTS_BROWSER_LIMITS.maxJsonBodyBytes) {
      throw new RequestBodyTooLargeError();
    }
    chunks.push(bytes);
  }
  if (declared !== undefined && Number(declared) !== total) {
    throw new Error("Mismatched Content-Length");
  }
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

export class SportsBrowserBroker {
  private readonly jobs = new Map<string, BrowserJob>();
  private readonly now: () => number;

  constructor(private readonly dependencies: SportsBrowserBrokerDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  createJob(input: {
    readonly url: string;
    readonly allowedHosts: readonly string[];
  }): BrowserRenderRequest {
    const initialUrl = new URL(input.url);
    if (initialUrl.protocol !== "https:" || initialUrl.username || initialUrl.password) {
      throw new Error("Sports browser jobs require a public HTTPS URL");
    }
    const jobId = randomUUID();
    const control = {
      jobId,
      capability: randomBytes(16).toString("base64url"),
      url: initialUrl.toString()
    };
    const timer = setTimeout(() => this.endJob(jobId), SPORTS_BROWSER_LIMITS.deadlineMs);
    timer.unref();
    this.jobs.set(jobId, {
      control,
      allowedHosts: normalizeAllowedHosts(input.allowedHosts, initialUrl),
      requestIds: new Set(),
      evidence: [],
      abortController: new AbortController(),
      deadlineAt: this.now() + SPORTS_BROWSER_LIMITS.deadlineMs,
      timer,
      requests: 0,
      bytesRead: 0,
      activeRequests: 0,
      documentSeen: false
    });
    return control;
  }

  hasJob(jobId: string): boolean {
    return this.jobs.has(jobId);
  }

  cancelJob(jobId: string): void {
    this.endJob(jobId);
  }

  completeJob(jobId: string, capability: string): BrowserJobCompletion {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, reason: "unknown_job" };
    if (!capabilitiesMatch(job.control.capability, capability)) {
      this.endJob(jobId);
      return { ok: false, reason: "unauthorized" };
    }
    const evidence = job.evidence.map((item) => ({ ...item, body: item.body.slice() }));
    this.endJob(jobId);
    return { ok: true, evidence };
  }

  async fetch(request: BrowserFetchRequest): Promise<BrowserBrokerFetchResult> {
    const job = this.jobs.get(request.jobId);
    if (!job) return { ok: false, reason: "unknown_job" };
    if (!capabilitiesMatch(job.control.capability, request.capability)) {
      this.endJob(request.jobId);
      return { ok: false, reason: "unauthorized" };
    }
    if (this.now() >= job.deadlineAt) {
      this.endJob(request.jobId);
      return { ok: false, reason: "timeout" };
    }
    if (job.requestIds.has(request.requestId)) {
      this.endJob(request.jobId);
      return { ok: false, reason: "protocol_violation" };
    }
    job.requestIds.add(request.requestId);
    if (request.resourceType === "document") {
      if (job.documentSeen) {
        this.endJob(request.jobId);
        return { ok: false, reason: "protocol_violation" };
      }
      job.documentSeen = true;
    }
    if (job.activeRequests >= SPORTS_BROWSER_LIMITS.maxConcurrentRequests) {
      this.endJob(request.jobId);
      return { ok: false, reason: "budget_exceeded" };
    }
    const remainingBytes = SPORTS_BROWSER_LIMITS.maxAggregateBytes - job.bytesRead;
    if (remainingBytes <= 0) {
      this.endJob(request.jobId);
      return { ok: false, reason: "budget_exceeded" };
    }

    let requestBudgetExceeded = false;
    job.activeRequests += 1;
    try {
      const result = await this.dependencies.fetch(request.url, {
        requireHttps: true,
        allowedHosts: job.allowedHosts,
        method: request.method,
        requestHeaders: {
          accept: ACCEPT_HEADERS[request.resourceType],
          "accept-language": "en-US,en;q=0.5"
        },
        allowedContentTypes: CONTENT_TYPES[request.resourceType],
        beforeRequest: () => {
          if (job.requests >= SPORTS_BROWSER_LIMITS.maxRequests) {
            requestBudgetExceeded = true;
            return false;
          }
          job.requests += 1;
          return true;
        },
        maxBytes: Math.min(SPORTS_BROWSER_LIMITS.maxResponseBytes, remainingBytes),
        rejectOversizedResponses: true,
        timeoutMs: Math.max(1, job.deadlineAt - this.now()),
        signal: job.abortController.signal
      });
      const bytesRead = result.bytesRead ?? 0;
      job.bytesRead += bytesRead;
      if (requestBudgetExceeded || job.bytesRead > SPORTS_BROWSER_LIMITS.maxAggregateBytes) {
        this.endJob(request.jobId);
        return { ok: false, reason: "budget_exceeded", bytesRead };
      }
      if (!result.ok) {
        return {
          ok: false,
          reason: result.detail ?? result.reason,
          status: result.status,
          bytesRead: result.bytesRead
        };
      }
      if (
        job.evidence.length < SPORTS_BROWSER_LIMITS.maxCandidateEvidence &&
        (request.resourceType === "document" ||
          request.resourceType === "fetch" ||
          request.resourceType === "xhr")
      ) {
        job.evidence.push({
          requestId: request.requestId,
          resourceType: request.resourceType,
          finalUrl: result.finalUrl,
          contentType: result.contentType,
          body: result.body.slice()
        });
      }
      return result;
    } finally {
      job.activeRequests -= 1;
    }
  }

  dispose(): void {
    for (const jobId of this.jobs.keys()) this.endJob(jobId);
  }

  private endJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.jobs.delete(jobId);
    clearTimeout(job.timer);
    job.abortController.abort();
  }
}

export class SportsBrowserBrokerServer {
  private server: Server | undefined;

  constructor(private readonly dependencies: SportsBrowserBrokerServerDependencies) {}

  async start(): Promise<void> {
    if (this.server) return;
    await mkdir(dirname(this.dependencies.socketPath), { recursive: true, mode: 0o770 });
    const existing = await lstat(this.dependencies.socketPath).catch(() => undefined);
    if (existing && !existing.isSocket()) {
      throw new Error("Refusing to replace a non-socket Sports browser broker path");
    }
    if (existing) await unlink(this.dependencies.socketPath);

    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    server.requestTimeout = SPORTS_BROWSER_LIMITS.deadlineMs;
    server.headersTimeout = 5_000;
    server.on("clientError", (_error, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.dependencies.socketPath);
    });
    this.server = server;
    await chmod(this.dependencies.socketPath, 0o660);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.dependencies.broker.dispose();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await unlink(this.dependencies.socketPath).catch(() => undefined);
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== "POST" || request.url !== SPORTS_BROWSER_ROUTES.fetch) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json") {
        sendJson(response, 415, { error: "unsupported_media_type" });
        return;
      }
      const parsed = parseBrowserFetchBody(await readRequestBody(request));
      if (!parsed.ok) {
        sendJson(response, parsed.reason === "body_too_large" ? 413 : 400, {
          error: parsed.reason
        });
        return;
      }
      const result = await this.dependencies.broker.fetch(parsed.value);
      if (!result.ok) {
        const status =
          result.reason === "unauthorized"
            ? 403
            : result.reason === "unknown_job"
              ? 404
              : result.reason === "timeout"
                ? 408
                : result.reason === "budget_exceeded"
                  ? 429
                  : result.reason === "protocol_violation"
                    ? 409
                    : 502;
        sendJson(response, status, { error: result.reason });
        return;
      }
      if (result.body.byteLength > SPORTS_BROWSER_LIMITS.maxResponseBytes) {
        this.dependencies.broker.cancelJob(parsed.value.jobId);
        sendJson(response, 502, { error: "response_too_large" });
        return;
      }
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": result.contentType ?? "application/octet-stream",
        "content-length": result.body.byteLength,
        "x-moss-sports-final-url": encodeURIComponent(result.finalUrl),
        "x-moss-sports-status": String(result.status)
      });
      Readable.from([Buffer.from(result.body)]).pipe(response);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        request.resume();
        sendJson(response, 413, { error: "body_too_large" });
        return;
      }
      sendJson(response, 400, { error: "invalid_request" });
    }
  }
}

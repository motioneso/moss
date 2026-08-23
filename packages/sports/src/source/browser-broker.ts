import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import {
  type BrowserFetchRequest,
  type BrowserRenderRequest,
  type BrowserResourceType,
  SPORTS_BROWSER_LIMITS
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

export interface SportsBrowserBrokerDependencies {
  readonly fetch: BrowserSafeFetch;
  readonly now?: () => number;
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

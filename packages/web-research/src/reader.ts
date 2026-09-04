import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import { DEFAULT_WEB_RESEARCH_CONFIG } from "./config.js";
import type { HostRateLimiter } from "./rate-limit.js";
import { RateLimitExceededError } from "./rate-limit.js";
import type { RobotsGate } from "./robots.js";
import { type HostResolver, type SafeHttpUrl, validateHttpUrl } from "./url-safety.js";

type WebFetch = typeof fetch;
export type WebRequestMethod = "GET" | "HEAD";

export interface FetchWebResourceHop {
  readonly url: URL;
  readonly address: string;
  readonly family: number;
  readonly method: WebRequestMethod;
  readonly redirectCount: number;
}

export interface WebHttpTransportRequest {
  readonly url: URL;
  readonly connectHost: string;
  readonly family: number;
  readonly hostHeader: string;
  readonly servername?: string;
  readonly method: WebRequestMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export type WebHttpTransport = (request: WebHttpTransportRequest) => Promise<Response>;

let testFetch: WebFetch | undefined;
let testHttpTransport: WebHttpTransport | undefined;

export function setWebFetchForTests(fetchImpl: WebFetch | undefined): void {
  testFetch = fetchImpl;
}

export function setWebHttpTransportForTests(transport: WebHttpTransport | undefined): void {
  testHttpTransport = transport;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

const ALLOWED_REQUEST_HEADERS = new Set(["accept", "accept-language"]);
const USER_AGENT_SHAPE = /^[\x20-\x7e]{1,200}$/;

function normalizeRequestHeaders(
  headers: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> | undefined {
  const normalized: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers ?? {})) {
    const name = rawName.toLowerCase();
    if (!ALLOWED_REQUEST_HEADERS.has(name) || value.length > 1_024) return undefined;
    try {
      new Headers({ [name]: value });
    } catch {
      return undefined;
    }
    normalized[name] = value;
  }
  return normalized;
}

function declaredContentLength(response: Response): number | null | undefined {
  const raw = response.headers.get("content-length");
  if (raw === null) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

async function readBytesCapped(
  response: Response,
  maxBytes: number
): Promise<{ body: Uint8Array; truncated: boolean; bytesRead: number }> {
  if (!response.body) {
    const body = new Uint8Array(await response.arrayBuffer());
    return {
      body: body.slice(0, maxBytes),
      truncated: body.byteLength > maxBytes,
      bytesRead: body.byteLength
    };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let bytesRead = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    bytesRead += value.byteLength;
    const remaining = maxBytes - total;
    if (value.byteLength > remaining) {
      chunks.push(value.slice(0, Math.max(0, remaining)));
      truncated = true;
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return { body: Buffer.concat(chunks), truncated, bytesRead };
}

async function readTextCapped(
  response: Response,
  maxBytes: number
): Promise<{ body: string; truncated: boolean; bytesRead: number }> {
  const result = await readBytesCapped(response, maxBytes);
  return {
    body: new TextDecoder().decode(result.body),
    truncated: result.truncated,
    bytesRead: result.bytesRead
  };
}

export function extractReadableText(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return {
    title: decodeHtml(title).trim(),
    text: decodeHtml(stripped).replace(/\s+/g, " ").trim()
  };
}

function decodeHtml(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Request aborted"));
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(new Error("Request aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      }
    );
  });
}

async function requestCheckedUrl(
  checked: SafeHttpUrl,
  signal: AbortSignal,
  method: WebRequestMethod,
  headers: Readonly<Record<string, string>>
): Promise<Response> {
  if (signal.aborted) throw new Error("Request aborted");
  const hostHeader = checked.url.host;
  const servername =
    checked.url.protocol === "https:" ? stripIpv6Brackets(checked.url.hostname) : undefined;
  const request = {
    url: checked.url,
    connectHost: checked.address,
    family: checked.family,
    hostHeader,
    servername,
    method,
    headers,
    signal
  };
  if (testHttpTransport) return testHttpTransport(request);
  if (testFetch) {
    return testFetch(checked.url, {
      redirect: "manual",
      method,
      signal,
      headers: { host: hostHeader, ...headers }
    });
  }
  return nodeHttpTransport(request);
}

export interface FetchWebResourceOptions {
  readonly requireHttps?: boolean;
  readonly allowedHosts?: readonly string[];
  readonly method?: WebRequestMethod;
  readonly requestHeaders?: Readonly<Record<string, string>>;
  /** Replaces the default User-Agent for this request; printable ASCII, at most 200 chars. */
  readonly userAgent?: string;
  readonly allowedContentTypes?: readonly string[];
  readonly beforeRequest?: (hop: FetchWebResourceHop) => boolean | void | Promise<boolean | void>;
  readonly robots?: RobotsGate;
  readonly rateLimiter?: HostRateLimiter;
  readonly maxBytes?: number;
  readonly rejectOversizedResponses?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly resolveHost?: HostResolver;
}

export interface FetchWebResourceSuccess<TBody> {
  readonly ok: true;
  readonly status: number;
  readonly finalUrl: string;
  readonly contentType: string | null;
  readonly body: TBody;
  readonly truncated: boolean;
  readonly bytesRead: number;
  readonly hopCount: number;
}

export type FetchWebResourceFailure = {
  readonly ok: false;
  readonly reason:
    | "blocked"
    | "robots"
    | "rate_limited"
    | "not_https"
    | "timeout"
    | "network"
    | "http_error";
  readonly detail?:
    | "aborted"
    | "invalid_response"
    | "response_too_large"
    | "unsupported_content_type";
  readonly status?: number;
  /** Raw Retry-After value; callers must apply their own bounded retry policy. */
  readonly retryAfter?: string;
  readonly bytesRead?: number;
};

export type FetchWebResourceResult = FetchWebResourceSuccess<string> | FetchWebResourceFailure;
export type FetchWebResourceBytesResult =
  | FetchWebResourceSuccess<Uint8Array>
  | FetchWebResourceFailure;

/**
 * Fetches a site's robots.txt, following ordinary redirects (for example a bare domain that
 * redirects everything, including robots.txt, to its own www address) instead of taking a single
 * redirect status at face value. Each hop is re-checked by `validateHttpUrl` so a redirect can
 * never send this request somewhere unsafe. Gives up and reports nothing (which the robots gate
 * treats as blocked) after too many hops, so an endless redirect chain still fails closed.
 */
async function fetchRobotsFileFollowingRedirects(
  robotsUrl: URL,
  controller: AbortController,
  options: FetchWebResourceOptions
): Promise<{ status: number; body: string } | null> {
  const maxBytes = options.maxBytes ?? DEFAULT_WEB_RESEARCH_CONFIG.maxDownloadBytes;
  let current = robotsUrl;
  for (let redirects = 0; redirects <= DEFAULT_WEB_RESEARCH_CONFIG.redirectLimit; redirects += 1) {
    const robotsSafe = await abortable(
      validateHttpUrl(current.toString(), options.resolveHost),
      controller.signal
    );
    if (!robotsSafe.ok) return null;
    if (options.rateLimiter) {
      await abortable(options.rateLimiter.acquire(robotsSafe.url.hostname), controller.signal);
    }
    const response = await requestCheckedUrl(robotsSafe, controller.signal, "GET", {});
    if (isRedirect(response.status)) {
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      if (!location) return null;
      current = new URL(location, current);
      continue;
    }
    const { body } = await readTextCapped(response, maxBytes);
    return { status: response.status, body };
  }
  return null;
}

async function fetchWebResourceWithBody<TBody>(
  rawUrl: string,
  options: FetchWebResourceOptions,
  readBody: (
    response: Response,
    maxBytes: number
  ) => Promise<{ body: TBody; truncated: boolean; bytesRead: number }>
): Promise<FetchWebResourceSuccess<TBody> | FetchWebResourceFailure> {
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "blocked" };
  }
  const allowedHosts = options.allowedHosts
    ? new Set(options.allowedHosts.map((host) => host.toLowerCase()))
    : undefined;
  const method = options.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") return { ok: false, reason: "blocked" };
  const normalizedHeaders = normalizeRequestHeaders(options.requestHeaders);
  if (!normalizedHeaders) return { ok: false, reason: "blocked" };
  if (options.userAgent !== undefined && !USER_AGENT_SHAPE.test(options.userAgent)) {
    return { ok: false, reason: "blocked" };
  }
  const requestHeaders: Readonly<Record<string, string>> =
    options.userAgent === undefined
      ? normalizedHeaders
      : { ...normalizedHeaders, "user-agent": options.userAgent };
  const allowedContentTypes = options.allowedContentTypes
    ? new Set(options.allowedContentTypes.map((value) => value.toLowerCase()))
    : undefined;
  if (options.signal?.aborted) {
    return { ok: false, reason: "network", detail: "aborted" };
  }
  const controller = new AbortController();
  let abortReason: "caller" | "timeout" | undefined;
  const abort = (reason: "caller" | "timeout"): void => {
    if (controller.signal.aborted) return;
    abortReason = reason;
    controller.abort();
  };
  const onCallerAbort = (): void => abort("caller");
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(
    () => abort("timeout"),
    options.timeoutMs ?? DEFAULT_WEB_RESEARCH_CONFIG.timeoutMs
  );
  try {
    for (
      let redirects = 0;
      redirects <= DEFAULT_WEB_RESEARCH_CONFIG.redirectLimit;
      redirects += 1
    ) {
      const safe = await abortable(
        validateHttpUrl(current.toString(), options.resolveHost),
        controller.signal
      );
      if (!safe.ok) return { ok: false, reason: "blocked" };
      if (allowedHosts && !allowedHosts.has(safe.url.hostname.toLowerCase())) {
        return { ok: false, reason: "blocked" };
      }
      if (options.requireHttps && safe.url.protocol !== "https:") {
        return { ok: false, reason: "not_https" };
      }
      if (options.robots) {
        const allowed = await options.robots.isAllowed(safe.url, async (robotsUrl) =>
          fetchRobotsFileFollowingRedirects(robotsUrl, controller, options)
        );
        if (!allowed) return { ok: false, reason: "robots" };
      }
      if (options.rateLimiter) {
        await abortable(options.rateLimiter.acquire(safe.url.hostname), controller.signal);
      }
      if (options.beforeRequest) {
        const allowed = await abortable(
          Promise.resolve(
            options.beforeRequest({
              url: new URL(safe.url),
              address: safe.address,
              family: safe.family,
              method,
              redirectCount: redirects
            })
          ),
          controller.signal
        );
        if (allowed === false) return { ok: false, reason: "blocked" };
      }
      const response = await requestCheckedUrl(safe, controller.signal, method, requestHeaders);
      const maxBytes = options.maxBytes ?? DEFAULT_WEB_RESEARCH_CONFIG.maxDownloadBytes;
      if (isRedirect(response.status)) {
        await response.body?.cancel().catch(() => {});
        if (options.rejectOversizedResponses) {
          const contentLength = declaredContentLength(response);
          if (contentLength === null) {
            return {
              ok: false,
              reason: "blocked",
              detail: "invalid_response",
              status: response.status,
              bytesRead: 0
            };
          }
          if (contentLength !== undefined && contentLength > maxBytes) {
            return {
              ok: false,
              reason: "blocked",
              detail: "response_too_large",
              status: response.status,
              bytesRead: 0
            };
          }
        }
        const location = response.headers.get("location");
        if (!location) return { ok: false, reason: "http_error", status: response.status };
        current = new URL(location, current);
        continue;
      }
      const contentLength = declaredContentLength(response);
      if (options.rejectOversizedResponses) {
        if (contentLength === null) {
          await response.body?.cancel().catch(() => {});
          return {
            ok: false,
            reason: "blocked",
            detail: "invalid_response",
            status: response.status,
            bytesRead: 0
          };
        }
        if (contentLength !== undefined && contentLength > maxBytes) {
          await response.body?.cancel().catch(() => {});
          return {
            ok: false,
            reason: "blocked",
            detail: "response_too_large",
            status: response.status,
            bytesRead: 0
          };
        }
      }
      if (response.status >= 400) {
        await response.body?.cancel().catch(() => {});
        const retryAfter = response.headers.get("retry-after") ?? undefined;
        return {
          ok: false,
          reason: "http_error",
          status: response.status,
          ...(retryAfter ? { retryAfter } : {})
        };
      }
      const contentType = response.headers.get("content-type");
      const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
      if (allowedContentTypes && (!mediaType || !allowedContentTypes.has(mediaType))) {
        await response.body?.cancel().catch(() => {});
        return {
          ok: false,
          reason: "blocked",
          detail: "unsupported_content_type",
          status: response.status
        };
      }
      const { body, truncated, bytesRead } = await readBody(response, maxBytes);
      if (options.rejectOversizedResponses && truncated) {
        return {
          ok: false,
          reason: "blocked",
          detail: "response_too_large",
          status: response.status,
          bytesRead
        };
      }
      if (
        options.rejectOversizedResponses &&
        method !== "HEAD" &&
        contentLength !== undefined &&
        contentLength !== bytesRead
      ) {
        return {
          ok: false,
          reason: "blocked",
          detail: "invalid_response",
          status: response.status,
          bytesRead
        };
      }
      return {
        ok: true,
        status: response.status,
        finalUrl: response.url || safe.url.toString(),
        contentType,
        body,
        truncated,
        bytesRead,
        hopCount: redirects
      };
    }
    return { ok: false, reason: "network" };
  } catch (error) {
    if (abortReason === "caller") {
      return { ok: false, reason: "network", detail: "aborted" };
    }
    if (abortReason === "timeout") return { ok: false, reason: "timeout" };
    if (error instanceof RateLimitExceededError) return { ok: false, reason: "rate_limited" };
    return { ok: false, reason: "network" };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}

export function fetchWebResource(
  rawUrl: string,
  options: FetchWebResourceOptions = {}
): Promise<FetchWebResourceResult> {
  return fetchWebResourceWithBody(rawUrl, options, readTextCapped);
}

export function fetchWebResourceBytes(
  rawUrl: string,
  options: FetchWebResourceOptions = {}
): Promise<FetchWebResourceBytesResult> {
  return fetchWebResourceWithBody(rawUrl, options, readBytesCapped);
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function headersFromIncoming(headers: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) out.set(key, value.join(", "));
    else if (value !== undefined) out.set(key, String(value));
  }
  return out;
}

async function nodeHttpTransport(input: WebHttpTransportRequest): Promise<Response> {
  const isHttps = input.url.protocol === "https:";
  const request = isHttps ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        protocol: input.url.protocol,
        hostname: input.connectHost,
        port: input.url.port || (isHttps ? 443 : 80),
        path: `${input.url.pathname}${input.url.search}`,
        method: input.method,
        headers: {
          host: input.hostHeader,
          "user-agent": "Jarvis-WebResearch/0.1",
          ...input.headers
        },
        servername: input.servername,
        lookup: (_hostname, _options, callback) => callback(null, input.connectHost, input.family)
      },
      (res: IncomingMessage) => {
        resolve(
          new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
            status: res.statusCode ?? 0,
            headers: headersFromIncoming(res.headers)
          })
        );
      }
    );
    req.on("error", reject);
    input.signal.addEventListener("abort", () => req.destroy(new Error("Request aborted")), {
      once: true
    });
    req.end();
  });
}

export async function readWebPage(rawUrl: string): Promise<
  | {
      readonly ok: true;
      readonly document: Record<string, unknown>;
    }
  | {
      readonly ok: false;
      readonly url: string;
      readonly reason: string;
    }
> {
  const response = await fetchWebResource(rawUrl);
  if (!response.ok) return { ok: false, url: rawUrl, reason: response.reason };
  try {
    const html = response.body;
    const extracted = extractReadableText(html);
    const cappedText = extracted.text.slice(0, DEFAULT_WEB_RESEARCH_CONFIG.maxExtractedChars);
    return {
      ok: true,
      document: {
        url: response.finalUrl,
        domain: new URL(response.finalUrl).hostname,
        title: extracted.title,
        text: cappedText,
        excerpt: cappedText.slice(0, 500),
        fetchedAt: new Date().toISOString(),
        truncated:
          response.truncated ||
          extracted.text.length > DEFAULT_WEB_RESEARCH_CONFIG.maxExtractedChars,
        status: response.status
      }
    };
  } catch (error) {
    return {
      ok: false,
      url: rawUrl,
      reason: error instanceof Error ? error.message : "Fetch failed"
    };
  }
}

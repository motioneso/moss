import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList } from "node:net";
import { promisify } from "node:util";
import { brotliDecompress, gunzip, inflate } from "node:zlib";

import { assertValidFetchHosts } from "./policy.js";

export type HostPinnedFetchErrorCode =
  | "host_not_declared"
  | "blocked_address"
  | "response_too_large"
  | "fetch_timeout"
  | "invalid_request";

export class HostPinnedFetchError extends Error {
  constructor(readonly code: HostPinnedFetchErrorCode) {
    super(code);
    this.name = "HostPinnedFetchError";
  }
}

export class HostPinningViolationError extends HostPinnedFetchError {
  constructor(
    readonly host: string,
    codeOrMessage: "host_not_declared" | "blocked_address" | string = "host_not_declared"
  ) {
    const code = codeOrMessage === "blocked_address" ? "blocked_address" : "host_not_declared";
    super(code);
    this.name = "HostPinningViolationError";
    if (codeOrMessage !== "host_not_declared" && codeOrMessage !== "blocked_address") {
      this.message = codeOrMessage;
    }
  }
}

export interface PinnedRequest {
  readonly address: string;
  readonly servername: string;
  readonly host: string;
  readonly path: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

export interface PinnedResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: AsyncIterable<Uint8Array>;
  readonly abort?: () => void;
}

export interface HostPinnedFetchOptions {
  readonly resolve?: (
    hostname: string
  ) => Promise<readonly { readonly address: string; readonly family: 4 | 6 }[]>;
  readonly request?: (request: PinnedRequest, signal: AbortSignal) => Promise<PinnedResponse>;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxRedirects?: number;
}

const HOP_HEADERS = new Set([
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

// This transport is typed `typeof fetch`, but it builds a raw https.request, so none of the
// headers undici's fetch adds for free are present unless we add them. Bot-mitigation edges score
// that bare shape as non-browser traffic: ESPN/Akamai answers 403 to any request missing
// accept + user-agent + accept-encoding *together* — each one alone still 403s (verified live
// 2026-08-05, prod sports outage; every dataset had silently degraded to its empty fallback).
// The UA needs a Product/Version token to pass: "jarv1s-host-fetch" is rejected where
// "Jarv1s/1.0 (+url)" is accepted, so keep the version and the URL. Callers override any of
// these by setting the same header themselves.
const DEFAULT_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  accept: "*/*",
  "accept-encoding": "gzip, deflate, br",
  "user-agent": "Jarv1s/1.0 (+https://github.com/motioneso/jarv1s)"
};

const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);
const brotliDecompressAsync = promisify(brotliDecompress);

/**
 * Decodes a `content-encoding` body. Advertising `accept-encoding` without decoding here would
 * hand callers compressed bytes and break every `response.json()` — the two halves ship together.
 *
 * `maxOutputLength` re-applies the caller's response cap to the *decompressed* size: the streaming
 * cap upstream only ever sees compressed bytes, so without this a small gzip bomb would expand
 * past the limit the caller asked for.
 */
async function decodeBody(
  body: Buffer,
  encoding: string | undefined,
  maxBytes: number
): Promise<Buffer> {
  const codec = encoding?.trim().toLowerCase();
  if (!codec || codec === "identity" || body.byteLength === 0) return body;
  const options = { maxOutputLength: maxBytes };
  try {
    if (codec === "gzip" || codec === "x-gzip") return await gunzipAsync(body, options);
    if (codec === "deflate") return await inflateAsync(body, options);
    if (codec === "br") return await brotliDecompressAsync(body, options);
  } catch {
    throw new HostPinnedFetchError("response_too_large");
  }
  // An encoding we never advertised: the peer ignored accept-encoding, so we cannot read it.
  throw new HostPinnedFetchError("invalid_request");
}
const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const)
  BLOCKED.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8]
] as const)
  BLOCKED.addSubnet(network, prefix, "ipv6");

export function createHostPinnedFetch(
  allowedHosts: readonly string[],
  options: HostPinnedFetchOptions | typeof fetch = {},
  legacyTimeoutMs?: number
): typeof fetch {
  assertValidFetchHosts("host-fetch", allowedHosts);
  if (typeof options === "function") {
    return createInjectedFetch(allowedHosts, options, legacyTimeoutMs ?? 15_000);
  }
  const allowed = new Set(allowedHosts);
  const resolve = options.resolve ?? defaultResolve;
  const request = options.request ?? defaultRequest;

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
    init?.signal?.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      let url = new URL(
        input instanceof URL ? input : typeof input === "string" ? input : input.url
      );
      let method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      let headers = requestHeaders(
        init?.headers ?? (input instanceof Request ? input.headers : undefined)
      );
      let body = await requestBody(init?.body, options.maxRequestBytes ?? 1_048_576);
      for (let hop = 0; ; hop += 1) {
        validateUrl(url, allowed);
        if (method !== "GET" && method !== "POST")
          throw new HostPinnedFetchError("invalid_request");
        if (method === "GET" && body) throw new HostPinnedFetchError("invalid_request");
        const answers = await withAbort(resolve(url.hostname), controller.signal);
        if (!answers.length || answers.some(({ address, family }) => isBlocked(address, family))) {
          throw new HostPinningViolationError(url.hostname, "blocked_address");
        }
        const response = await withAbort(
          request(
            {
              address: answers[0]!.address,
              servername: url.hostname,
              host: url.hostname,
              path: `${url.pathname}${url.search}`,
              method: method as "GET" | "POST",
              // Defaults first so a caller's own header always wins. Applied per hop, not once:
              // a cross-origin redirect clears `headers` below, and the next hop still needs them.
              headers: { ...DEFAULT_REQUEST_HEADERS, ...headers, host: url.hostname },
              ...(body ? { body } : {})
            },
            controller.signal
          ),
          controller.signal
        );
        if (REDIRECTS.has(response.status)) {
          const location = response.headers.location;
          response.abort?.();
          if (!location || hop >= (options.maxRedirects ?? 5)) {
            throw new HostPinnedFetchError("invalid_request");
          }
          const next = new URL(location, url);
          if (next.origin !== url.origin) headers = {};
          if (
            response.status === 303 ||
            ((response.status === 301 || response.status === 302) && method === "POST")
          ) {
            method = "GET";
            body = undefined;
          }
          url = next;
          continue;
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        const iterator = response.body[Symbol.asyncIterator]();
        for (;;) {
          const next = await withAbort(iterator.next(), controller.signal);
          if (next.done) break;
          const chunk = next.value;
          size += chunk.byteLength;
          if (size > (options.maxResponseBytes ?? 5 * 1024 * 1024)) {
            response.abort?.();
            throw new HostPinnedFetchError("response_too_large");
          }
          chunks.push(chunk);
        }
        if ([204, 205, 304].includes(response.status)) {
          return new Response(null, { status: response.status, headers: response.headers });
        }
        const decoded = await decodeBody(
          Buffer.concat(chunks),
          response.headers["content-encoding"],
          options.maxResponseBytes ?? 5 * 1024 * 1024
        );
        // The body handed to the caller is decoded, so the encoding/length headers describing the
        // wire form would now be lies — and `content-encoding` would make a fetch-shaped consumer
        // try to inflate it a second time.
        const responseHeaders = { ...response.headers };
        delete responseHeaders["content-encoding"];
        delete responseHeaders["content-length"];
        // Re-wrapped because promisified zlib returns Buffer<ArrayBufferLike>, which BodyInit
        // rejects (it could be backed by a SharedArrayBuffer).
        return new Response(new Uint8Array(decoded), {
          status: response.status,
          headers: responseHeaders
        });
      }
    } catch (error) {
      if (timedOut) throw new HostPinnedFetchError("fetch_timeout");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }) as typeof fetch;
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function createInjectedFetch(
  allowedHosts: readonly string[],
  fetchFn: typeof fetch,
  timeoutMs: number
): typeof fetch {
  const allowed = new Set(allowedHosts);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    let url = new URL(input instanceof URL ? input : typeof input === "string" ? input : input.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Chain the caller's own signal instead of overwriting it (#1265 N3) — a caller-supplied
    // AbortSignal (e.g. espn-source.ts's per-call timeout) must still abort this fetch; mirrors
    // the production createHostPinnedFetch path's `init?.signal?.addEventListener(...)` below.
    init?.signal?.addEventListener("abort", () => controller.abort(), { once: true });
    let currentInit = { ...init, signal: controller.signal };
    let method = (init?.method ?? "GET").toUpperCase();
    try {
      for (let hop = 0; ; hop += 1) {
        validateLegacyUrl(url, allowed);
        const response = await fetchFn(url, { ...currentInit, redirect: "manual" });
        if (!REDIRECTS.has(response.status)) return response;
        const location = response.headers.get("location");
        if (!location) return response;
        if (hop >= 5) throw new Error("Dataset runtime host pinning: exceeded 5 redirects");
        const next = new URL(location, url);
        if (next.hostname !== url.hostname) {
          const nextHeaders = new Headers(currentInit.headers);
          nextHeaders.delete("authorization");
          currentInit = { ...currentInit, headers: nextHeaders };
        }
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) &&
            method !== "GET" &&
            method !== "HEAD")
        ) {
          const { body: _body, ...rest } = currentInit;
          currentInit = { ...rest, method: "GET" };
          method = "GET";
        }
        url = next;
      }
    } finally {
      clearTimeout(timer);
    }
  }) as typeof fetch;
}

function validateLegacyUrl(url: URL, allowed: ReadonlySet<string>): void {
  if (url.protocol !== "https:" || !allowed.has(url.hostname)) {
    throw new HostPinningViolationError(url.hostname);
  }
}

function validateUrl(url: URL, allowed: ReadonlySet<string>): void {
  if (
    url.protocol !== "https:" ||
    (url.port && url.port !== "443") ||
    url.username ||
    url.password
  ) {
    throw new HostPinnedFetchError("invalid_request");
  }
  if (!allowed.has(url.hostname)) throw new HostPinningViolationError(url.hostname);
}

function requestHeaders(input?: HeadersInit): Record<string, string> {
  const result: Record<string, string> = {};
  new Headers(input).forEach((value, name) => {
    if (HOP_HEADERS.has(name)) throw new HostPinnedFetchError("invalid_request");
    result[name] = value;
  });
  return result;
}

async function requestBody(
  input: BodyInit | null | undefined,
  max: number
): Promise<Uint8Array | undefined> {
  if (input == null) return undefined;
  let body: Uint8Array;
  if (typeof input === "string") body = Buffer.from(input);
  else if (input instanceof ArrayBuffer) body = new Uint8Array(input);
  else if (ArrayBuffer.isView(input))
    body = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  else if (input instanceof Blob) body = new Uint8Array(await input.arrayBuffer());
  else throw new HostPinnedFetchError("invalid_request");
  if (body.byteLength > max) throw new HostPinnedFetchError("invalid_request");
  return body;
}

function isBlocked(address: string, family: 4 | 6): boolean {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (dotted) return BLOCKED.check(dotted, "ipv4");
  // Hex-form v4-mapped (e.g. ::ffff:a9fe:a9fe = 169.254.169.254, the cloud-metadata target)
  // skips the dotted-form regex above, so it must be normalized to ipv4 explicitly. Deliberately
  // NOT handled by adding an "::ffff:0:0"/96 entry to the ipv6 BLOCKED list: Node's BlockList
  // treats a v4-mapped ipv6 subnet as covering the corresponding ipv4 address space too, so that
  // one entry silently blocks every ipv4 "check" call as well (verified empirically) — it would
  // have broken every legitimate external fetch, not just closed this gap.
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    const asIpv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return BLOCKED.check(asIpv4, "ipv4");
  }
  return BLOCKED.check(address, family === 4 ? "ipv4" : "ipv6");
}

async function defaultResolve(hostname: string) {
  return lookup(hostname, { all: true, verbatim: true }) as Promise<
    { address: string; family: 4 | 6 }[]
  >;
}

function defaultRequest(input: PinnedRequest, signal: AbortSignal): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: input.address,
        port: 443,
        servername: input.servername,
        path: input.path,
        method: input.method,
        headers: input.headers,
        signal
      },
      (response) => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
        }
        resolve({
          status: response.statusCode ?? 500,
          headers,
          body: response,
          abort: () => response.destroy()
        });
      }
    );
    req.once("error", reject);
    if (input.body) req.write(input.body);
    req.end();
  });
}

export { assertValidFetchHosts, isPinnableHost } from "./policy.js";

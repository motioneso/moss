import type { FastifyReply, FastifyRequest } from "fastify";
import type { MossAuthRuntime } from "@moss/auth";

// Adapter between Fastify and better-auth's web-standard handler. Extracted from server.ts
// (#1725) purely to keep that file under the 1000-line check — no behaviour changed. It stays
// together in one file because the four helpers below exist only to serve the first function.

export async function handleBetterAuthRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  authRuntime: MossAuthRuntime
) {
  const response = await authRuntime.auth.handler(toWebRequest(request));

  reply.code(response.status);
  for (const [name, value] of response.headers.entries()) {
    if (name.toLowerCase() === "set-cookie" || name.toLowerCase() === "content-length") {
      continue;
    }
    reply.header(name, value);
  }

  const setCookieHeaders = readSetCookieHeaders(response.headers);
  if (setCookieHeaders.length > 0) {
    reply.header("set-cookie", setCookieHeaders);
  }

  const body = Buffer.from(await response.arrayBuffer());

  return body.length > 0 ? reply.send(body) : reply.send();
}

function toWebRequest(request: FastifyRequest): Request {
  const headers = toWebHeaders(request.headers);
  // Build the better-auth URL from Fastify's protocol/host, which already honor the
  // explicit `trustProxy` opt-in (JARVIS_TRUST_PROXY): forwarded headers are consulted
  // only when a trusted proxy is configured, and otherwise fall back to the connection
  // scheme/host. Reading x-forwarded-proto / host directly off client headers would
  // trust attacker-controlled values regardless of that opt-in (#164).
  const protocol = request.protocol;
  const host = request.host || "localhost:3000";
  const url = `${protocol}://${host}${request.url}`;
  const init: RequestInit = {
    method: request.method,
    headers
  };

  if (request.method !== "GET" && request.method !== "HEAD" && request.body !== undefined) {
    init.body = encodeBody(request.body);
  }

  return new Request(url, init);
}

function toWebHeaders(headers: FastifyRequest["headers"]): Headers {
  const webHeaders = new Headers();

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        webHeaders.append(name, item);
      }
      continue;
    }
    webHeaders.set(name, String(value));
  }

  return webHeaders;
}

function encodeBody(body: unknown): BodyInit {
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array) {
    const copy = new Uint8Array(body.byteLength);
    copy.set(body);

    return copy.buffer;
  }

  return JSON.stringify(body);
}

function readSetCookieHeaders(headers: Headers): string[] {
  const headerWithSetCookie = headers as Headers & {
    getSetCookie?: () => string[];
  };

  return headerWithSetCookie.getSetCookie?.() ?? [];
}

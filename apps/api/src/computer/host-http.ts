import { request } from "node:http";
import type { IncomingMessage } from "node:http";

/** Limits apply to decoded JSON bytes and wall time, including slow/trickled bodies. */
export async function readHostJson(stream: IncomingMessage, limit: number): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new Error("Host message too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export class HostHttpError extends Error {
  constructor(readonly status: number) {
    super("Host transport unavailable");
  }
}

/** Private Unix HTTP transport, with no redirects, credentials, logging or network fallback. */
export function hostJsonRequest(input: {
  socketPath: string;
  path: string;
  method: "GET" | "POST" | "DELETE";
  body?: unknown;
  limit: number;
  timeoutMs: number;
}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    const outgoing = request({
      socketPath: input.socketPath,
      path: input.path,
      method: input.method,
      agent: false,
      headers:
        body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body)
            }
    });
    const timer = setTimeout(
      () => outgoing.destroy(new Error("Host request timeout")),
      input.timeoutMs
    );
    outgoing.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Host transport unavailable"));
    });
    outgoing.once("response", (response) => {
      const status = response.statusCode ?? 500;
      if (status < 200 || status >= 300) {
        response.destroy();
        clearTimeout(timer);
        reject(new HostHttpError(status));
        return;
      }
      if (status === 204 || response.headers["content-length"] === "0") {
        response.resume();
        clearTimeout(timer);
        resolve(null);
        return;
      }
      void readHostJson(response, input.limit)
        .then(resolve, () => {
          response.destroy();
          reject(new Error("Host transport unavailable"));
        })
        .finally(() => clearTimeout(timer));
    });
    outgoing.end(body);
  });
}

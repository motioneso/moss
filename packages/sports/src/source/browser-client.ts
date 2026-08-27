import { request as httpRequest, type IncomingMessage } from "node:http";

import { type BrowserFetchEvidence, type SportsBrowserBroker } from "./browser-broker.js";
import {
  parseBrowserRenderResultBody,
  SPORTS_BROWSER_LIMITS,
  SPORTS_BROWSER_ROUTES
} from "./browser-protocol.js";

export interface SportsBrowserClientDependencies {
  readonly broker: SportsBrowserBroker;
  readonly socketPath: string;
}

export type SportsBrowserRenderResult =
  | {
      readonly ok: true;
      readonly finalUrl: string;
      readonly domHtml: string;
      readonly evidence: readonly BrowserFetchEvidence[];
    }
  | {
      readonly ok: false;
      readonly reason: "cancelled" | "timeout" | "render_failed" | "unsupported";
    };

async function readResponseBody(response: IncomingMessage): Promise<Buffer> {
  const declared = response.headers["content-length"];
  if (
    declared !== undefined &&
    (!/^(0|[1-9]\d*)$/.test(declared) ||
      Number(declared) > SPORTS_BROWSER_LIMITS.maxRenderResultBytes)
  ) {
    throw new Error("Invalid renderer response length");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response) {
    const bytes = Buffer.from(chunk as Uint8Array);
    total += bytes.byteLength;
    if (total > SPORTS_BROWSER_LIMITS.maxRenderResultBytes) {
      throw new Error("Renderer response too large");
    }
    chunks.push(bytes);
  }
  if (declared !== undefined && Number(declared) !== total) {
    throw new Error("Mismatched renderer response length");
  }
  return Buffer.concat(chunks);
}

export class SportsBrowserClient {
  constructor(private readonly dependencies: SportsBrowserClientDependencies) {}

  async render(input: {
    readonly url: string;
    readonly allowedHosts: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<SportsBrowserRenderResult> {
    let control;
    try {
      control = this.dependencies.broker.createJob(input);
    } catch {
      return { ok: false, reason: "unsupported" };
    }
    if (input.signal?.aborted) {
      this.dependencies.broker.cancelJob(control.jobId);
      return { ok: false, reason: "cancelled" };
    }

    try {
      const body = Buffer.from(JSON.stringify(control));
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const request = httpRequest(
          {
            socketPath: this.dependencies.socketPath,
            path: SPORTS_BROWSER_ROUTES.render,
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": body.byteLength
            }
          },
          resolve
        );
        const onAbort = (): void => {
          request.destroy(new Error("Render cancelled"));
        };
        input.signal?.addEventListener("abort", onAbort, { once: true });
        request.once("close", () => input.signal?.removeEventListener("abort", onAbort));
        request.once("error", reject);
        request.setTimeout(SPORTS_BROWSER_LIMITS.deadlineMs, () => {
          request.destroy(new Error("Renderer timed out"));
        });
        request.end(body);
      });
      if (
        response.statusCode !== 200 ||
        response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !==
          "application/json"
      ) {
        throw new Error("Renderer unavailable");
      }
      const parsed = parseBrowserRenderResultBody(await readResponseBody(response));
      if (!parsed.ok || parsed.value.jobId !== control.jobId) {
        throw new Error("Invalid renderer response");
      }
      const completion = this.dependencies.broker.completeJob(control.jobId, control.capability);
      if (!completion.ok) return { ok: false, reason: "unsupported" };
      if (!parsed.value.ok) return { ok: false, reason: parsed.value.reason };
      return {
        ok: true,
        finalUrl: parsed.value.finalUrl,
        domHtml: parsed.value.domHtml,
        evidence: completion.evidence
      };
    } catch {
      this.dependencies.broker.cancelJob(control.jobId);
      return { ok: false, reason: input.signal?.aborted ? "cancelled" : "unsupported" };
    }
  }
}

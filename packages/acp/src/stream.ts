/**
 * An ACP toolkit `Stream` backed by the runner line tunnel (#2369 slice 1).
 *
 * Outgoing toolkit messages are serialized to NDJSON lines and sent; incoming
 * adapter stdout lines are parsed back into toolkit messages by polling. A line
 * that is not valid JSON-RPC is dropped with a warning — stdout is protocol, and
 * the adapter keeps its diagnostics on stderr by contract.
 */

import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";

import type { AcpTunnel } from "./tunnel.js";

export interface TunnelStreamOptions {
  readonly pollMs?: number;
}

const DEFAULT_POLL_MS = 200;

function isJsonRpcMessage(value: unknown): value is AnyMessage {
  if (!value || typeof value !== "object") return false;
  const jsonrpc = (value as { jsonrpc?: unknown }).jsonrpc;
  return jsonrpc === "2.0";
}

export function createTunnelStream(
  tunnel: AcpTunnel,
  sessionKey: string,
  options: TunnelStreamOptions = {}
): Stream {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  let stopped = false;
  let seq = 0;

  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      if (stopped) throw new Error("ACP tunnel stream is closed");
      await tunnel.send(sessionKey, JSON.stringify(message));
    }
  });

  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      void (async () => {
        try {
          while (!stopped) {
            let result;
            try {
              result = await tunnel.read(sessionKey, seq);
            } catch (error) {
              // The session going away under a live poll (kill racing read) is
              // an expected shutdown, not a transport failure: end quietly.
              // Anything else still surfaces to the toolkit.
              if (
                error instanceof Error &&
                /ACP session (is not running|has exited)/.test(error.message)
              ) {
                controller.close();
                stopped = true;
                return;
              }
              throw error;
            }
            // Advance by lines actually delivered, never by the session total:
            // a reply cut by the runner's cap resumes where it stopped instead
            // of skipping lines forever.
            if (result.lines.length > 0) {
              seq = result.firstSeq + result.lines.length - 1;
            }
            if (result.truncated) {
              console.warn("[acp] runner cut buffered adapter lines for this session");
            }
            let delivered = false;
            for (const line of result.lines) {
              let parsed: unknown;
              try {
                parsed = JSON.parse(line);
              } catch {
                console.warn("[acp] dropped non-JSON adapter line");
                continue;
              }
              if (!isJsonRpcMessage(parsed)) {
                console.warn("[acp] dropped non-JSON-RPC adapter line");
                continue;
              }
              controller.enqueue(parsed);
              delivered = true;
            }
            if (result.exited) {
              // Drain first: lines already enqueued above still reach the
              // toolkit; with nothing left the stream ends and the pump stops.
              controller.close();
              stopped = true;
              return;
            }
            if (!delivered) {
              await new Promise((resolve) => setTimeout(resolve, pollMs));
            }
          }
        } catch (error) {
          controller.error(error);
        }
      })();
    },
    cancel() {
      stopped = true;
    }
  });

  return { writable, readable };
}

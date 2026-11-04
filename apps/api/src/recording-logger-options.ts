import type { FastifyServerOptions } from "fastify";
import {
  createSanitizedLogDestination,
  createSanitizingFormatters,
  type LogWriteTarget
} from "@moss/shared/log-sanitizer";
const recordingSecretPaths = [
  "req.headers.authorization",
  "headers.authorization",
  "req.headers.cookie",
  "headers.cookie",
  "req.body.credential",
  "body.credential",
  "body.verifier",
  "body.pcmBase64",
  "body.recordingProof",
  'req.headers["x-moss-recording-proof"]',
  'headers["x-moss-recording-proof"]',
  "req.body.verifier",
  "req.body.pcmBase64",
  "req.body.recordingProof"
];
/**
 * Add secret redaction and a sanitizing output stream without dropping a caller's stream,
 * serializers or existing policy. Every line is masked before it reaches the stream.
 */
export function recordingLoggerOptions(
  logger: FastifyServerOptions["logger"]
): FastifyServerOptions["logger"] {
  if (logger === false) return false;
  const configured = typeof logger === "object" ? logger : {};
  const existing = configured.redact;
  const paths = Array.isArray(existing) ? existing : (existing?.paths ?? []);
  const target = ("stream" in configured ? configured.stream : undefined) as
    | LogWriteTarget
    | undefined;
  return {
    ...configured,
    // log-safe: the sanitizing destination wraps the raw stream
    stream: createSanitizedLogDestination(target ?? process.stdout),
    formatters: {
      ...configured.formatters,
      ...createSanitizingFormatters({
        log: configured.formatters?.log,
        serializerKeys: Object.keys(configured.serializers ?? {})
      })
    },
    redact: {
      ...(existing && !Array.isArray(existing) ? existing : {}),
      paths: [...new Set([...paths, ...recordingSecretPaths])]
    }
  };
}

import type { FastifyServerOptions } from "fastify";
import type { Kysely } from "kysely";

import type { MossDatabase } from "@moss/db";
import {
  createDiagnosticLogDestination,
  createDiagnosticLogSink,
  type DiagnosticLogSink
} from "@moss/settings";
import { createSanitizingFormatters, type LogWriteTarget } from "@moss/shared/log-sanitizer";
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
  logger: FastifyServerOptions["logger"],
  deps: { sink?: DiagnosticLogSink | null } = {}
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
    stream: createDiagnosticLogDestination({
      process: "api",
      target: target ?? process.stdout,
      sink: deps.sink ?? null
    }),
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

/** The API's table writer. `logger: false` means no logging at all, so no sink either. */
export function createApiLogSink(
  logger: FastifyServerOptions["logger"],
  workerDb: Kysely<MossDatabase>
): DiagnosticLogSink | null {
  return logger === false ? null : createDiagnosticLogSink({ db: workerDb, process: "api" });
}

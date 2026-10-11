import type { FastifyServerOptions } from "fastify";
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
/** Add secret redaction without dropping a caller's stream, serializers or existing policy. */
export function recordingLoggerOptions(
  logger: FastifyServerOptions["logger"]
): FastifyServerOptions["logger"] {
  if (logger === false) return false;
  const configured = typeof logger === "object" ? logger : {};
  const existing = configured.redact;
  const paths = Array.isArray(existing) ? existing : (existing?.paths ?? []);
  return {
    ...configured,
    redact: {
      ...(existing && !Array.isArray(existing) ? existing : {}),
      paths: [...new Set([...paths, ...recordingSecretPaths])]
    }
  };
}

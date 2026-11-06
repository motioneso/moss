import type { FastifyBaseLogger } from "fastify";

import { withCurrentLogOwner } from "@moss/settings";

/**
 * Error-only logger for long-lived clients shared across users. Each record carries the owner of
 * the request or job that is running when the client logs.
 */
export function createOwnerAwareErrorLogger(base: FastifyBaseLogger): {
  error: (data: Record<string, unknown>, message: string) => void;
} {
  return { error: (data, message) => base.error(withCurrentLogOwner(data), message) };
}

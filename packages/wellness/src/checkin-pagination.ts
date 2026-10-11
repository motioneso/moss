import { HttpError } from "@moss/module-sdk";

interface CheckinCursor {
  readonly checkedInAt: string;
  readonly id: string;
  readonly since: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRECISE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Preserve PostgreSQL microseconds; a JavaScript Date would round a page boundary. */
export function encodeCheckinCursor(checkedInAt: string, id: string, since?: Date): string {
  return Buffer.from(
    JSON.stringify({ checkedInAt, id, since: since?.toISOString() ?? null })
  ).toString("base64url");
}

/** Cursors describe ordering, never authorization. Every page still uses the owner's RLS. */
export function parseCheckinCursor(
  token: string | undefined,
  since?: Date
): CheckinCursor | undefined {
  if (token === undefined) return undefined;
  const invalid = () =>
    new HttpError(400, "Invalid check-in cursor. Restart history from the newest entries.");
  if (!token || token.length > 512 || !/^[A-Za-z0-9_-]+$/.test(token)) throw invalid();
  let parsed: unknown;
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    if (Buffer.from(decoded).toString("base64url") !== token) throw invalid();
    parsed = JSON.parse(decoded);
  } catch {
    throw invalid();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid();
  const value = parsed as Record<string, unknown>;
  const stamp = value["checkedInAt"];
  const id = value["id"];
  if (
    typeof stamp !== "string" ||
    !PRECISE_TIMESTAMP.test(stamp) ||
    stamp.startsWith("0000-") ||
    typeof id !== "string" ||
    !UUID.test(id)
  )
    throw invalid();
  const date = new Date(stamp);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== stamp.slice(0, 19))
    throw invalid();
  const filter = since?.toISOString() ?? null;
  if (value["since"] !== filter)
    throw new HttpError(400, "Check-in cursor does not match this date window. Restart the read.");
  return { checkedInAt: stamp, id, since: filter };
}

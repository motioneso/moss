import { createHmac, randomBytes } from "node:crypto";

import { WORK_MAIL_SEEN_MAX, type CapturedMailMessage, type WorkMailCursor } from "./types.js";

export const WORK_MAIL_CURSOR_KEY = "outlook_mail.cursor";

export function createWorkMailCursor(): WorkMailCursor {
  return { marker: null, seen: [], salt: randomBytes(32).toString("base64url") };
}

export function workMailKey(cursor: WorkMailCursor, message: CapturedMailMessage): string {
  return createHmac("sha256", cursor.salt)
    .update(JSON.stringify([message.sender, message.subject, message.receivedAt]))
    .digest("base64url");
}

export function isNewerThanCursor(cursor: WorkMailCursor, message: CapturedMailMessage): boolean {
  const timestamp = Date.parse(message.receivedAt);
  if (!Number.isFinite(timestamp)) return false;
  const key = workMailKey(cursor, message);
  return (
    !cursor.seen.includes(key) &&
    key !== cursor.marker?.key &&
    (cursor.marker === null || timestamp >= Date.parse(cursor.marker.receivedAt))
  );
}

export function advanceWorkMailCursor(
  cursor: WorkMailCursor,
  message: CapturedMailMessage
): WorkMailCursor {
  const key = workMailKey(cursor, message);
  return {
    marker: { receivedAt: new Date(message.receivedAt).toISOString(), key },
    seen: [...cursor.seen.filter((seen) => seen !== key), key].slice(-WORK_MAIL_SEEN_MAX),
    salt: cursor.salt
  };
}

export function parseWorkMailCursor(value: unknown): WorkMailCursor {
  if (typeof value !== "object" || value === null) return createWorkMailCursor();
  if (!("salt" in value) || typeof value.salt !== "string" || !/^[\w-]{43}$/.test(value.salt)) {
    return createWorkMailCursor();
  }
  if (!("seen" in value) || !Array.isArray(value.seen)) return createWorkMailCursor();
  const seen = value.seen.filter(
    (key): key is string => typeof key === "string" && /^[\w-]{43}$/.test(key)
  );
  if (seen.length !== value.seen.length) return createWorkMailCursor();
  if (!("marker" in value)) return createWorkMailCursor();
  const marker = value.marker;
  if (marker === null) return { marker, seen: seen.slice(-WORK_MAIL_SEEN_MAX), salt: value.salt };
  if (
    typeof marker !== "object" ||
    !("receivedAt" in marker) ||
    typeof marker.receivedAt !== "string" ||
    !Number.isFinite(Date.parse(marker.receivedAt)) ||
    !("key" in marker) ||
    typeof marker.key !== "string" ||
    !/^[\w-]{43}$/.test(marker.key)
  ) {
    return createWorkMailCursor();
  }
  return {
    marker: { receivedAt: new Date(marker.receivedAt).toISOString(), key: marker.key },
    seen: seen.slice(-WORK_MAIL_SEEN_MAX),
    salt: value.salt
  };
}

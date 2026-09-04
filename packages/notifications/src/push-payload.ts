const TITLE_MAX_LENGTH = 60;
const BODY_MAX_LENGTH = 120;

export interface WebPushNotificationPayload {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly href: string | null;
}

/**
 * Caps a notification down to the push payload boundary agreed in the spec (Resolved
 * Decision 1): title, and the body's first line only, both capped in length. No metadata,
 * module data, or user data — this is the entire cross-network payload.
 */
export function buildPushPayload(notification: {
  readonly id: string;
  readonly title: string;
  readonly body?: string | null;
  readonly href?: string | null;
}): WebPushNotificationPayload {
  const firstBodyLine = (notification.body ?? "").split("\n")[0] ?? "";

  return {
    id: notification.id,
    title: truncate(notification.title, TITLE_MAX_LENGTH),
    body: truncate(firstBodyLine, BODY_MAX_LENGTH),
    href: notification.href ?? null
  };
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

export const NOTIFICATION_SENSITIVITY_PREFERENCE_KEY = "notifications:sensitivity";

export type NotificationSensitivity = "quiet" | "balanced" | "proactive";
export type NotificationUrgency = "urgent" | "normal" | "low";

const LEVELS: readonly NotificationSensitivity[] = ["quiet", "balanced", "proactive"];

export function sensitivityFromRaw(raw: unknown): NotificationSensitivity {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "balanced";
  const value = (raw as { sensitivity?: unknown }).sensitivity;
  return LEVELS.find((level) => level === value) ?? "balanced";
}

export function sensitivityToRaw(sensitivity: NotificationSensitivity): { sensitivity: string } {
  return { sensitivity };
}

// Governs only the immediate web push. The in-app list and the digest keep everything.
export function shouldPushImmediately(
  sensitivity: NotificationSensitivity,
  urgency: NotificationUrgency
): boolean {
  if (urgency === "urgent") return true;
  if (sensitivity === "quiet") return false;
  if (sensitivity === "balanced") return urgency !== "low";
  return true;
}

import { describe, expect, it } from "vitest";

import { CHAT_DELIVER_REMINDER_QUEUE_DEFINITION } from "../../packages/chat/src/reminders/deliver.js";
import {
  REMINDER_CAPACITY_REPLY,
  REMINDER_LATE_AFTER_MS,
  REMINDER_OPEN_LIMIT,
  describeDelay,
  reminderDeliveredMessage
} from "../../packages/chat/src/reminders/wording.js";

// pg-boss polls every 2 seconds by default; the delivery worker keeps that default.
const WORKER_POLL_MS = 2_000;

describe("reminder late threshold", () => {
  it("stays above one poll plus the first retry, so a normal delivery never reads as late", () => {
    const firstRetryMs = (CHAT_DELIVER_REMINDER_QUEUE_DEFINITION.options?.retryDelay ?? 0) * 1000;
    expect(firstRetryMs).toBe(15_000);
    expect(REMINDER_LATE_AFTER_MS).toBeGreaterThan(WORKER_POLL_MS + firstRetryMs);
  });

  it("says so when a delivery is late", () => {
    expect(reminderDeliveredMessage("stretch", false)).toBe("Reminder: stretch");
    expect(reminderDeliveredMessage("stretch", true)).toBe(
      "Reminder (this is late, I couldn't send it on time): stretch"
    );
  });
});

describe("describeDelay", () => {
  it("names each unit in words", () => {
    expect(describeDelay(1)).toBe("1 second");
    expect(describeDelay(600)).toBe("10 minutes");
    expect(describeDelay(90_061)).toBe("1 day, 1 hour, 1 minute and 1 second");
    expect(describeDelay(2_592_000)).toBe("30 days");
  });
});

describe("capacity reply", () => {
  // Delivered reminders stay counted until #3311, so the reply must not promise a slot frees up.
  it("states the limit without promising when a slot frees up", () => {
    expect(REMINDER_CAPACITY_REPLY).toContain(String(REMINDER_OPEN_LIMIT));
    expect(REMINDER_CAPACITY_REPLY).not.toMatch(/gone off|replied|once|when one/i);
  });
});

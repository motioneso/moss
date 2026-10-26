import { describe, expect, it } from "vitest";
import {
  advanceWorkMailCursor,
  createWorkMailCursor,
  isNewerThanCursor,
  workMailKey
} from "../../packages/connectors/src/work-mail/cursor.js";

const message = {
  sender: "invented@example.test",
  subject: "Invented",
  receivedAt: "2026-10-26T10:00:00Z",
  threadHint: null,
  body: "Invented body",
  bodyTruncated: false
};
describe("work mail last-read state", () => {
  it("accepts distinct messages at the same time, skips seen hashes and older messages", () => {
    const cursor = advanceWorkMailCursor(createWorkMailCursor(), message);
    expect(isNewerThanCursor(cursor, message)).toBe(false);
    expect(isNewerThanCursor(cursor, { ...message, subject: "Other invented subject" })).toBe(true);
    expect(isNewerThanCursor(cursor, { ...message, receivedAt: "2026-10-25T10:00:00Z" })).toBe(
      false
    );
    expect(workMailKey(cursor, message)).toMatch(/^[\w-]{43}$/);
    expect(workMailKey(createWorkMailCursor(), message)).not.toBe(workMailKey(cursor, message));
  });
  it("drops the oldest hashes beyond 500 and stores no message fields", () => {
    let cursor = createWorkMailCursor();
    for (let index = 0; index < 501; index++)
      cursor = advanceWorkMailCursor(cursor, { ...message, subject: `Invented ${index}` });
    expect(cursor.seen).toHaveLength(500);
    expect(cursor.seen).not.toContain(workMailKey(cursor, { ...message, subject: "Invented 0" }));
    expect(JSON.stringify(cursor)).not.toContain(message.sender);
    expect(JSON.stringify(cursor)).not.toContain("Invented");
  });
});

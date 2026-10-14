import { expect, it } from "vitest";
import { scheduledRead } from "../../packages/chat/src/reminders/commands/scheduled-read.js";

it("gives availability advice without saving or touching the source when the model is unavailable", async () => {
  const result = await scheduledRead({} as never, {
    kind: "scheduled_read",
    failure: "unavailable",
    taskId: null,
    title: "",
    when: null
  });
  expect(result.reply).toBe(
    "I couldn't set that check right now, so nothing is set. Try again in a moment."
  );
  expect(result.save).toBeUndefined();
});

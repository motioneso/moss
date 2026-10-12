import { cancel, recognizeCancel } from "./cancel.js";
import { clockRequest } from "./clock-request.js";
import { list, recognizeList } from "./list.js";
import { request } from "./request.js";
import type { ReminderCommandHandler, ReminderTurnPlan } from "./types.js";

export const reminderCommands = {
  request: { execute: request },
  clock_request: { execute: clockRequest },
  list: { execute: list, recognize: recognizeList },
  cancel: { execute: cancel, recognize: recognizeCancel }
} satisfies Record<
  Exclude<ReminderTurnPlan["kind"], "unsupported" | "main_only">,
  {
    readonly execute: ReminderCommandHandler;
    readonly recognize?: (request: string) => ReminderTurnPlan | undefined;
  }
>;

import { responsibilityAgreement } from "../../responsibility-agreements/command.js";
import { repeatRequest } from "./repeat-request.js";
import { edit } from "./edit.js";
import { scheduledRead } from "./scheduled-read.js";
import { pause, recognizePause } from "./pause.js";
import { resume, recognizeResume } from "./resume.js";
import { deleteRequest, recognizeDelete } from "./delete.js";
import { confirmDelete } from "./confirm-delete.js";
import { cancel, recognizeCancel } from "./cancel.js";
import { clockRequest } from "./clock-request.js";
import { quietHoursAllowance } from "./quiet-hours-allowance.js";
import { request } from "./request.js";
import type { ReminderCommandHandler, ReminderTurnPlan } from "./types.js";

export const reminderCommands = {
  scope_proposal: { execute: responsibilityAgreement },
  scope_agreement: { execute: responsibilityAgreement },
  scope_refused: { execute: responsibilityAgreement },
  edit: { execute: edit },
  edit_selection: { execute: edit },
  edit_refused: { execute: edit },
  scheduled_read: { execute: scheduledRead },
  pause: { execute: pause, recognize: recognizePause },
  resume: { execute: resume, recognize: recognizeResume },
  delete: { execute: deleteRequest, recognize: recognizeDelete },
  confirm_delete: { execute: confirmDelete },
  quiet_allowance: { execute: quietHoursAllowance },
  quiet_agreement: { execute: quietHoursAllowance },
  request: { execute: request },
  repeat_request: { execute: repeatRequest },
  clock_request: { execute: clockRequest },
  cancel: { execute: cancel, recognize: recognizeCancel }
} satisfies Record<
  Exclude<ReminderTurnPlan["kind"], "unsupported" | "main_only">,
  {
    readonly execute: ReminderCommandHandler;
    readonly recognize?: (request: string) => ReminderTurnPlan | undefined;
  }
>;

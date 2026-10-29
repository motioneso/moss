import type { MossModuleManifest } from "@moss/module-sdk";

import { TASKS_HEARTBEAT_FEATURE } from "./heartbeat-feature.js";

/** Feature declarations for the Tasks module, kept apart so the manifest stays small. */
export const tasksFeatures: NonNullable<MossModuleManifest["features"]> = [
  TASKS_HEARTBEAT_FEATURE,
  {
    id: "tasks.visual_summary",
    description:
      "Chat summarizes up to twelve owned/shared tasks with source time and coverage; no recurrence advance or reminders. Focus adds separate today context but keeps its ranking/reconciliation. Saved cards never refetch.",
    errors: [
      {
        code: "tasks_summary_unavailable",
        class: "transient",
        description:
          "An unavailable summary or visual retains readable text. Focus retains its items if supplemental context fails; its existing recurrence behavior still applies."
      }
    ],
    remediations: [
      {
        id: "tasks_summary_retry",
        description:
          "Ask for a fresh task summary or inspect Tasks. Change saved timezone in Profile when local days are incorrect.",
        path: "/tasks"
      }
    ]
  },
  {
    id: "tasks.quick_capture",
    description:
      "Add a task from its title with Enter or Add task, using the focused list when one list is selected. Repeated submissions while saving send once; text typed during a successful save stays in the field.",
    remediations: [
      {
        id: "tasks.quick_capture_retry",
        description:
          "Keep the title, correct the reported problem or choose an available list, then press Enter or Add task to retry.",
        path: "/tasks"
      }
    ],
    errors: [
      {
        code: "tasks.capture_failed",
        class: "transient",
        description:
          "A failed quick add keeps the title and explains the failure. Correct the cause, then press Enter or Add task to try again."
      }
    ]
  },
  {
    id: "tasks.list_metadata_refresh",
    description:
      "The first task can create Personal implicitly. Its list index and task row refresh without reloading, even if a later child write fails."
  },
  {
    id: "tasks.status_refresh",
    description:
      "Mounted rows follow refreshed server status. Late write success cannot replace a newer server state. Failed toggles retain the latest confirmed state; completing then reopening before refresh sends each chosen status."
  },
  {
    id: "tasks.saved_locale_dates",
    description:
      "When saved timezone arrives late, untouched due and reminder fields update without discarding other edits. Saving retains untouched timestamps; edited dates retain their selected day in the saved timezone."
  },
  {
    id: "tasks.details_write_guard",
    description:
      "Main task saves wait for comment, tag and subtask writes to finish. Those immediate writes cannot start during a main save. Failed immediate writes keep their input and the dialog open."
  },
  {
    id: "tasks.details_save_boundary",
    description:
      "Main fields save together. Comments, tags and subtasks on existing tasks save immediately. Discard retains already saved parts, including a partly created new task."
  },
  {
    id: "tasks.comment_focus",
    description:
      "Posting a comment by pointer or Enter keeps focus in task details when a control disables or disappears. Escape returns to the opener."
  },
  {
    id: "tasks.approval_effects",
    description:
      "Deleting a list keeps reassigned tasks but deletes its tags and assignments. Moving a task removes tags from other lists; a parent's subtasks follow it. Deleting a tag removes it from all tasks without deleting the tasks."
  },
  {
    id: "tasks.chat_app_actions",
    description:
      "App actions read individual tasks and activity, manage lists and tags, and split tasks. Scheduling, email-triage updates and auto-execution controls remain blocked; dedicated task tools stay separate."
  },
  {
    id: "tasks.lists_and_tags",
    description:
      "Organize tasks into lists and tags, and rename, reassign or delete them without losing tasks. Pick a list from the index or the phone picker; it stays across List and Grid. When nothing matches, Clear filters resets them.",
    errors: [
      {
        code: "tasks.load_failed",
        class: "transient",
        description:
          "Tasks could not load. With nothing loaded the page says so with Retry; after an earlier load it keeps those tasks on screen, says the refresh failed and offers Retry."
      },
      {
        code: "tasks.lists_load_failed",
        class: "transient",
        description:
          "Lists could not load. The list index, or the list picker on a phone, says so and offers Retry."
      },
      {
        code: "tasks.update_failed",
        class: "transient",
        description:
          "Completing, reopening, accepting or dismissing a task failed. The task returns to its previous state and a message asks you to try again."
      }
    ]
  },
  {
    id: "tasks.priority_matrix",
    description:
      "Grid ranks tasks into Do First, Schedule, Delegate and Later by importance and urgency, each a headed section with a count that stays visible when empty. A focus list shows overdue and at-risk tasks for today.",
    errors: [
      {
        code: "tasks.view_load_failed",
        class: "transient",
        description:
          "The saved List or Grid choice could not load, so List shows with a Retry beside the message."
      },
      {
        code: "tasks.view_save_failed",
        class: "transient",
        description:
          "Switching between List and Grid could not be saved. The previous view stays selected and a message says so; press List or Grid again."
      }
    ]
  },
  {
    id: "tasks.details_window",
    description:
      "Open task details from List or Grid. Close, Cancel, Escape and backdrop ask before discarding input; Keep editing preserves it. Dismissal waits for writes. Reads show loading or failure with Retry; refresh failure keeps fields."
  },
  {
    id: "tasks.details_save",
    description:
      "Save changes waits for the task to load. Failed saves retain edits; retry resumes partial creation without duplicating the parent or saved parts. Failed comment, tag and subtask writes explain the error and retain draft text.",
    errors: [
      {
        code: "tasks.details_save_failed",
        class: "transient",
        description:
          "The task save failed. The draft stays available; a partially created task and any completed child writes remain saved. Try Add task or Save changes again."
      }
    ],
    remediations: [
      {
        id: "tasks.details_save_retry",
        description:
          "Try Add task or Save changes again in the still-open dialog. A partial creation resumes its remaining parts without creating another parent.",
        path: "/tasks"
      }
    ]
  },
  {
    id: "tasks.breakdown",
    description: "Turn a big task into ordered subtasks, so one task becomes a list of next steps."
  },
  {
    id: "tasks.due_and_recurrence",
    description:
      "Set due dates, reminders, effort and repeats. Date inputs retain the chosen day in your saved timezone; repeats start from the chosen due day or today locally. Recurring tasks roll forward daily; incomplete ones show in the overdue list."
  },
  {
    id: "tasks.natural_language_search",
    description:
      "Describe what you are looking for in your own words; Tasks interprets it into a filtered " +
      "search of your tasks."
  }
];

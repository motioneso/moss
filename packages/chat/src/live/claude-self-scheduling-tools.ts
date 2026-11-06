/**
 * Claude CLI built-ins that start a later turn on their own (wakeups, cron jobs, remote
 * triggers, background monitors). The CLI runs them without consulting PreToolUse hooks or
 * the permission mode, so the only guard is switching them off at launch. A chat turn must
 * begin from a user message or Moss's own reminder system, never from the model.
 */
export const CLAUDE_SELF_SCHEDULING_TOOLS = [
  "ScheduleWakeup",
  "CronCreate",
  "CronDelete",
  "CronList",
  "RemoteTrigger",
  "Monitor"
] as const;

/** The launch flag that switches the tools above off. */
export const CLAUDE_SELF_SCHEDULING_DISALLOW_FLAG = `--disallowedTools ${CLAUDE_SELF_SCHEDULING_TOOLS.join(" ")}`;

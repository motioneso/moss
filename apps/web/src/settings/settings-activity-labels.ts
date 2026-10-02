import type { ActionAuditLogEntryDto } from "@moss/shared";

type Entry = Pick<
  ActionAuditLogEntryDto,
  "toolModuleId" | "toolName" | "outcome" | "sourceSurface"
>;

const MODULE_NAMES: Record<string, string> = {
  ai: "Assistant",
  "acp-builtin": "Assistant tools",
  calendar: "Calendar",
  tasks: "Tasks",
  food: "Food",
  memory: "Memory",
  scratchpad: "Scratchpad",
  settings: "Settings",
  web: "Web",
  workshop: "Workshop",
  email: "Email",
  news: "News",
  knowledge: "Knowledge",
  notifications: "Notifications",
  "integration-agentmail": "AgentMail"
};

/** Plain action sentences for the tools people actually see. Keyed by the full tool name. */
const ACTIONS: Record<string, string> = {
  "cli-tools.update": "Updated the assistant's command-line tools",
  "mcp.moss.calendar.listVisibleEvents": "Checked your calendar",
  "calendar.createEvent": "Added an event to your calendar",
  "workshop.runCommand": "Ran a command in the Workshop",
  "workshop.buildModule": "Built a module in the Workshop",
  "web.read": "Read a web page",
  "scratchpad.append": "Added to your scratchpad",
  "memory.remember": "Saved something to memory",
  "food.meals.log": "Logged a meal",
  "settings.themeMode.set": "Changed your colour theme",
  "tasks.create": "Created a task",
  "tasks.updateStatus": "Updated a task's status",
  "agentmail.list_inboxes": "Listed your inboxes",
  "home-assistant.GetLiveContext": "Checked the state of your home",
  "home-assistant.HassTurnOn": "Turned something on at home",
  "home-assistant.HassTurnOff": "Turned something off at home"
};

function titleCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function moduleLabel(toolModuleId: string): string {
  const known = MODULE_NAMES[toolModuleId];
  if (known) return known;
  if (toolModuleId.startsWith("integration-")) {
    return titleCase(toolModuleId.slice("integration-".length));
  }
  return titleCase(toolModuleId);
}

/** A short sentence for what the call did. Unknown tools fall back to the module name. */
export function actionLabel(entry: Entry): string {
  const known = ACTIONS[entry.toolName];
  if (known) return known;
  const module = moduleLabel(entry.toolModuleId);
  const parts = entry.toolName.split(".");
  const verb = parts[parts.length - 1] ?? "";
  if (/^(get|list|read|find|search)/i.test(verb)) return `Looked something up in ${module}`;
  if (/^(create|add|log|append|set|update|remember|write)/i.test(verb)) {
    return `Made a change in ${module}`;
  }
  return `Used ${module}`;
}

/** One plain line on whether the person needs to do anything. Null when nothing is worth saying. */
export function outcomeNote(outcome: ActionAuditLogEntryDto["outcome"]): string | null {
  switch (outcome) {
    case "failed":
      return "This did not work. Nothing needed from you unless you still want it done; ask again to retry.";
    case "refused":
      return "Held back because too many requests came in at once. Nothing for you to do; it will run again later.";
    case "denied":
      return "You or your settings said no, so it did not run. Nothing for you to do unless you change your mind.";
    case "invalid":
      return "The request was malformed, so it did not run. Nothing for you to do.";
    case "conflict":
      return "Something changed in the meantime, so it did not run. Ask again if you still want it.";
    default:
      return null;
  }
}

export function sourceLabel(source: Entry["sourceSurface"]): string {
  switch (source) {
    case "proactive":
      return "On its own";
    case "scheduled":
      return "Scheduled";
    case "unknown":
      return "Unknown source";
    default:
      return "Chat";
  }
}

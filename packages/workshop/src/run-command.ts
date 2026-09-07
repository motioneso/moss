import { HttpError } from "@moss/module-sdk";
import type { ToolExecute, ToolResult, ToolServices } from "@moss/module-sdk";

/**
 * workshop.runCommand (#2369 slice 1 phase 3): one shell command in the
 * session project folder.
 *
 * The folder is fixed on the runner side to that session's project folder —
 * the tool derives the project from its own session key and the runner
 * resolves the folder from the session key plus project, so the caller can
 * never choose a path. Output past 256 KiB keeps the head and says it was
 * cut; past the deadline the command is stopped and whatever ran so far
 * returns. Partial output streams through `ctx.reportProgress` while it runs.
 */

export const WORKSHOP_RUN_COMMAND_SERVICE_KEY = "workshopRunCommand";

/** Default deadline: five minutes. */
export const WORKSHOP_RUN_COMMAND_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
/** Upper bound for one deadline: ten minutes, matching the runner. */
export const WORKSHOP_RUN_COMMAND_MAX_TIMEOUT_MS = 10 * 60 * 1000;
/** Lower bound for one deadline: one second. */
export const WORKSHOP_RUN_COMMAND_MIN_TIMEOUT_MS = 1000;
/** How often to poll the runner for fresh output. */
const RUN_COMMAND_POLL_MS = 250;
/**
 * Grace past the deadline before the tool stops waiting on a silent runner.
 * The runner kills the command at the deadline itself; this only fires when
 * the runner never answers, so a hung runner cannot hang the tool with it.
 */
const RUN_COMMAND_GRACE_MS = 5_000;

export interface WorkshopRunCommandStart {
  readonly execId: number;
}

export interface WorkshopRunCommandState {
  readonly output: string;
  readonly done: boolean;
  readonly exitCode: number | null;
  readonly truncated: boolean;
  readonly timedOut: boolean;
}

/**
 * Runner access for the tool. The production backing calls the
 * acpExecStart/acpExecPoll/acpExecKill RPC verbs (wired with the Workshop
 * reply path); tests stub it.
 */
export interface WorkshopRunCommandService {
  start(input: {
    readonly sessionKey: string;
    readonly projectId: string;
    readonly command: string;
    readonly timeoutMs: number;
  }): Promise<WorkshopRunCommandStart>;
  poll(input: {
    readonly sessionKey: string;
    readonly execId: number;
  }): Promise<WorkshopRunCommandState>;
  kill(input: { readonly sessionKey: string; readonly execId: number }): Promise<void>;
}

function getRunService(services: ToolServices | undefined): WorkshopRunCommandService {
  const service = services?.[WORKSHOP_RUN_COMMAND_SERVICE_KEY] as
    | WorkshopRunCommandService
    | undefined;
  if (!service || typeof service.start !== "function" || typeof service.poll !== "function") {
    throw new HttpError(
      503,
      "Running project commands is not available on this surface. Open the project instead."
    );
  }
  return service;
}

/**
 * The project comes from the caller's own session key
 * (`workshop:<userId>:<projectId>`), never from the tool input — there is no
 * input field for it, so a caller cannot aim the command at another folder.
 */
function projectIdFromSession(chatSessionId: string): string {
  const parts = chatSessionId.split(":");
  const projectId = parts.length === 3 && parts[0] === "workshop" ? parts[2] : "";
  if (!projectId || !/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) {
    throw new HttpError(400, "This command runs only in a Workshop project session.");
  }
  return projectId;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run the command, stream partial output as progress, and return the finish. */
export const workshopRunCommandExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx,
  services
): Promise<ToolResult> => {
  void scopedDb;
  const raw = (input ?? {}) as { command?: unknown; timeoutMs?: unknown };
  if (
    typeof raw.command !== "string" ||
    raw.command.trim().length === 0 ||
    raw.command.includes("\0") ||
    raw.command.length > 32768
  ) {
    throw new HttpError(400, "command must be a non-empty string of at most 32768 characters.");
  }
  const timeoutMs =
    raw.timeoutMs === undefined ? WORKSHOP_RUN_COMMAND_DEFAULT_TIMEOUT_MS : raw.timeoutMs;
  if (
    !Number.isInteger(timeoutMs) ||
    (timeoutMs as number) < WORKSHOP_RUN_COMMAND_MIN_TIMEOUT_MS ||
    (timeoutMs as number) > WORKSHOP_RUN_COMMAND_MAX_TIMEOUT_MS
  ) {
    throw new HttpError(400, "timeoutMs must be between 1 second and 10 minutes.");
  }

  const service = getRunService(services);
  const sessionKey = ctx.chatSessionId;
  const projectId = projectIdFromSession(sessionKey);
  const { execId } = await service.start({
    sessionKey,
    projectId,
    command: raw.command,
    timeoutMs: timeoutMs as number
  });

  // The runner kills the command at the deadline; this backstop only fires
  // when the runner goes silent, so the tool still answers with what it saw.
  const stopWaitingAt = Date.now() + (timeoutMs as number) + RUN_COMMAND_GRACE_MS;
  let output = "";
  let done = false;
  let exitCode: number | null = null;
  let truncated = false;
  let timedOut = false;
  for (;;) {
    const state = await service.poll({ sessionKey, execId });
    if (state.output.length > output.length) {
      ctx.reportProgress?.({ message: state.output.slice(output.length) });
    }
    output = state.output;
    done = state.done;
    exitCode = state.exitCode;
    truncated = state.truncated;
    timedOut = state.timedOut;
    if (done) break;
    if (Date.now() >= stopWaitingAt) {
      timedOut = true;
      break;
    }
    await sleep(RUN_COMMAND_POLL_MS);
  }
  if (!done) {
    try {
      await service.kill({ sessionKey, execId });
    } catch {
      /* best effort: the runner is already silent, still answer with what ran */
    }
  }

  let text = output;
  if (truncated) text += "\n[The output was cut at 256 KiB; this is the start of it.]";
  if (timedOut) text += "\n[The command was stopped after the timeout; this is what ran so far.]";
  return { data: { output: text, exitCode, truncated, timedOut } };
};

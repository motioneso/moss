import type {
  IntegrationClassifierPreparationFailure,
  IntegrationClassifierToolSort,
  IntegrationClassifierToolState,
  IntegrationDetail
} from "@moss/shared";

import { alwaysAskCount, isToolOnIn } from "./integration-tool-groups";

/* What the connection page says about the classifier and about sorting (#2984 R2.5b). */

type ClassifierDetail = Pick<
  IntegrationDetail,
  | "enabled"
  | "lastError"
  | "classifierEnabled"
  | "tools"
  | "groups"
  | "enabledGroups"
  | "enabledTools"
  | "mutedTools"
  | "groupOptIn"
  | "classifierTools"
>;

/**
 * The classifier panel's state. The one-time confirm is page state layered over `off`.
 * `none` means the switch is on but no tool is left for the classifier to prepare.
 */
export type ClassifierBlockKind =
  | "off"
  | "preparing"
  | "ready"
  | "changed"
  | "failed"
  | "paused"
  | "none";

export interface ClassifierBlockState {
  readonly kind: ClassifierBlockKind;

  /**
   * Tools the classifier prepares: on for chat, not kept out, and not left out for a failed sort
   * or inputs it cannot fill. Every count below is out of this one.
   */
  readonly total: number;
  readonly ready: number;
  readonly preparingAgain: number;
  readonly failed: number;
  readonly failure: IntegrationClassifierPreparationFailure | null;

  /** Tools that are on and ask before they run. */
  readonly alwaysAsk: number;

  /** When the newest ready tool was prepared. */
  readonly preparedAt: string | null;
}

const PREPARED_STATES: ReadonlySet<IntegrationClassifierToolState> = new Set([
  "preparing",
  "preparing_again",
  "failed",
  "ready"
]);

/* Model trouble first, since the owner can fix it with one change. */
const FAILURE_ORDER: readonly IntegrationClassifierPreparationFailure[] = [
  "no_model",
  "provider_error",
  "invalid_draft",
  "too_many_tools",
  "unsafe",
  "definition_too_large",
  "unsupported_shape"
];

/** True when the tool would be prepared if the switch were on. */
function wouldPrepare(detail: ClassifierDetail, sort: IntegrationClassifierToolSort): boolean {
  const tool = detail.tools.find((entry) => entry.name === sort.toolName);
  if (!tool) return false;
  return isToolOnIn(detail, tool) && !sort.keptOut && sort.status !== "failed";
}

function count(detail: ClassifierDetail, state: IntegrationClassifierToolState): number {
  return detail.classifierTools.filter((tool) => tool.classifierState === state).length;
}

export function classifierBlockState(detail: ClassifierDetail): ClassifierBlockState {
  const alwaysAsk = alwaysAskCount(detail);
  const base = {
    ready: 0,
    preparingAgain: 0,
    failed: 0,
    failure: null,
    alwaysAsk,
    preparedAt: null
  };
  if (!detail.classifierEnabled) {
    const total = detail.classifierTools.filter((tool) => wouldPrepare(detail, tool)).length;
    return { ...base, kind: "off", total };
  }

  const ready = count(detail, "ready");
  const preparing = count(detail, "preparing");
  const preparingAgain = count(detail, "preparing_again");
  const failedTools = detail.classifierTools.filter((tool) => tool.classifierState === "failed");
  const total = detail.classifierTools.filter((tool) =>
    PREPARED_STATES.has(tool.classifierState)
  ).length;
  const reasons = new Set(failedTools.map((tool) => tool.preparationFailure));
  const failure = FAILURE_ORDER.find((reason) => reasons.has(reason)) ?? null;
  const preparedAt =
    detail.classifierTools
      .filter((tool) => tool.classifierState === "ready" && tool.preparedAt)
      .map((tool) => tool.preparedAt as string)
      .sort()
      .at(-1) ?? null;
  const counts = {
    total,
    ready,
    preparingAgain,
    failed: failedTools.length,
    failure,
    alwaysAsk,
    preparedAt
  };

  const kind: ClassifierBlockKind =
    !detail.enabled || detail.lastError
      ? "paused"
      : preparing > 0 || (preparingAgain > 0 && ready === 0)
        ? "preparing"
        : preparingAgain > 0
          ? "changed"
          : failedTools.length > 0
            ? "failed"
            : total === 0
              ? "none"
              : "ready";
  return { ...counts, kind };
}

/** True while the worker still owes a preparation the page should wait for. */
export function preparationPending(detail: IntegrationDetail | undefined): boolean {
  if (!detail?.classifierEnabled) return false;
  return detail.classifierTools.some(
    (tool) => tool.classifierState === "preparing" || tool.classifierState === "preparing_again"
  );
}

/** "1 tool" or "3 tools". */
export function toolCount(n: number): string {
  return `${n} ${n === 1 ? "tool" : "tools"}`;
}

/** Why some tools could not be prepared, in plain words. */
export function failureLine(state: ClassifierBlockState): string {
  const some = state.ready > 0;
  const missed = `${toolCount(state.failed)} ${state.failed === 1 ? "wasn't" : "weren't"} prepared`;
  const what = some ? missed : "nothing was prepared";
  const one = state.failed === 1;
  const they = one ? "takes" : "take";
  const their = one ? "its" : "their";
  const are = one ? "it is" : "they are";
  switch (state.failure) {
    case "no_model":
      return `You don't have a default chat model, so ${what}.`;
    case "invalid_draft":
      return `Your default chat model's answer couldn't be used, so ${what}.`;
    case "too_many_tools":
      return "This connection has too many tools to prepare at once.";
    case "unsafe":
      return `${capitalise(missed)}, because ${their} text held your saved sign-in details.`;
    case "definition_too_large":
      return `${capitalise(missed)}, because ${are} described at too much length.`;
    case "unsupported_shape":
      return `${capitalise(toolCount(state.failed))} ${they} inputs the classifier can't fill in.`;
    case "provider_error":
    case null:
      return `Your default chat model didn't answer, so ${what}.`;
  }
}

/** True when a different default chat model could fix the failure. */
export function failureNeedsModel(state: ClassifierBlockState): boolean {
  return (
    state.failure === null ||
    state.failure === "no_model" ||
    state.failure === "provider_error" ||
    state.failure === "invalid_draft"
  );
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface SortingLine {
  readonly text: string | null;

  /** Tools whose sort failed; the page offers Try again while any remain. */
  readonly failed: number;
}

/**
 * The Connection panel's line about sorting. `formatDay` renders an ISO time as a short date.
 */
export function sortingLine(
  detail: Pick<IntegrationDetail, "classifierTools">,
  formatDay: (iso: string) => string
): SortingLine {
  const failed = detail.classifierTools.filter((tool) => tool.status === "failed").length;
  const pending = detail.classifierTools.some(
    (tool) => tool.status === "never_tried" || tool.status === "stale"
  );
  if (pending) {
    return {
      text:
        "Moss is sorting these tools. Your default chat model reads each tool's name, " +
        "description and inputs, and so does its provider if the model is hosted.",
      failed
    };
  }
  const latest = detail.classifierTools
    .filter((tool) => tool.status === "current" && tool.sortedAt)
    .sort((a, b) => (a.sortedAt as string).localeCompare(b.sortedAt as string))
    .at(-1);
  if (!latest?.sortedAt) {
    return {
      text: failed > 0 ? `Moss couldn't sort ${toolCount(failed)} by what they do.` : null,
      failed
    };
  }
  const reader = latest.sortedBy?.model ?? "Your default chat model";
  const unsorted = failed > 0 ? ` ${capitalise(toolCount(failed))} couldn't be sorted.` : "";
  return {
    text:
      `Sorted by what they do on ${formatDay(latest.sortedAt)}. ${reader} read each tool's ` +
      `name, description and inputs, and so did its provider if the model is hosted.${unsorted}`,
    failed
  };
}

/** Turns the switch on or off the way the server will, before it answers. */
export function withClassifierEnabled(detail: IntegrationDetail, on: boolean): IntegrationDetail {
  return {
    ...detail,
    classifierEnabled: on,
    classifierTools: detail.classifierTools.map((tool) => {
      const classifierState: IntegrationClassifierToolState = !on
        ? "off"
        : tool.classifierState !== "off"
          ? tool.classifierState
          : tool.keptOut
            ? "kept_out"
            : wouldPrepare(detail, tool)
              ? "preparing"
              : "not_used";
      return { ...tool, classifierState };
    })
  };
}

/** Keeps the named tools out of the classifier, or lets them back in. */
export function withKeptOut(
  detail: IntegrationDetail,
  toolNames: readonly string[],
  keptOut: boolean
): IntegrationDetail {
  return {
    ...detail,
    classifierTools: detail.classifierTools.map((tool) => {
      if (!toolNames.includes(tool.toolName)) return tool;
      const classifierState: IntegrationClassifierToolState = keptOut
        ? "kept_out"
        : !detail.classifierEnabled
          ? "off"
          : wouldPrepare(detail, { ...tool, keptOut: false })
            ? "preparing"
            : "not_used";
      return { ...tool, keptOut, classifierState, preparationFailure: null, preparedAt: null };
    })
  };
}

/** Try again for preparation: failed tools wait for the worker once more. */
export function withPreparationRetried(detail: IntegrationDetail): IntegrationDetail {
  return {
    ...detail,
    classifierTools: detail.classifierTools.map((tool) =>
      tool.classifierState === "failed"
        ? { ...tool, classifierState: "preparing", preparationFailure: null }
        : tool
    )
  };
}

/** Try again for sorting: failed sorts wait for the worker once more. */
export function withSortRetried(detail: IntegrationDetail): IntegrationDetail {
  return {
    ...detail,
    classifierTools: detail.classifierTools.map((tool) =>
      tool.status === "failed" ? { ...tool, status: "never_tried", failure: null } : tool
    )
  };
}

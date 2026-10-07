// @vitest-environment jsdom
// Connection page classifier panel and sorting line (#2984 R2.5b): the seven panel states, the
// one-time confirm, the failure lines, the sorting line, and the page's own updates before the
// server answers.
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  IntegrationClassifierRisk,
  IntegrationClassifierToolSort,
  IntegrationDetail
} from "@moss/shared";

import type * as LocaleFormat from "../../apps/web/src/locale/locale-format.js";

const navigate = vi.hoisted(() => vi.fn());

vi.mock("react-router", () => ({ useNavigate: () => navigate }));

vi.mock("../../apps/web/src/locale/locale-format.js", async (importOriginal) => {
  const actual = await importOriginal<typeof LocaleFormat>();
  return { ...actual, useUserLocale: () => actual.DEFAULT_LOCALE };
});

import {
  DEFAULT_MODEL_PATH,
  IntegrationClassifierBlock,
  IntegrationSortingLine
} from "../../apps/web/src/settings/integration-classifier-block.js";
import {
  classifierBlockState,
  failureLine,
  failureNeedsModel,
  sortingLine,
  withClassifierEnabled,
  withKeptOut,
  withPreparationRetried,
  withSortRetried
} from "../../apps/web/src/settings/integration-classifier-state.js";

function sorted(
  toolName: string,
  risk: IntegrationClassifierRisk,
  extra: Partial<IntegrationClassifierToolSort> = {}
): IntegrationClassifierToolSort {
  return {
    toolName,
    status: "current",
    risk,
    failure: null,
    sendWithoutAsking: false,
    asksFirst: risk === "outbound" || risk === "destructive",
    readableName: toolName,
    sortedAt: "2026-10-02T09:00:00.000Z",
    sortedBy: null,
    sortMethod: null,
    failedAt: null,
    keptOut: false,
    classifierState: "off",
    preparationFailure: null,
    preparedAt: null,
    ...extra
  };
}

const NAMES = ["GetState", "SetLight", "Notify", "Unlock"] as const;
const RISKS: Record<(typeof NAMES)[number], IntegrationClassifierRisk> = {
  GetState: "read",
  SetLight: "write",
  Notify: "outbound",
  Unlock: "destructive"
};

/** Four tools, every one in `state` unless `states` says otherwise. */
function detail(
  overrides: Partial<IntegrationDetail> = {},
  state: IntegrationClassifierToolSort["classifierState"] = "off",
  states: Partial<Record<(typeof NAMES)[number], Partial<IntegrationClassifierToolSort>>> = {}
): IntegrationDetail {
  return {
    id: "conn-1",
    name: "Home Assistant",
    kind: "mcp",
    url: "http://homeassistant.local:8123",
    enabled: true,
    hasCredential: false,
    toolCount: 4,
    enabledToolCount: 4,
    lastDiscoveryAt: null,
    lastError: null,
    credentialPlacement: null,
    tools: NAMES.map((name) => ({
      name,
      description: `${name} does a thing`,
      group: "",
      inputSchema: null
    })),
    groups: [],
    enabledGroups: [],
    enabledTools: [],
    mutedTools: [],
    unsuppressedTools: [],
    groupOptIn: false,
    specPasted: false,
    classifierEnabled: state !== "off",
    classifierTools: NAMES.map((name) =>
      sorted(name, RISKS[name], {
        classifierState: state,
        preparedAt: state === "ready" ? "2026-10-02T10:00:00.000Z" : null,
        ...states[name]
      })
    ),
    ...overrides
  };
}

let renderer: ReactTestRenderer | undefined;
const onSetEnabled = vi.fn();
const onRetry = vi.fn();

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  onSetEnabled.mockReset();
  onRetry.mockReset();
  navigate.mockReset();
});

function render(value: IntegrationDetail): void {
  act(() => {
    renderer = create(
      createElement(IntegrationClassifierBlock, { detail: value, onSetEnabled, onRetry })
    );
  });
}

function flatten(children: unknown): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(flatten).join("");
  if (children && typeof children === "object" && "children" in children) {
    return flatten((children as { children: unknown }).children);
  }
  return "";
}

/** The rendered words, with element boundaries dropped. */
function words(): string {
  return flatten(renderer!.toJSON()).replace(/\s+/g, " ");
}

function click(label: string): void {
  const button = renderer!.root
    .findAllByType("button")
    .find((node) => flatten(node.props.children) === label);
  if (!button) throw new Error(`no button "${label}"`);
  act(() => button.props.onClick());
}

function switchInput() {
  return renderer!.root.find(
    (node) =>
      node.type === "input" && node.props["aria-label"] === "Let the classifier use this connection"
  );
}

describe("classifierBlockState", () => {
  it("is off and counts the tools the classifier would prepare", () => {
    const state = classifierBlockState(
      detail({ mutedTools: ["SetLight"] }, "off", {
        Notify: { keptOut: true },
        Unlock: { status: "failed", risk: null }
      })
    );
    expect(state).toMatchObject({ kind: "off", total: 1 });
  });

  it("is preparing while any tool waits for its first preparation", () => {
    const state = classifierBlockState(
      detail({}, "ready", { Notify: { classifierState: "preparing" } })
    );
    expect(state).toMatchObject({ kind: "preparing", ready: 2, total: 3 });
  });

  it("is ready with the always-ask count and the newest preparation date", () => {
    const state = classifierBlockState(
      detail({}, "ready", { Notify: { preparedAt: "2026-10-03T08:00:00.000Z" } })
    );
    expect(state).toMatchObject({
      kind: "ready",
      ready: 3,
      total: 3,
      alwaysAsk: 2,
      preparedAt: "2026-10-03T08:00:00.000Z"
    });
  });

  it("leaves kept-out and unused tools out of the count", () => {
    const state = classifierBlockState(
      detail({}, "ready", {
        Notify: { classifierState: "kept_out", keptOut: true },
        Unlock: { classifierState: "not_used" }
      })
    );
    expect(state).toMatchObject({ kind: "ready", ready: 1, total: 1 });
  });

  it("leaves read look-up tools out of the answering count — #3038 regression", () => {
    // GetState is a read (look-up) tool: prepared like the rest, but the gate never offers
    // it, so the panel must not count it as answering quick requests.
    const state = classifierBlockState(detail({}, "ready"));
    expect(state).toMatchObject({ kind: "ready", ready: 3, total: 3 });
  });

  it("says no tool is left when only read tools are on — #3038 regression", () => {
    const state = classifierBlockState(
      detail({}, "ready", {
        SetLight: { classifierState: "not_used" },
        Notify: { classifierState: "not_used" },
        Unlock: { classifierState: "not_used" }
      })
    );
    expect(state).toMatchObject({ kind: "none", ready: 0, total: 0 });
  });

  it("ignores a read tool that is still preparing — #3062 review", () => {
    const state = classifierBlockState(
      detail({}, "ready", { GetState: { classifierState: "preparing" } })
    );
    expect(state).toMatchObject({ kind: "ready", ready: 3, total: 3 });
  });

  it("ignores a read tool that is preparing again — #3062 review", () => {
    const state = classifierBlockState(
      detail({}, "ready", { GetState: { classifierState: "preparing_again" } })
    );
    expect(state).toMatchObject({ kind: "ready", ready: 3, total: 3, preparingAgain: 0 });
  });

  it("ignores a read tool whose preparation failed — #3062 review", () => {
    const state = classifierBlockState(
      detail({}, "ready", {
        GetState: { classifierState: "failed", preparationFailure: "provider_error" }
      })
    );
    expect(state).toMatchObject({ kind: "ready", ready: 3, total: 3, failed: 0, failure: null });
  });

  it("says a tool changed when ready tools wait only on preparing again", () => {
    const state = classifierBlockState(
      detail({}, "ready", { SetLight: { classifierState: "preparing_again" } })
    );
    expect(state).toMatchObject({ kind: "changed", ready: 2, preparingAgain: 1, total: 3 });
  });

  it("couldn't prepare once nothing is still preparing, naming model trouble first", () => {
    const state = classifierBlockState(
      detail({}, "ready", {
        Notify: { classifierState: "failed", preparationFailure: "unsafe" },
        Unlock: { classifierState: "failed", preparationFailure: "provider_error" }
      })
    );
    expect(state).toMatchObject({ kind: "failed", ready: 1, failed: 2, failure: "provider_error" });
  });

  it("is paused when the connection is off or can't be reached", () => {
    expect(classifierBlockState(detail({ lastError: "refused" }, "ready")).kind).toBe("paused");
    expect(classifierBlockState(detail({ enabled: false }, "ready")).kind).toBe("paused");
  });

  it("says no tool is left when every tool is kept out", () => {
    expect(classifierBlockState(detail({}, "kept_out")).kind).toBe("none");
  });
});

describe("failureLine", () => {
  const failed = (failure: IntegrationClassifierToolSort["preparationFailure"], ready = 0) =>
    classifierBlockState(
      detail({}, ready > 0 ? "ready" : "failed", {
        Notify: { classifierState: "failed", preparationFailure: failure },
        Unlock: { classifierState: "failed", preparationFailure: failure },
        ...(ready > 0
          ? {}
          : {
              GetState: { preparationFailure: failure },
              SetLight: { preparationFailure: failure }
            })
      })
    );

  it("says the model didn't answer, for all or for some tools", () => {
    expect(failureLine(failed("provider_error"))).toBe(
      "Your default chat model didn't answer, so nothing was prepared."
    );
    expect(failureLine(failed("provider_error", 2))).toBe(
      "Your default chat model didn't answer, so 2 tools weren't prepared."
    );
  });

  it("says there is no default chat model, and offers to change it", () => {
    expect(failureLine(failed("no_model"))).toBe(
      "You don't have a default chat model, so nothing was prepared."
    );
    expect(failureNeedsModel(failed("no_model"))).toBe(true);
  });

  it("gives a short honest line for reasons a new model would not fix", () => {
    expect(failureLine(failed("unsafe", 2))).toBe(
      "2 tools weren't prepared, because their text held your saved sign-in details."
    );
    expect(failureLine(failed("too_many_tools"))).toBe(
      "This connection has too many tools to prepare at once."
    );
    expect(failureNeedsModel(failed("unsafe", 2))).toBe(false);
  });
});

describe("IntegrationClassifierBlock", () => {
  it("1. off: says quick requests use the default model and how many tools it prepares", () => {
    render(detail());
    expect(switchInput().props.checked).toBe(false);
    expect(words()).toContain(
      "Off. Quick requests to Home Assistant go through your default model."
    );
    expect(words()).toContain("Turning it on prepares all 4 tools once.");
    expect(words()).not.toContain("What is sent, and what it costs");
  });

  it("2. confirm: switching on shows what is sent before anything is sent", () => {
    render(detail());
    act(() => switchInput().props.onChange({ target: { checked: true } }));
    expect(onSetEnabled).not.toHaveBeenCalled();
    expect(words()).toContain("Prepare 4 tools for the classifier?");
    for (const label of ["What is sent.", "Who reads it.", "What it costs.", "Not sent."]) {
      expect(words()).toContain(label);
    }
    click("Cancel");
    expect(onSetEnabled).not.toHaveBeenCalled();
    expect(words()).not.toContain("Prepare 4 tools");

    act(() => switchInput().props.onChange({ target: { checked: true } }));
    click("Turn on and prepare");
    expect(onSetEnabled).toHaveBeenCalledWith(true);
  });

  it("3. preparing: shows progress and that the page can be left", () => {
    render(detail({}, "ready", { Notify: { classifierState: "preparing" } }));
    expect(words()).toContain("Preparing");
    expect(words()).toContain("2 of 3 tools");
    const bar = renderer!.root.find((node) => node.props.role === "progressbar");
    expect(bar.props["aria-valuenow"]).toBe(2);
    expect(words()).toContain("You can leave this page.");
  });

  it("4. ready: counts, the always-ask line, YOLO and the preparation date", () => {
    render(detail({}, "ready"));
    expect(words()).toContain("Ready");
    expect(words()).toContain(
      "3 of 3 tools can answer quick requests. 2 always ask you before they run."
    );
    expect(words()).toContain("YOLO mode skips the asking.");
    expect(words()).toMatch(/Prepared on (2 October|October 2) by your default chat model\./);
    expect(words()).toContain("What is sent, and what it costs");
  });

  it("5. a tool changed: says it is being prepared again", () => {
    render(detail({}, "ready", { SetLight: { classifierState: "preparing_again" } }));
    expect(words()).toContain("1 tool changed and is being prepared again.");
    expect(words()).not.toContain("Prepared on");
  });

  it("6. couldn't prepare: the reason, Try again and Change default model", () => {
    render(
      detail({}, "failed", {
        GetState: { preparationFailure: "provider_error" },
        SetLight: { preparationFailure: "provider_error" },
        Notify: { preparationFailure: "provider_error" },
        Unlock: { preparationFailure: "provider_error" }
      })
    );
    expect(words()).toContain("Couldn't prepare");
    expect(words()).toContain(
      "Your default chat model didn't answer, so nothing was prepared. Quick requests go through your default model meanwhile."
    );
    click("Try again");
    expect(onRetry).toHaveBeenCalledTimes(1);
    click("Change default model");
    expect(navigate).toHaveBeenCalledWith(DEFAULT_MODEL_PATH);
  });

  it("7. connection lost: paused, and picks up again by itself", () => {
    render(detail({ lastError: "Connection refused" }, "ready"));
    expect(words()).toContain("Paused");
    expect(words()).toContain("Home Assistant can't be reached, so the classifier skips it.");
  });

  it("turns off at once, and shows the notice on request while on", () => {
    render(detail({}, "ready"));
    click("What is sent, and what it costs");
    expect(words()).toContain("Who reads it.");
    act(() => switchInput().props.onChange({ target: { checked: false } }));
    expect(onSetEnabled).toHaveBeenCalledWith(false);
  });
});

describe("sortingLine", () => {
  const day = (iso: string) => iso.slice(0, 10);

  const byModel = (model: string | null, sortedAt = "2026-10-02T09:00:00.000Z") => ({
    sortMethod: "model" as const,
    sortedAt,
    sortedBy: model ? { model, provider: "Anthropic" } : null
  });
  const allByModel = (model: string | null) =>
    Object.fromEntries(NAMES.map((name) => [name, byModel(model)]));

  it("says what is sent while any sort is pending, and what is not", () => {
    const line = sortingLine(detail({}, "off", { Notify: { status: "never_tried" } }), day);
    expect(line.text).toBe(
      "Moss is sorting 1 tool. It sends its name, description and inputs to your default chat " +
        "model, and to its provider if the model is hosted. A tool that is very long, or holds " +
        "your sign-in details, is not sent."
    );
  });

  it("names the one model that read every tool, and the newest date", () => {
    const line = sortingLine(
      detail({}, "off", {
        ...allByModel("Claude Sonnet"),
        Notify: byModel("Claude Sonnet", "2026-10-03T08:00:00.000Z")
      }),
      day
    );
    expect(line).toEqual({
      text:
        "Sorted by what they do on 2026-10-03. Claude Sonnet read each tool's name, description " +
        "and inputs, and so did its provider if the model is hosted.",
      failed: 0
    });
  });

  it("names every model when tools were sorted by different models", () => {
    const line = sortingLine(
      detail({}, "off", {
        ...allByModel("Claude Sonnet"),
        Unlock: byModel("House model"),
        Notify: byModel(null)
      }),
      day
    );
    expect(line.text).toBe(
      "Sorted by what they do on 2026-10-02. Claude Sonnet, House model and your default chat " +
        "model at the time read the name, description and inputs of these tools between them, " +
        "and so did their providers if the models are hosted."
    );
  });

  it("counts the tools Moss sorted itself and claims no model read them", () => {
    const line = sortingLine(
      detail({}, "off", {
        ...allByModel("Claude Sonnet"),
        Unlock: { sortMethod: "local" },
        Notify: { sortMethod: "local" }
      }),
      day
    );
    expect(line.text).toBe(
      "Sorted by what they do on 2026-10-02. Claude Sonnet read the name, description and " +
        "inputs of 2 tools, and so did its provider if the model is hosted. Moss sorted 2 tools " +
        "itself, without sending their details to a model."
    );
  });

  it("gives only the date for sorts with no record of how they were made", () => {
    const line = sortingLine(detail({}, "off"), day);
    expect(line).toEqual({ text: "Sorted by what they do on 2026-10-02.", failed: 0 });
  });

  it("says which sorts have no record when the history is mixed, and counts failures", () => {
    const line = sortingLine(
      detail({}, "off", {
        GetState: byModel(null),
        SetLight: byModel(null),
        Unlock: { status: "failed", risk: null, sortedAt: null }
      }),
      day
    );
    expect(line.text).toBe(
      "Sorted by what they do on 2026-10-02. Your default chat model at the time read the name, " +
        "description and inputs of 2 tools, and so did its provider if the model is hosted. Moss " +
        "has no record of how 1 tool was sorted. 1 tool couldn't be sorted."
    );
    expect(line.failed).toBe(1);
  });

  it("renders Try again only when a sort failed", () => {
    const value = detail({}, "off", { Unlock: { status: "failed", risk: null, sortedAt: null } });
    act(() => {
      renderer = create(createElement(IntegrationSortingLine, { detail: value, onRetry }));
    });
    click("Try again");
    expect(onRetry).toHaveBeenCalledTimes(1);
    act(() =>
      renderer!.update(createElement(IntegrationSortingLine, { detail: detail(), onRetry }))
    );
    expect(renderer!.root.findAllByType("button")).toHaveLength(0);
  });
});

describe("the page's own updates before the server answers", () => {
  it("switching on starts preparing the tools the classifier would use", () => {
    const next = withClassifierEnabled(
      detail({ mutedTools: ["SetLight"] }, "off", { Notify: { keptOut: true } }),
      true
    );
    expect(next.classifierEnabled).toBe(true);
    expect(next.classifierTools.map((tool) => tool.classifierState)).toEqual([
      "preparing",
      "not_used",
      "kept_out",
      "preparing"
    ]);
    expect(
      withClassifierEnabled(next, false).classifierTools.every((t) => t.classifierState === "off")
    ).toBe(true);
  });

  it("keeping out and letting back in move only the named tools", () => {
    const out = withKeptOut(detail({}, "ready"), ["Notify"], true);
    expect(out.classifierTools[2]).toMatchObject({ keptOut: true, classifierState: "kept_out" });
    expect(out.classifierTools[0]).toMatchObject({ classifierState: "ready" });
    const back = withKeptOut(out, ["Notify"], false);
    expect(back.classifierTools[2]).toMatchObject({ keptOut: false, classifierState: "preparing" });
    expect(withKeptOut(detail(), ["Notify"], false).classifierTools[2]?.classifierState).toBe(
      "off"
    );
  });

  it("Try again sends failed tools back to waiting", () => {
    const failed = detail({}, "failed", { GetState: { status: "failed", risk: null } });
    expect(
      withPreparationRetried(failed).classifierTools.every((t) => t.classifierState === "preparing")
    ).toBe(true);
    expect(withSortRetried(failed).classifierTools[0]?.status).toBe("never_tried");
  });

  it("Try again from a missing model also sends the failed sorts back to waiting", () => {
    const failed = detail({}, "failed", {
      GetState: {
        status: "failed",
        risk: null,
        failure: "no_model",
        preparationFailure: "no_model"
      }
    });
    expect(withPreparationRetried(failed).classifierTools[0]).toMatchObject({
      status: "never_tried",
      failure: null,
      classifierState: "preparing",
      preparationFailure: null
    });
  });

  it("counts a tool whose sort failed for want of a model among those the classifier would prepare", () => {
    const state = classifierBlockState(
      detail({}, "off", {
        Notify: { status: "failed", risk: null, failure: "no_model" },
        Unlock: { status: "failed", risk: null, failure: "error" }
      })
    );
    expect(state).toMatchObject({ kind: "off", total: 3 });
  });
});

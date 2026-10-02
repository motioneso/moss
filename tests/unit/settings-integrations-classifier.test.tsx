// @vitest-environment jsdom
// Classifier gate 2b.4 (#2899): the connection-detail reviewed-switches section. These tests render
// the real component against mocked API calls and assert the consent contract: the connection switch
// never opts a tool in, drafts look different from saved reviews, Approve saves only reviewed rows,
// Discard and a stale 409 write nothing, and every section state matches the agreed mockup.
import { createElement, type ReactElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  INTEGRATION_CLASSIFIER_PREPARATION_DISCLOSURE,
  type IntegrationClassifierToolPreparation,
  type IntegrationDetail,
  type IntegrationToolDescriptor
} from "@moss/shared";

const h = vi.hoisted(() => ({
  prepare: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  toast: vi.fn(),
  confirm: vi.fn()
}));

vi.mock("../../apps/web/src/api/client.js", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string
    ) {
      super(message);
    }
  },
  prepareIntegrationClassifierTools: h.prepare,
  saveIntegrationClassifierTool: h.save,
  removeIntegrationClassifierTool: h.remove,
  updateIntegration: h.update
}));

vi.mock("../../apps/web/src/settings/settings-feedback.js", () => ({
  useFeedback: () => ({ toast: h.toast, confirm: h.confirm })
}));

import {
  IntegrationClassifierSection,
  classifierEligibility,
  classifierSectionState,
  draftFailureReason,
  ordinaryEnabledToolNames,
  type ClassifierSectionState
} from "../../apps/web/src/settings/settings-integrations-classifier.js";

const DISCLOSURE = INTEGRATION_CLASSIFIER_PREPARATION_DISCLOSURE;

function tool(overrides: Partial<IntegrationToolDescriptor> = {}): IntegrationToolDescriptor {
  return {
    name: "ToolA",
    description: "Turn a light on",
    group: "",
    inputSchema: null,
    ...overrides
  };
}

function savedEntry(
  overrides: Partial<IntegrationClassifierToolPreparation> = {}
): IntegrationClassifierToolPreparation {
  return {
    toolName: "ToolA",
    optIn: true,
    reviewedRisk: "read",
    description: "Turn one light on.",
    arguments: {},
    replyTemplate: "Turned the light on.",
    definitionFingerprint: "fp-A",
    reviewedAt: "2026-10-01T00:00:00.000Z",
    state: "current",
    preparationVersion: 1,
    ...overrides
  };
}

function baseDetail(overrides: Partial<IntegrationDetail> = {}): IntegrationDetail {
  return {
    id: "conn-1",
    name: "Home hub",
    kind: "mcp",
    url: "http://home.local:8123",
    enabled: true,
    hasCredential: false,
    toolCount: 1,
    enabledToolCount: 1,
    lastDiscoveryAt: null,
    lastError: null,
    credentialPlacement: null,
    tools: [tool()],
    groups: [],
    enabledGroups: [],
    enabledTools: [],
    mutedTools: [],
    unsuppressedTools: [],
    groupOptIn: false,
    specPasted: false,
    classifierEnabled: false,
    classifierPreparation: [],
    ...overrides
  };
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    toolName: "ToolA",
    definitionFingerprint: "fp-A",
    description: "Turn one light on.",
    arguments: {},
    replyTemplate: "Turned the light on.",
    ...overrides
  };
}

function approvedPrepare(drafts: unknown[], extra: Record<string, unknown> = {}) {
  return {
    disclosure: DISCLOSURE,
    status: "ok",
    drafts,
    reused: [],
    failed: [],
    remaining: 0,
    ...extra
  };
}

let renderer: ReactTestRenderer | null = null;
const clients: QueryClient[] = [];

function wrap(detail: IntegrationDetail, onChanged: () => void = () => {}): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return createElement(
    QueryClientProvider,
    { client },
    createElement(IntegrationClassifierSection, { detail, onChanged })
  );
}

async function render(detail: IntegrationDetail): Promise<ReactTestRenderer> {
  await act(async () => {
    renderer = create(wrap(detail));
  });
  return renderer!;
}

async function rerender(detail: IntegrationDetail): Promise<void> {
  await act(async () => {
    renderer!.update(wrap(detail));
  });
}

function text(): string {
  return JSON.stringify(renderer!.toJSON());
}

function flatten(children: unknown): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(flatten).join("");
  return "";
}

function hostButton(label: string) {
  const button = renderer!.root
    .findAllByType("button")
    .find((node) => flatten(node.props.children) === label);
  if (!button) throw new Error(`button "${label}" not found`);
  return button;
}

function switchByLabel(label: string) {
  const input = renderer!.root
    .findAllByType("input")
    .find((node) => node.props["aria-label"] === label);
  if (!input) throw new Error(`switch "${label}" not found`);
  return input;
}

function selectByLabel(label: string) {
  const select = renderer!.root
    .findAllByType("select")
    .find((node) => node.props["aria-label"] === label);
  if (!select) throw new Error(`select "${label}" not found`);
  return select;
}

function inputByLabel(label: string) {
  const input = renderer!.root
    .findAllByType("input")
    .find((node) => node.props["aria-label"] === label);
  if (!input) throw new Error(`input "${label}" not found`);
  return input;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("classifierSectionState (record-derived, fixed priority)", () => {
  const cases: readonly [ClassifierSectionState, Record<string, unknown>][] = [
    [
      "disconnected",
      {
        enabled: false,
        toolCount: 1,
        preparing: false,
        prepareStatus: null,
        prepareFailed: false,
        draftCount: 0,
        saved: []
      }
    ],
    [
      "no-tools",
      {
        enabled: true,
        toolCount: 0,
        preparing: false,
        prepareStatus: null,
        prepareFailed: false,
        draftCount: 0,
        saved: []
      }
    ],
    [
      "preparing",
      {
        enabled: true,
        toolCount: 1,
        preparing: true,
        prepareStatus: null,
        prepareFailed: false,
        draftCount: 0,
        saved: []
      }
    ],
    [
      "failed",
      {
        enabled: true,
        toolCount: 1,
        preparing: false,
        prepareStatus: "unavailable",
        prepareFailed: false,
        draftCount: 0,
        saved: []
      }
    ],
    [
      "failed",
      {
        enabled: true,
        toolCount: 1,
        preparing: false,
        prepareStatus: null,
        prepareFailed: true,
        draftCount: 0,
        saved: []
      }
    ],
    [
      "review",
      {
        enabled: true,
        toolCount: 1,
        preparing: false,
        prepareStatus: null,
        prepareFailed: false,
        draftCount: 2,
        saved: [savedEntry({ state: "stale" })]
      }
    ],
    [
      "stale",
      {
        enabled: true,
        toolCount: 1,
        preparing: false,
        prepareStatus: null,
        prepareFailed: false,
        draftCount: 0,
        saved: [savedEntry({ state: "stale" })]
      }
    ],
    [
      "approved",
      {
        enabled: true,
        toolCount: 1,
        preparing: false,
        prepareStatus: null,
        prepareFailed: false,
        draftCount: 0,
        saved: [savedEntry()]
      }
    ],
    [
      "not-prepared",
      {
        enabled: true,
        toolCount: 1,
        preparing: false,
        prepareStatus: null,
        prepareFailed: false,
        draftCount: 0,
        saved: []
      }
    ]
  ];

  for (const [expected, input] of cases) {
    it(`returns ${expected}`, () => {
      expect(classifierSectionState(input as never)).toBe(expected);
    });
  }

  it("drafts beat a stale saved review, and stale beats approved", () => {
    expect(
      classifierSectionState({
        enabled: true,
        toolCount: 1,
        preparing: false,
        prepareStatus: null,
        prepareFailed: false,
        draftCount: 1,
        saved: [savedEntry({ state: "stale" })]
      })
    ).toBe("review");
  });
});

describe("ordinaryEnabledToolNames and classifierEligibility", () => {
  it("keeps muted tools out and the flat list otherwise on", () => {
    const detail = baseDetail({
      tools: [tool({ name: "A" }), tool({ name: "B" })],
      mutedTools: ["B"]
    });
    expect([...ordinaryEnabledToolNames(detail)]).toEqual(["A"]);
  });

  it("honours groups and explicit names when grouping is on", () => {
    const detail = baseDetail({
      groupOptIn: true,
      tools: [
        tool({ name: "A", group: "Lights" }),
        tool({ name: "B", group: "Locks" }),
        tool({ name: "C", group: "Locks" })
      ],
      enabledGroups: ["Lights"],
      enabledTools: ["C"]
    });
    expect([...ordinaryEnabledToolNames(detail)].sort()).toEqual(["A", "C"]);
  });

  it("names every reason a tool is out", () => {
    const detail = baseDetail({ mutedTools: ["ToolA"] });
    const ordinary = ordinaryEnabledToolNames(detail);
    expect(classifierEligibility(tool(), undefined, ordinary).reasons).toEqual([
      "Off for ordinary chat, so the classifier cannot use it.",
      "Not reviewed yet."
    ]);
    expect(
      classifierEligibility(tool(), savedEntry({ reviewedRisk: null }), ordinary).reasons
    ).toEqual(["Off for ordinary chat, so the classifier cannot use it.", "Risk not chosen."]);
    expect(classifierEligibility(tool(), savedEntry({ state: "stale" }), ordinary).reasons).toEqual(
      [
        "Off for ordinary chat, so the classifier cannot use it.",
        "The connection changed this tool since it was reviewed."
      ]
    );
    const unlocked = baseDetail();
    expect(
      classifierEligibility(
        tool(),
        savedEntry({ optIn: false }),
        ordinaryEnabledToolNames(unlocked)
      ).reasons
    ).toEqual(["Not allowed for the classifier yet."]);
    expect(
      classifierEligibility(tool(), savedEntry(), ordinaryEnabledToolNames(unlocked)).eligible
    ).toBe(true);
  });

  it("maps draft failures to plain words", () => {
    expect(draftFailureReason("definition_too_large")).toContain("too large");
    expect(draftFailureReason("aborted")).toContain("cancelled");
  });
});

describe("IntegrationClassifierSection", () => {
  beforeEach(() => {
    h.prepare.mockReset();
    h.save.mockReset();
    h.remove.mockReset();
    h.update.mockReset();
    h.toast.mockReset();
    h.confirm.mockReset();
    h.save.mockResolvedValue({});
    h.remove.mockResolvedValue({});
    h.update.mockResolvedValue({});
  });

  it("shows the agreed not-prepared state and its disclosure before any model request", async () => {
    await render(baseDetail());
    expect(text()).toContain("Not prepared");
    expect(text()).toContain("Prepare 1 tool");
    expect(text()).toContain("Messages and device names go to the classifier provider.");
    expect(text()).toContain("What is sent, and what it costs");
    expect(text()).toContain("uses model usage");
  });

  it("the connection switch only marks the connection eligible; it never opts a tool in", async () => {
    await render(baseDetail());
    await act(async () => {
      switchByLabel("Let the classifier use this connection").props.onChange({
        target: { checked: true }
      });
    });
    await flush();
    expect(h.update).toHaveBeenCalledWith("conn-1", { classifierEnabled: true });
    expect(h.save).not.toHaveBeenCalled();
  });

  it("prepare, review and approve save only switched-on reviewed rows with their draft fingerprint", async () => {
    h.prepare.mockResolvedValue(
      approvedPrepare([
        draft({ toolName: "A", definitionFingerprint: "fp-A" }),
        draft({ toolName: "B", definitionFingerprint: "fp-B" })
      ])
    );
    await render(baseDetail({ tools: [tool({ name: "A" }), tool({ name: "B" })] }));

    await act(async () => {
      hostButton("Prepare 2 tools").props.onClick();
    });
    await flush();

    expect(text()).toContain("Review required");
    expect(text()).toContain("Draft");
    expect(inputByLabel("Description the classifier sees for A")).toBeTruthy();
    expect(hostButton("Approve reviewed tools").props.disabled).toBe(true);

    await act(async () => {
      selectByLabel("Risk for A").props.onChange({ target: { value: "read" } });
      selectByLabel("Risk for B").props.onChange({ target: { value: "write" } });
      switchByLabel("Classifier may use A").props.onChange({ target: { checked: true } });
    });
    await flush();
    expect(hostButton("Approve reviewed tools").props.disabled).toBe(false);

    await act(async () => {
      hostButton("Approve reviewed tools").props.onClick();
    });
    await flush();

    expect(h.save).toHaveBeenCalledTimes(2);
    expect(h.save).toHaveBeenCalledWith("conn-1", "A", {
      optIn: true,
      reviewedRisk: "read",
      description: "Turn one light on.",
      arguments: {},
      replyTemplate: "Turned the light on.",
      reviewedFingerprint: "fp-A"
    });
    expect(h.save).toHaveBeenCalledWith(
      "conn-1",
      "B",
      expect.objectContaining({ optIn: false, reviewedRisk: "write" })
    );
  });

  it("discarding a draft stores nothing", async () => {
    h.prepare.mockResolvedValue(approvedPrepare([draft()]));
    await render(baseDetail());
    await act(async () => {
      hostButton("Prepare 1 tool").props.onClick();
    });
    await flush();
    await act(async () => {
      hostButton("Discard draft").props.onClick();
    });
    expect(text()).not.toContain("Review required");
    expect(h.save).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  });

  it("reload shows the saved approved review from the detail record, not local draft state", async () => {
    await render(baseDetail());
    await rerender(baseDetail({ classifierEnabled: true, classifierPreparation: [savedEntry()] }));
    expect(text()).toContain("Approved");
    expect(text()).toContain("Current");
    expect(text()).toContain("Risk: Only reads");
  });

  it("opting a saved tool out saves optIn false, and Remove deletes the review after confirm", async () => {
    h.confirm.mockImplementation((options: { onConfirm: () => void }) => options.onConfirm());
    await render(baseDetail({ classifierEnabled: true, classifierPreparation: [savedEntry()] }));
    await act(async () => {
      switchByLabel("Classifier may use ToolA").props.onChange({ target: { checked: false } });
    });
    await flush();
    expect(h.save).toHaveBeenCalledWith(
      "conn-1",
      "ToolA",
      expect.objectContaining({ optIn: false })
    );

    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((node) => node.props["aria-label"] === "Remove ToolA review")!
        .props.onClick();
    });
    await flush();
    expect(h.remove).toHaveBeenCalledWith("conn-1", "ToolA");
  });

  it("stale review offers a diff, a paid re-preparation and a keep-off", async () => {
    h.prepare.mockResolvedValue(approvedPrepare([]));
    await render(
      baseDetail({
        classifierEnabled: true,
        classifierPreparation: [savedEntry({ state: "stale" })]
      })
    );
    expect(text()).toContain("Needs review");
    expect(text()).toContain("Before");
    expect(text()).toContain("After");
    expect(text()).toContain("one more default model request");

    await act(async () => {
      hostButton("Review changes").props.onClick();
    });
    await flush();
    expect(h.prepare).toHaveBeenCalledWith("conn-1", { force: true }, expect.anything());

    await act(async () => {
      hostButton("Keep it off").props.onClick();
    });
    await flush();
    expect(h.save).toHaveBeenCalledWith(
      "conn-1",
      "ToolA",
      expect.objectContaining({ optIn: false })
    );
  });

  it("a setup failure names the missing model, links the fix and offers a retry", async () => {
    h.prepare.mockResolvedValue({
      disclosure: DISCLOSURE,
      status: "unavailable",
      drafts: [],
      reused: [],
      failed: [],
      remaining: 0
    });
    await render(baseDetail());
    await act(async () => {
      hostButton("Prepare 1 tool").props.onClick();
    });
    await flush();
    expect(text()).toContain("Preparing failed");
    expect(text()).toContain("No default chat model is set.");
    expect(text()).toContain("Nothing changed.");
    expect(text()).toContain("/settings?section=assistant");
    expect(hostButton("Try again")).toBeTruthy();
  });

  it("no-tools and disconnected render the mockup's one-line states", async () => {
    await render(baseDetail({ tools: [], toolCount: 0, enabledToolCount: 0 }));
    expect(text()).toContain("No tools found");
    expect(text()).toContain("Nothing to prepare yet.");

    await rerender(baseDetail({ enabled: false }));
    expect(text()).toContain("Disconnected");
    expect(text()).toContain("Reconnect to change these settings.");
    expect(switchByLabel("Let the classifier use this connection").props.disabled).toBe(true);
  });

  it("names an ineligible tool and its reason rather than leaving it silently out", async () => {
    await render(
      baseDetail({
        tools: [tool({ name: "Locked" })],
        mutedTools: ["Locked"]
      })
    );
    expect(text()).toContain("Locked");
    expect(text()).toContain("Off for ordinary chat");
  });
});

// @vitest-environment jsdom
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatControlsProvider } from "../../apps/web/src/shell/chat-controls-context.js";

const putAiServiceBinding = vi.fn(async (_service: string, input: unknown) => ({
  service: "sorting",
  binding: (input as { binding: unknown }).binding
}));
const deleteAiServiceBinding = vi.fn(async (service: string) => ({ service }));
const getAdminRuntimeConfig = vi.fn(async (key: string) => ({
  config: { value: "off", source: "default" }
}));
const putAdminRuntimeConfig = vi.fn(async (key: string, value: string) => ({
  config: { value, source: "instance" }
}));

vi.mock("../../apps/web/src/api/client.js", () => ({
  putAiServiceBinding: (service: string, input: unknown) => putAiServiceBinding(service, input),
  deleteAiServiceBinding: (service: string) => deleteAiServiceBinding(service),
  getAdminRuntimeConfig: (key: string) => getAdminRuntimeConfig(key),
  putAdminRuntimeConfig: (key: string, value: string) => putAdminRuntimeConfig(key, value)
}));

import {
  CLASSIFIER_API_DISCLOSURE,
  CLASSIFIER_GATE_ON_NOTE,
  CLASSIFIER_HEADING,
  CLASSIFIER_HELP,
  DECISION_MODEL_HELP_DRAFT,
  SORTING_DISCLOSURE,
  SYSTEM_ONE_SORTING_NOTE,
  SortingModelRow
} from "../../apps/web/src/settings/settings-ai-sorting-row.js";
import { FeedbackProvider } from "../../apps/web/src/settings/settings-feedback.js";

const provider = (id: string, displayName: string, providerKind: string) => ({
  id,
  displayName,
  providerKind,
  authMethod: "api_key",
  executionMode: "interactive",
  status: "active",
  hasCredential: true,
  isInstanceDefault: false
});
const model = (
  id: string,
  providerConfigId: string,
  providerKind: string,
  providerDisplayName: string,
  capabilities: string[]
) => ({
  id,
  providerConfigId,
  providerKind,
  providerDisplayName,
  providerStatus: "active",
  providerModelId: id,
  displayName: id,
  capabilities,
  status: "active",
  tier: "economy",
  allowUserOverride: false,
  origin: "manual",
  createdAt: "2026-09-22T00:00:00.000Z",
  updatedAt: "2026-09-22T00:00:00.000Z"
});

const providers = [
  provider("p-local", "Local box", "openai-compatible"),
  provider("p-cloud", "Cloud", "anthropic"),
  provider("p-ollama", "Ollama", "ollama")
];
const models = [
  model("small-json", "p-local", "openai-compatible", "Local box", ["json"]),
  model("cloud-json", "p-cloud", "anthropic", "Cloud", ["chat", "json"]),
  model("cloud-chat", "p-cloud", "anthropic", "Cloud", ["chat"]),
  model("ollama-json", "p-ollama", "ollama", "Ollama", ["json"])
];

const chatControls = {
  openChat: () => {},
  openChatThread: () => {},
  openChatWith: () => {},
  openAssistantWithDraft: vi.fn()
};

async function render(
  binding?: unknown,
  fixtureModels: readonly unknown[] = models,
  fixtureProviders: readonly unknown[] = providers
): Promise<ReactTestRenderer> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          ChatControlsProvider,
          { value: chatControls },
          createElement(
            FeedbackProvider,
            null,
            createElement(SortingModelRow, {
              binding: binding as never,
              models: fixtureModels as never,
              providers: fixtureProviders as never
            })
          )
        )
      )
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return renderer;
}

const text = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());
const buttonByLabel = (renderer: ReactTestRenderer, label: string) => {
  const button = renderer.root
    .findAllByType("button")
    .find((candidate) => candidate.children.join("") === label);
  if (!button) throw new Error(`button ${label} not found`);
  return button;
};
const click = async (renderer: ReactTestRenderer, label: string) => {
  await act(async () => {
    buttonByLabel(renderer, label).props.onClick();
  });
};
const openDialog = async (renderer: ReactTestRenderer) => {
  const label = text(renderer).includes("Change model") ? "Change model" : "Choose a model";
  await click(renderer, label);
};
const radios = (renderer: ReactTestRenderer) =>
  renderer.root.findAll((node) => node.type === "input" && node.props.type === "radio");
const gateGroup = (renderer: ReactTestRenderer) =>
  renderer.root.find(
    (node) => node.props.role === "group" && node.props["aria-label"] === "Use in chat"
  );
const openGate = async (renderer: ReactTestRenderer) => {
  await openDialog(renderer);
  await click(renderer, "Advanced: use in chat");
};
const gateButton = (renderer: ReactTestRenderer, label: string) => {
  const button = gateGroup(renderer)
    .findAllByType("button")
    .find((candidate) => candidate.children.join("") === label);
  if (!button) throw new Error(`gate button ${label} not found`);
  return button;
};

describe("SortingModelRow (Classifier)", () => {
  beforeEach(() => {
    putAiServiceBinding.mockClear();
    deleteAiServiceBinding.mockClear();
    getAdminRuntimeConfig.mockClear();
    putAdminRuntimeConfig.mockClear();
    getAdminRuntimeConfig.mockResolvedValue({
      config: { value: "off", source: "default" }
    } as never);
  });

  it("names the row Decision model", async () => {
    const renderer = await render();
    expect(text(renderer)).toContain(CLASSIFIER_HEADING);
    expect(text(renderer)).not.toContain("Sorting model");
    expect(text(renderer)).toContain(CLASSIFIER_HELP);
  });

  it("lists every eligible model equally with nothing preselected", async () => {
    const renderer = await render();
    expect(text(renderer)).toContain("Not chosen");
    await openDialog(renderer);
    const values = radios(renderer).map((radio) => radio.props.value);
    expect(values).toEqual(["small-json", "cloud-json"]);
    expect(radios(renderer).every((radio) => radio.props.checked === false)).toBe(true);
    expect(buttonByLabel(renderer, "Save").props.disabled).toBe(true);
    expect(text(renderer)).not.toContain("Advanced: use in chat");
    expect(text(renderer)).not.toContain(SORTING_DISCLOSURE);
  });

  it("saving a chosen model saves a model binding", async () => {
    const renderer = await render();
    await openDialog(renderer);
    await act(async () => {
      radios(renderer)[0]!.props.onChange();
    });
    await click(renderer, "Save");
    expect(putAiServiceBinding).toHaveBeenCalledWith("sorting", {
      binding: { kind: "model", modelId: "small-json" }
    });
  });

  it("Use main model clears the binding", async () => {
    const renderer = await render({ kind: "model", modelId: "small-json" });
    await click(renderer, "Use main model");
    expect(deleteAiServiceBinding).toHaveBeenCalledWith("sorting");
    expect(putAiServiceBinding).not.toHaveBeenCalled();
  });

  it("shows the chosen model and the third-party line", async () => {
    const renderer = await render({ kind: "model", modelId: "small-json" });
    expect(text(renderer)).toContain("small-json");
    expect(text(renderer)).toContain("Change model");
    expect(text(renderer)).toContain(SORTING_DISCLOSURE);
  });

  it("shows the unavailable note for a saved model that cannot be used, and clears it", async () => {
    const renderer = await render({ kind: "model", modelId: "ollama-json" });
    expect(text(renderer)).toContain("Chosen model is unavailable. Using your main model.");
    expect(text(renderer)).toContain(SORTING_DISCLOSURE);
    await click(renderer, "Use main model");
    expect(deleteAiServiceBinding).toHaveBeenCalledWith("sorting");
  });

  it("tells a System One user it answers sorting questions and the main model handles the rest", async () => {
    const systemOneProvider = [provider("p-so", "TypeSafe", "system-one")];
    const systemOneModel = [model("jev-latest", "p-so", "system-one", "TypeSafe", ["json"])];
    const renderer = await render(
      { kind: "model", modelId: "jev-latest" },
      systemOneModel,
      systemOneProvider
    );
    const rendered = text(renderer);
    expect(rendered).toContain(SYSTEM_ONE_SORTING_NOTE);
    expect(rendered).toContain("answers News, Sports and email sorting questions with a yes or no");
    expect(rendered).toContain("each email's subject, sender, dates and text go there");
    expect(rendered).not.toContain("Sorting keeps using your main model");
    expect(rendered).not.toContain(SORTING_DISCLOSURE);
  });

  it("names a Cloudflare decision model and never says TypeSafe for a Clef binding", async () => {
    const clefProvider = [
      {
        ...provider("p-clef", "Clef (Cloudflare)", "system-one"),
        baseUrl: `https://api.cloudflare.com/client/v4/accounts/${"0123456789abcdef0123456789abcdef"}/ai`
      }
    ];
    const clefModel = [model("clef-flash", "p-clef", "system-one", "Clef (Cloudflare)", ["json"])];
    const renderer = await render(
      { kind: "model", modelId: "clef-flash" },
      clefModel,
      clefProvider
    );
    const rendered = text(renderer);
    expect(rendered).not.toContain("TypeSafe");
    expect(rendered).toContain("Clef (Cloudflare)");
    expect(rendered).toContain("answers News, Sports and email sorting questions with a yes or no");
    expect(rendered).not.toContain(SORTING_DISCLOSURE);
  });

  it("names a compatible service by its host in the note", async () => {
    const compatibleProvider = [
      {
        ...provider("p-comp", "Decision model (openrouter.ai)", "system-one"),
        baseUrl: "https://openrouter.ai/api"
      }
    ];
    const compatibleModel = [
      model("some-model", "p-comp", "system-one", "Decision model (openrouter.ai)", ["json"])
    ];
    const renderer = await render(
      { kind: "model", modelId: "some-model" },
      compatibleModel,
      compatibleProvider
    );
    const rendered = text(renderer);
    expect(rendered).not.toContain("TypeSafe");
    expect(rendered).not.toContain("Any compatible service");
    expect(rendered).toContain("Decision model (openrouter.ai)");
    expect(rendered).toContain("answers News, Sports and email sorting questions with a yes or no");
  });

  it("offers a json model even when its provider has no stored credential", async () => {
    const noCredentialProvider = [
      { ...provider("p-nocred", "No cred", "openai-compatible"), hasCredential: false }
    ];
    const noCredentialModel = [
      model("nocred-json", "p-nocred", "openai-compatible", "No cred", ["json"])
    ];
    const renderer = await render(undefined, noCredentialModel, noCredentialProvider);
    await openDialog(renderer);
    expect(radios(renderer).map((radio) => radio.props.value)).toEqual(["nocred-json"]);
  });

  it("hides Use in chat until a decision model is chosen", async () => {
    const renderer = await render();
    expect(text(renderer)).not.toContain("Use in chat");
    expect(
      renderer.root.findAll(
        (node) => node.props.role === "group" && node.props["aria-label"] === "Use in chat"
      )
    ).toHaveLength(0);
  });

  it("reads the saved gate record once a decision model is chosen", async () => {
    const renderer = await render({ kind: "model", modelId: "small-json" });
    expect(getAdminRuntimeConfig).toHaveBeenCalledWith("chat.classifier_gate_mode");
    await openGate(renderer);
    expect(gateButton(renderer, "Off").props["aria-pressed"]).toBe(true);
  });

  it("offers Ask Moss to help with a draft that names no model", async () => {
    const renderer = await render();
    const button = renderer.root
      .findAllByType("button")
      .find((candidate) => candidate.children.join("") === "Ask Moss to help");
    if (!button) throw new Error("Ask Moss to help not found");
    await act(async () => {
      button.props.onClick();
    });
    expect(chatControls.openAssistantWithDraft).toHaveBeenCalledWith(DECISION_MODEL_HELP_DRAFT);
    for (const m of models) {
      expect(DECISION_MODEL_HELP_DRAFT).not.toContain((m as { id: string }).id);
    }
  });

  it("enables all three gate choices once a classifier is chosen, with no review step", async () => {
    const renderer = await render({ kind: "model", modelId: "small-json" });
    await openGate(renderer);
    for (const label of ["Off", "Watch only", "On"]) {
      expect(gateButton(renderer, label).props.disabled).toBeFalsy();
    }
    expect(gateButton(renderer, "On").props.title).toBeUndefined();
    expect(text(renderer)).not.toContain("On opens after shadow review.");
    expect(text(renderer)).not.toContain("Available after shadow results are reviewed");
  });

  it("offers Ask Moss to help me decide inside the dialog", async () => {
    const renderer = await render();
    chatControls.openAssistantWithDraft.mockClear();
    await openDialog(renderer);
    await click(renderer, "Ask Moss to help me decide");
    expect(chatControls.openAssistantWithDraft).toHaveBeenCalledWith(DECISION_MODEL_HELP_DRAFT);
    expect(text(renderer)).not.toContain("Choose a decision model");
  });

  it("states the admin-wide reach of the gate", () => {
    expect(CLASSIFIER_GATE_ON_NOTE).toContain("every user's eligible messages");
    expect(CLASSIFIER_API_DISCLOSURE).toContain("every user's eligible messages");
  });

  it("shows On pressed when the saved record already reads on", async () => {
    getAdminRuntimeConfig.mockResolvedValue({
      config: { value: "on", source: "instance" }
    } as never);
    const renderer = await render({ kind: "model", modelId: "small-json" });
    await openGate(renderer);
    expect(gateButton(renderer, "On").props["aria-pressed"]).toBe(true);
  });

  it("turns the gate on from off by saving the dialog", async () => {
    const renderer = await render({ kind: "model", modelId: "small-json" });
    await openGate(renderer);
    await act(async () => {
      gateButton(renderer, "On").props.onClick();
    });
    await click(renderer, "Save");
    expect(putAdminRuntimeConfig).toHaveBeenCalledWith("chat.classifier_gate_mode", "on");
    expect(putAiServiceBinding).not.toHaveBeenCalled();
  });

  it("turns the gate on from shadow by saving the dialog", async () => {
    getAdminRuntimeConfig.mockResolvedValue({
      config: { value: "shadow", source: "instance" }
    } as never);
    const renderer = await render({ kind: "model", modelId: "small-json" });
    await openGate(renderer);
    await act(async () => {
      gateButton(renderer, "On").props.onClick();
    });
    await click(renderer, "Save");
    expect(putAdminRuntimeConfig).toHaveBeenCalledWith("chat.classifier_gate_mode", "on");
  });

  it("stops forwarding before changing a provider and keeps the requested Off mode", async () => {
    getAdminRuntimeConfig.mockResolvedValue({ config: { value: "on", source: "instance" } });
    const renderer = await render({ kind: "model", modelId: "small-json" });
    await openGate(renderer);
    await act(async () => {
      radios(renderer)[1]!.props.onChange();
      gateButton(renderer, "Off").props.onClick();
    });
    await click(renderer, "Save");
    expect(putAdminRuntimeConfig).toHaveBeenCalledExactlyOnceWith(
      "chat.classifier_gate_mode",
      "off"
    );
    expect(putAdminRuntimeConfig.mock.invocationCallOrder[0]).toBeLessThan(
      putAiServiceBinding.mock.invocationCallOrder[0]!
    );
  });

  it("does not switch providers if stopping forwarding fails", async () => {
    getAdminRuntimeConfig.mockResolvedValue({ config: { value: "on", source: "instance" } });
    putAdminRuntimeConfig.mockRejectedValueOnce(new Error("Cannot save mode"));
    const renderer = await render({ kind: "model", modelId: "small-json" });
    await openDialog(renderer);
    await act(async () => {
      radios(renderer)[1]!.props.onChange();
    });
    await click(renderer, "Save");
    expect(putAiServiceBinding).not.toHaveBeenCalled();
    expect(text(renderer)).toContain("Could not finish saving. Use in chat is on.");
    expect(text(renderer)).toContain("Choose a decision model");
  });

  it("leaves forwarding off and reports the partial save if changing providers fails", async () => {
    getAdminRuntimeConfig.mockResolvedValue({ config: { value: "on", source: "instance" } });
    putAiServiceBinding.mockRejectedValueOnce(new Error("Cannot save model"));
    const renderer = await render({ kind: "model", modelId: "small-json" });
    await openDialog(renderer);
    await act(async () => {
      radios(renderer)[1]!.props.onChange();
    });
    await click(renderer, "Save");
    expect(putAdminRuntimeConfig).toHaveBeenCalledExactlyOnceWith(
      "chat.classifier_gate_mode",
      "off"
    );
    expect(text(renderer)).toContain("Could not finish saving. Use in chat is off.");
    expect(text(renderer)).toContain("Choose a decision model");
  });

  it("does not save anything when the dialog closes with Cancel", async () => {
    const renderer = await render({ kind: "model", modelId: "small-json" });
    await openGate(renderer);
    await click(renderer, "Cancel");
    expect(putAdminRuntimeConfig).not.toHaveBeenCalled();
    expect(putAiServiceBinding).not.toHaveBeenCalled();
  });

  it("hides Use in chat again once the decision model is cleared", async () => {
    getAdminRuntimeConfig.mockResolvedValueOnce({
      config: { value: "on", source: "instance" }
    } as never);
    const renderer = await render();
    expect(text(renderer)).not.toContain("Use in chat");
  });

  it("saves an allowed gate choice and reads feedback from the saved record", async () => {
    const renderer = await render({ kind: "model", modelId: "small-json" });
    await openGate(renderer);
    await act(async () => {
      gateButton(renderer, "Watch only").props.onClick();
    });
    await click(renderer, "Save");
    expect(putAdminRuntimeConfig).toHaveBeenCalledWith("chat.classifier_gate_mode", "shadow");
  });

  it("shows the API disclosure for a hosted model only while the gate is shadow or on", async () => {
    const off = await render({ kind: "model", modelId: "small-json" });
    expect(text(off)).not.toContain(CLASSIFIER_API_DISCLOSURE);

    getAdminRuntimeConfig.mockResolvedValue({
      config: { value: "shadow", source: "instance" }
    } as never);
    const shadow = await render({ kind: "model", modelId: "small-json" });
    expect(text(shadow)).toContain(CLASSIFIER_API_DISCLOSURE);
    expect(text(shadow)).toContain("every user's eligible messages");
    expect(text(shadow)).toContain("Watch only");
  });

  it("does not show the API disclosure for an unavailable saved model", async () => {
    getAdminRuntimeConfig.mockResolvedValue({
      config: { value: "shadow", source: "instance" }
    } as never);
    const renderer = await render({ kind: "model", modelId: "ollama-json" }, models, providers);
    expect(text(renderer)).toContain("Chosen model is unavailable. Using your main model.");
    expect(text(renderer)).not.toContain(CLASSIFIER_API_DISCLOSURE);
  });

  it("links the Shadow badge to the shadow report while the gate is shadow", async () => {
    getAdminRuntimeConfig.mockResolvedValue({
      config: { value: "shadow", source: "instance" }
    } as never);
    const renderer = await render({ kind: "model", modelId: "small-json" });
    const hrefs = renderer.root.findAllByType("a").map((anchor) => anchor.props.href);
    expect(hrefs.filter((href) => href === "/settings?section=shadowreport")).toHaveLength(1);
    expect(text(renderer)).toContain("See watch-only results");
  });

  it("shows no shadow report link while the gate is off", async () => {
    const renderer = await render({ kind: "model", modelId: "small-json" });
    const hrefs = renderer.root.findAllByType("a").map((anchor) => anchor.props.href);
    expect(hrefs).not.toContain("/settings?section=shadowreport");
    expect(text(renderer)).not.toContain("See watch-only results");
  });
});

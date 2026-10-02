// @vitest-environment jsdom
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  CLASSIFIER_HEADING,
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
          FeedbackProvider,
          null,
          createElement(SortingModelRow, {
            binding: binding as never,
            models: fixtureModels as never,
            providers: fixtureProviders as never
          })
        )
      )
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return renderer;
}

const select = (renderer: ReactTestRenderer) => renderer.root.findByType("select");
const text = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());
const gateGroup = (renderer: ReactTestRenderer) =>
  renderer.root.find(
    (node) => node.props.role === "group" && node.props["aria-label"] === "Gate state"
  );
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

  it("renames the user-facing row to Classifier", async () => {
    const renderer = await render();
    expect(text(renderer)).toContain(CLASSIFIER_HEADING);
    expect(text(renderer)).not.toContain("Sorting model");
    expect(text(renderer)).toContain("Optional model to handle classification requests.");
  });

  it("offers Use main model plus only eligible models, grouped by provider", async () => {
    const renderer = await render();
    expect(select(renderer).props.value).toBe("");
    const groups = renderer.root.findAllByType("optgroup").map((group) => group.props.label);
    expect(groups).toEqual(["Local box", "Cloud"]);
    const values = renderer.root.findAllByType("option").map((option) => option.props.value);
    expect(values).toEqual(["", "model:small-json", "model:cloud-json"]);
    expect(text(renderer)).toContain("Use main model");
    expect(text(renderer)).not.toContain(SORTING_DISCLOSURE);
  });

  it("selecting a model saves a model binding", async () => {
    const renderer = await render();
    await act(async () => {
      select(renderer).props.onChange({ target: { value: "model:small-json" } });
    });
    expect(putAiServiceBinding).toHaveBeenCalledWith("sorting", {
      binding: { kind: "model", modelId: "small-json" }
    });
  });

  it("choosing Use main model clears the binding", async () => {
    const renderer = await render({ kind: "model", modelId: "small-json" });
    await act(async () => {
      select(renderer).props.onChange({ target: { value: "" } });
    });
    expect(deleteAiServiceBinding).toHaveBeenCalledWith("sorting");
    expect(putAiServiceBinding).not.toHaveBeenCalled();
  });

  it("shows the third-party line whenever a sorting model is chosen", async () => {
    const renderer = await render({ kind: "model", modelId: "small-json" });
    expect(select(renderer).props.value).toBe("model:small-json");
    expect(text(renderer)).toContain(SORTING_DISCLOSURE);
  });

  it("keeps an unavailable saved model selected, shows the note, and clears it", async () => {
    const renderer = await render({ kind: "model", modelId: "ollama-json" });
    expect(select(renderer).props.value).toBe("model:ollama-json");
    const unavailable = renderer.root
      .findAllByType("option")
      .find((option) => option.props.value === "model:ollama-json");
    if (!unavailable) throw new Error("unavailable option not found");
    expect(unavailable.props.disabled).toBe(true);
    expect(text(renderer)).toContain("ollama-json (unavailable)");
    expect(text(renderer)).toContain("Chosen model is unavailable. Using your main model.");
    expect(text(renderer)).toContain(SORTING_DISCLOSURE);
    await act(async () => {
      select(renderer).props.onChange({ target: { value: "" } });
    });
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

  it("offers a json model even when its provider has no stored credential", async () => {
    const noCredentialProvider = [
      { ...provider("p-nocred", "No cred", "openai-compatible"), hasCredential: false }
    ];
    const noCredentialModel = [
      model("nocred-json", "p-nocred", "openai-compatible", "No cred", ["json"])
    ];
    const renderer = await render(undefined, noCredentialModel, noCredentialProvider);
    const values = renderer.root.findAllByType("option").map((option) => option.props.value);
    expect(values).toEqual(["", "model:nocred-json"]);
  });

  it("reads the saved gate record and keeps On unusable until it is already on", async () => {
    const renderer = await render();
    expect(getAdminRuntimeConfig).toHaveBeenCalledWith("chat.classifier_gate_mode");
    const on = gateButton(renderer, "On");
    expect(on.props.disabled).toBe(true);
    expect(on.props.title).toBe("Available after shadow results are reviewed");
    expect(gateButton(renderer, "Off").props["aria-pressed"]).toBe(true);
    expect(text(renderer)).toContain("On opens after shadow review.");
  });

  it("enables On when the saved record already reads on", async () => {
    getAdminRuntimeConfig.mockResolvedValue({
      config: { value: "on", source: "instance" }
    } as never);
    const renderer = await render();
    expect(gateButton(renderer, "On").props.disabled).toBe(false);
    expect(gateButton(renderer, "On").props["aria-pressed"]).toBe(true);
    expect(text(renderer)).not.toContain("On opens after shadow review.");
  });

  it("saves an allowed gate choice and reads feedback from the saved record", async () => {
    const renderer = await render();
    await act(async () => {
      gateButton(renderer, "Shadow").props.onClick();
    });
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
    expect(text(shadow)).toContain("Shadow");
  });

  it("does not show the API disclosure for an unavailable saved model", async () => {
    getAdminRuntimeConfig.mockResolvedValue({
      config: { value: "shadow", source: "instance" }
    } as never);
    const renderer = await render({ kind: "model", modelId: "ollama-json" }, models, providers);
    expect(text(renderer)).toContain("Chosen model is unavailable. Using your main model.");
    expect(text(renderer)).not.toContain(CLASSIFIER_API_DISCLOSURE);
  });
});

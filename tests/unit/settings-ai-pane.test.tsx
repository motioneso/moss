// @vitest-environment jsdom
// Regression test for the stale persona save-acknowledgement: after a persona save, the
// "Saved. This is X's current voice." line (settings-ai-pane.tsx's Persona component) must read
// from the mutation's own result (`saved`), not from the global useAssistantName() hook — a
// separate react-query cache entry (same queryKey, different subscription) that has not
// necessarily refetched by the time this line renders. The GET mock below is pinned to "Moss"
// forever, so the hook is demonstrably stale at assertion time regardless of refetch timing.
//
// Needs jsdom + react-test-renderer's `act` to drive the real input/button handlers and let a
// real react-query mutation resolve — this repo has no @testing-library/react; the
// `// @vitest-environment jsdom` opt-in + react-test-renderer pattern is established in
// tests/unit/job-search-use-profiles.test.tsx.
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type { MeResponse } from "@moss/shared";

const personaGet = vi.fn(async () => ({
  persona: { assistantName: "Moss", personaText: "Be direct and a little dry." }
}));
const personaPut = vi.fn(
  async (body: { persona: { assistantName: string; personaText: string } }) => ({
    persona: body.persona
  })
);

vi.mock("../../apps/web/src/api/client.js", () => ({
  getPersonaSettings: () => personaGet(),
  putPersonaSettings: (body: unknown) => personaPut(body as never),
  previewPersona: vi.fn(),
  // ChatModel and YoloMode (siblings inside AssistantPane) run their own queries; give them inert
  // responses so they render without erroring and stay out of the way of the assertion.
  getChatModelOverrideSettings: vi.fn(async () => ({
    settings: {
      overrideEnabled: false,
      currentOverrideModelId: null,
      effectiveOverrideModelId: null,
      defaultModel: null,
      selectedModel: null,
      selectableOverrideModels: []
    }
  })),
  putChatModelOverride: vi.fn(),
  getYoloSettings: vi.fn(async () => ({
    instanceEnabled: false,
    self: { allowed: false, enabled: false, active: false }
  })),
  putYoloSelf: vi.fn(),
  getChatArchiveSettings: () => chatArchiveGet(),
  putChatArchiveSettings: (body: unknown) => chatArchivePut(body as never)
}));

const notesSourceGet = vi.fn(
  async (): Promise<{ path: string | null }> => ({
    path: "/data/vaults/u1"
  })
);
vi.mock("../../apps/web/src/api/notes-client.js", () => ({
  getNotesSource: () => notesSourceGet()
}));

const chatArchiveGet = vi.fn(async () => ({
  enabled: false,
  folder: "Moss/Chats",
  status: null
}));
const chatArchivePut = vi.fn(async (body: { enabled: boolean; folder: string }) => body);

import { AssistantPane } from "../../apps/web/src/settings/settings-ai-pane.js";
import { FeedbackProvider } from "../../apps/web/src/settings/settings-feedback.js";

const me: MeResponse = {
  user: {
    id: "u1",
    email: "u@example.test",
    emailVerified: true,
    name: "U",
    status: "active",
    isInstanceAdmin: false,
    isBootstrapOwner: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  },
  profilePrefs: { addressed: null },
  hasPasswordCredential: true
};

// react-test-renderer has no textContent; walk the JSON tree and join every string leaf.
function renderedText(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(renderedText).join("");
  if (typeof node === "object" && "children" in (node as Record<string, unknown>)) {
    return renderedText((node as { children: unknown }).children);
  }
  return "";
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("Persona save acknowledgement", () => {
  it("reads the just-saved assistant name, not the (still-stale) global hook", async () => {
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
            createElement(AssistantPane, { me, onNavigate: () => {} })
          )
        )
      );
    });
    await flush();

    const nameInput = renderer.root.findByProps({ "aria-label": "Assistant name" });
    await act(async () => {
      nameInput.props.onChange({ target: { value: "Alfred" } });
    });

    const saveButton = renderer.root
      .findAllByType("button")
      .find((instance) => instance.children.includes("Save persona"));
    if (!saveButton) throw new Error("Save persona button not found");
    await act(async () => {
      saveButton.props.onClick();
    });
    // Two flushes: one for the mutation's own onSuccess, one for the invalidateQueries-triggered
    // background refetch it kicks off. The GET mock stays pinned to "Moss" either way, so
    // useAssistantName() is provably stale here no matter how many refetches land.
    await flush();
    await flush();

    expect(personaPut).toHaveBeenCalledWith({
      persona: { assistantName: "Alfred", personaText: "Be direct and a little dry." }
    });

    const text = renderedText(renderer.toJSON());
    expect(text).toContain("Saved. This is Alfred's current voice.");

    await act(async () => {
      renderer.unmount();
    });
  });
});

async function renderAssistantPane(): Promise<ReactTestRenderer> {
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
          createElement(AssistantPane, { me, onNavigate: () => {} })
        )
      )
    );
  });
  await flush();
  return renderer;
}

describe("Chat archive settings section", () => {
  it("shows an empty state and no controls when no notes folder is connected", async () => {
    notesSourceGet.mockResolvedValueOnce({ path: null });
    const renderer = await renderAssistantPane();

    expect(() => renderer.root.findByProps({ "aria-label": "Save chats to Notes" })).toThrow();
    const text = renderedText(renderer.toJSON());
    expect(text).toContain("Connect a notes folder");

    await act(async () => {
      renderer.unmount();
    });
  });

  it("shows the switch off and the folder pre-filled when a source is connected", async () => {
    const renderer = await renderAssistantPane();

    const toggle = renderer.root.findByProps({ "aria-label": "Save chats to Notes" });
    expect(toggle.props.checked).toBe(false);
    const folderInput = renderer.root.findByProps({ "aria-label": "Transcript folder" });
    expect(folderInput.props.value).toBe("Moss/Chats");

    await act(async () => {
      renderer.unmount();
    });
  });

  it("toggling the switch saves the current folder with the new enabled value", async () => {
    const renderer = await renderAssistantPane();

    const toggle = renderer.root.findByProps({ "aria-label": "Save chats to Notes" });
    await act(async () => {
      toggle.props.onChange({ target: { checked: true } });
    });
    await flush();

    expect(chatArchivePut).toHaveBeenCalledWith({ enabled: true, folder: "Moss/Chats" });

    await act(async () => {
      renderer.unmount();
    });
  });

  it("blurring an edited folder field saves the new folder", async () => {
    const renderer = await renderAssistantPane();

    const folderInput = renderer.root.findByProps({ "aria-label": "Transcript folder" });
    await act(async () => {
      folderInput.props.onChange({ target: { value: "2 Area/Moss/Chats" } });
    });
    await act(async () => {
      folderInput.props.onBlur();
    });
    await flush();

    expect(chatArchivePut).toHaveBeenCalledWith({
      enabled: false,
      folder: "2 Area/Moss/Chats"
    });

    await act(async () => {
      renderer.unmount();
    });
  });

  it("shows the server's rejection message inline when a folder is refused", async () => {
    chatArchivePut.mockRejectedValueOnce(
      new Error("Chat archive folder cannot start with a leading slash")
    );
    const renderer = await renderAssistantPane();

    const folderInput = renderer.root.findByProps({ "aria-label": "Transcript folder" });
    await act(async () => {
      folderInput.props.onChange({ target: { value: "/etc/passwd" } });
    });
    await act(async () => {
      folderInput.props.onBlur();
    });
    await flush();

    const text = renderedText(renderer.toJSON());
    expect(text).toContain("Chat archive folder cannot start with a leading slash");

    await act(async () => {
      renderer.unmount();
    });
  });

  it("shows a paused message next to the controls when archiving is paused (#1992)", async () => {
    chatArchiveGet.mockResolvedValueOnce({
      enabled: true,
      folder: "Moss/Chats",
      status: { state: "paused", reason: "No notes folder is connected." }
    });
    const renderer = await renderAssistantPane();

    const text = renderedText(renderer.toJSON());
    expect(text).toContain("No notes folder is connected.");

    await act(async () => {
      renderer.unmount();
    });
  });

  it("shows nothing extra when there is no status (#1992)", async () => {
    const renderer = await renderAssistantPane();

    const text = renderedText(renderer.toJSON());
    expect(text).not.toContain("Archiving is paused");
    expect(text).not.toContain("Archiving failed");

    await act(async () => {
      renderer.unmount();
    });
  });
});

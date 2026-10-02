import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import type { MeResponse, ModelActivityEntryDto } from "@moss/shared";

const listModelActivity = vi.hoisted(() => vi.fn());

vi.mock("../../apps/web/src/api/client.js", () => ({
  listModelActivity
}));

vi.mock("../../apps/web/src/locale/locale-format.js", () => ({
  formatDate: vi.fn(() => "July 16, 2026"),
  formatTime: vi.fn(() => "9:41 AM"),
  useUserLocale: vi.fn(() => ({ timezone: "UTC", region: "en-US", dateFormat: "12" }))
}));

import { ModelActivityPane } from "../../apps/web/src/settings/settings-model-activity-pane.js";

const me: MeResponse = {
  user: {
    id: "u1",
    email: "u@example.test",
    emailVerified: true,
    name: "U",
    status: "active",
    isInstanceAdmin: true,
    isBootstrapOwner: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  },
  profilePrefs: { addressed: null },
  hasPasswordCredential: true
};

function entry(overrides: Partial<ModelActivityEntryDto> = {}): ModelActivityEntryDto {
  return {
    id: "activity-1",
    occurredAt: new Date().toISOString(),
    kind: "chat",
    action: "chat",
    outcome: "ok",
    modelName: "some-configured-model",
    result: "completed",
    ...overrides
  };
}

describe("ModelActivityPane", () => {
  it("renders the empty state when there are no recorded calls", async () => {
    listModelActivity.mockResolvedValueOnce({ entries: [], nextBefore: null });

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(createElement(ModelActivityPane, { me, onNavigate: () => undefined }));
    });

    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain("Model activity");
    expect(json).toContain("No activity yet");
    expect(json).not.toContain("No lines match these filters");

    act(() => renderer.unmount());
  });

  it("renders a recorded call with its model name and a day heading", async () => {
    listModelActivity.mockResolvedValueOnce({
      entries: [entry()],
      nextBefore: null
    });

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(createElement(ModelActivityPane, { me, onNavigate: () => undefined }));
    });

    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain("Today");
    expect(json).toContain("some-configured-model");
    expect(json).toContain("Answered");
    expect(json).toContain("Chat answer");

    act(() => renderer.unmount());
  });

  it("offers Load older only when the endpoint returns a cursor", async () => {
    listModelActivity.mockResolvedValueOnce({
      entries: [entry()],
      nextBefore: new Date(Date.now() - 1000).toISOString()
    });

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(createElement(ModelActivityPane, { me, onNavigate: () => undefined }));
    });

    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain("Load older");

    act(() => renderer.unmount());
  });
});

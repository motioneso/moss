import { describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Dialog } from "@moss/ui";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import type { OnboardingStatusResponse } from "@moss/shared";
import { SkipConfirmDialog, needsSkipConfirm } from "../../apps/web/src/onboarding/skip-confirm.js";

const noop = () => undefined;

const founderReady: OnboardingStatusResponse = {
  role: "founder",
  state: "pending",
  steps: {
    cliAuth: {
      done: true,
      providers: [{ kind: "anthropic", cliPresent: true, installState: "ready" }]
    },
    connectors: { done: false }
  }
};

const founderNoProvider: OnboardingStatusResponse = {
  role: "founder",
  state: "pending",
  steps: {
    cliAuth: {
      done: false,
      providers: [{ kind: "anthropic", cliPresent: true, installState: "needs_login" }]
    },
    connectors: { done: false }
  }
};

describe("needsSkipConfirm", () => {
  it("requires confirmation when no provider is connected", () => {
    expect(needsSkipConfirm(founderNoProvider)).toBe(true);
  });

  it("does NOT require confirmation once a provider is connected (chat will work)", () => {
    expect(needsSkipConfirm(founderReady)).toBe(false);
  });

  it("does NOT require confirmation for a member whose chat route is usable", () => {
    const member: OnboardingStatusResponse = {
      role: "member",
      completed: false,
      steps: { apiKeyOptOut: { done: false }, connectors: { done: false } }
    };
    expect(needsSkipConfirm(member, true)).toBe(false);
    expect(needsSkipConfirm(member, false)).toBe(true);
  });
});

describe("SkipConfirmDialog (rendered)", () => {
  function render(over?: { onConfirm?: () => void; onCancel?: () => void }): string {
    return renderToString(
      createElement(SkipConfirmDialog, {
        onConfirm: over?.onConfirm ?? noop,
        onCancel: over?.onCancel ?? noop,
        pending: false
      })
    );
  }

  it("states the consequence: chat won't work until a provider is connected", () => {
    const html = render().toLowerCase();
    expect(html).toContain("chat won");
    expect(html).toContain("provider");
    expect(html).toContain("settings");
  });

  it("offers both a confirm (skip anyway) and a cancel affordance", () => {
    const html = render().toLowerCase();
    expect(html).toContain("skip");
    expect(html).toContain("cancel");
  });

  it("does not leak the raw backend error string", () => {
    expect(render()).not.toContain("No active chat-capable model is configured");
  });
});

describe("SkipConfirmDialog shared dismissal", () => {
  it("does not dismiss an in-flight skip and keeps both action controls disabled", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<SkipConfirmDialog pending onCancel={onCancel} onConfirm={onConfirm} />);
    });
    const dialog = renderer.root.findByType(Dialog);
    act(() => dialog.props.onClose());
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType("button").every((button) => button.props.disabled)).toBe(
      true
    );
    act(() => renderer.unmount());
  });
});

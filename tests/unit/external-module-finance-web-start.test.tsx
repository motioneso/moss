// @vitest-environment jsdom
//
// Getting started (#3178): the no-bank steps, and who sees what when the bank
// keys are missing. The view is pure, so each variant renders from props.
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { StartView, SETTINGS_HREF } from "../../external-modules/finance/src/web/screens/start";

function render(props: { keysConfigured: boolean; hasBank: boolean; isAdmin: boolean }) {
  const openAssistant = vi.fn();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(createElement(StartView, { ...props, hostActions: { openAssistant } }));
  });
  return { renderer, openAssistant };
}

function text(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

describe("Getting started (#3178)", () => {
  it("shows the three steps with a Connect a bank button when keys are set", () => {
    const { renderer, openAssistant } = render({
      keysConfigured: true,
      hasBank: false,
      isAdmin: false
    });
    const out = text(renderer);
    expect(out).toContain("1. Connect a bank");
    expect(out).toContain("2. Moss sorts your spending");
    expect(out).toContain("3. Build your budget together");
    const button = renderer.root.findAllByType("button")[0]!;
    expect(JSON.stringify(button.props.children)).toContain("Connect a bank");
    act(() => button.props.onClick());
    expect(openAssistant).toHaveBeenCalledWith({ starterPrompt: "Connect my bank account" });
  });

  it("gives an admin an Add bank keys link to Finance settings when keys are missing", () => {
    const { renderer } = render({ keysConfigured: false, hasBank: false, isAdmin: true });
    const link = renderer.root.findAllByType("a").find((a) => a.props.href === SETTINGS_HREF);
    expect(link?.props.children).toBe("Add bank keys");
    expect(text(renderer)).not.toContain("Waiting on your admin");
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
  });

  it("tells a member they are waiting on their admin when keys are missing", () => {
    const { renderer } = render({ keysConfigured: false, hasBank: false, isAdmin: false });
    expect(text(renderer)).toContain("Waiting on your admin");
    expect(renderer.root.findAllByType("a")).toHaveLength(0);
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
  });

  it("marks step 1 connected once a bank is linked", () => {
    const { renderer } = render({ keysConfigured: true, hasBank: true, isAdmin: false });
    expect(text(renderer)).toContain("Connected");
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
  });
});

// @vitest-environment jsdom
//
// #3186: the Finance Settings screen. Server answers come through a faked fetch at the
// network edge; the screen and the store run for real.
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsScreen } from "../../external-modules/finance/src/web/screens/settings";
import { __resetStoreForTests } from "../../external-modules/finance/src/web/store";

type Reply = { status: number; body: unknown };
type Route = (method: string, url: string, body: unknown) => Reply | Promise<Reply>;

const calls: Array<{ method: string; url: string; body: unknown }> = [];

function install(route: Route): void {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      const out = await route(method, url, body);
      return { ok: out.status < 300, status: out.status, json: async () => out.body };
    })
  );
}

const ROUTINE_POLICIES = [
  { moduleId: "finance", actionFamilyId: "sorting", tier: "trusted_auto" },
  { moduleId: "finance", actionFamilyId: "moving_money", tier: "trusted_auto" }
];

function defaults(over: Partial<Record<string, { status: number; body: unknown }>> = {}): Route {
  return (method, url) => {
    const key = `${method} ${url}`;
    const hit = Object.entries(over).find(([k]) => key.startsWith(k));
    if (hit) return hit[1] as { status: number; body: unknown };
    if (url.startsWith("/api/ai/action-policy") && method === "GET") {
      return { status: 200, body: { policies: ROUTINE_POLICIES } };
    }
    if (url === "/api/modules/finance/preferences" && method === "GET") {
      return {
        status: 200,
        body: { preferences: [{ key: "freedomLimitDollars", value: 100, default: 100 }] }
      };
    }
    if (url === "/api/admin/modules/finance/credentials") {
      return { status: 403, body: {} };
    }
    if (url.includes("/assistant-tools/finance.activity.list/")) {
      return {
        status: 200,
        body: { invocation: { status: "succeeded", result: { status: "ok", activity: [] } } }
      };
    }
    return { status: 200, body: {} };
  };
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(SettingsScreen));
  });
  await act(async () => {});
  return renderer;
}

function collect(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(collect).join(" ");
  return collect((node as { children?: unknown }).children);
}
const text = (renderer: ReactTestRenderer): string => collect(renderer.toJSON());

const radio = (renderer: ReactTestRenderer, value: string) =>
  renderer.root.findAll(
    (n) => n.type === "input" && n.props.type === "radio" && n.props.value === value
  )[0]!;

afterEach(() => {
  __resetStoreForTests();
  vi.unstubAllGlobals();
});

describe("Finance settings (#3186)", () => {
  it("shows the four choices, picks the preset the stored tiers match, and hides bank keys from non-admins", async () => {
    install(defaults());
    const renderer = await render();
    const out = text(renderer);

    expect(out).toContain("Ask about everything");
    expect(out).toContain("Handle routine, ask about new");
    expect(out).toContain("Run it all, review weekly");
    expect(out).toContain("Custom");
    expect(radio(renderer, "routine").props.checked).toBe(true);
    expect(out).not.toContain("Bank connection");
    expect(out).toContain("Nothing yet.");
  });

  it("shows the middle step on a fresh install with no stored choices", async () => {
    install(
      defaults({
        "GET /api/ai/action-policy": { status: 200, body: { policies: [] } }
      })
    );
    const renderer = await render();
    expect(radio(renderer, "routine").props.checked).toBe(true);
    expect(text(renderer)).toContain("Dollar limit");
  });

  it("shows the first step and hides the dollar limit when every choice is stored as ask", async () => {
    install(
      defaults({
        "GET /api/ai/action-policy": {
          status: 200,
          body: {
            policies: ["sorting", "moving_money", "sorting_new", "rules", "categories"].map(
              (f) => ({
                moduleId: "finance",
                actionFamilyId: f,
                tier: "ask_each_time"
              })
            )
          }
        }
      })
    );
    const renderer = await render();
    expect(radio(renderer, "ask").props.checked).toBe(true);
    expect(text(renderer)).not.toContain("Dollar limit");
  });

  it("saves a preset through the freedom route", async () => {
    install(defaults());
    const renderer = await render();
    await act(async () => {
      radio(renderer, "all").props.onChange();
    });
    expect(
      calls.find((c) => c.method === "POST" && c.url.endsWith("/finance/freedom"))?.body
    ).toEqual({
      step: 3
    });
    expect(radio(renderer, "all").props.checked).toBe(true);
  });

  it("reverts the choice and shows an inline error when the save fails", async () => {
    install(defaults({ "POST /api/ai/action-policy/finance/freedom": { status: 500, body: {} } }));
    const renderer = await render();
    await act(async () => {
      radio(renderer, "all").props.onChange();
    });
    await act(async () => {});
    expect(radio(renderer, "routine").props.checked).toBe(true);
    expect(text(renderer)).toContain("Couldn't save that.");
  });

  it("puts the limit back with an error when saving it fails", async () => {
    install(defaults({ "PATCH /api/modules/finance/preferences": { status: 500, body: {} } }));
    const renderer = await render();
    const input = renderer.root.findByProps({ id: "fnm-limit" });
    await act(async () => {
      input.props.onChange({ target: { value: "250" } });
    });
    await act(async () => {
      renderer.root.findByProps({ id: "fnm-limit" }).props.onBlur();
    });
    await act(async () => {});
    expect(renderer.root.findByProps({ id: "fnm-limit" }).props.value).toBe("$100");
    expect(text(renderer)).toContain("Couldn't save the limit.");
  });

  it("refuses a limit that is not a whole number of dollars", async () => {
    install(defaults());
    const renderer = await render();
    await act(async () => {
      renderer.root.findByProps({ id: "fnm-limit" }).props.onChange({ target: { value: "12.5" } });
    });
    await act(async () => {
      renderer.root.findByProps({ id: "fnm-limit" }).props.onBlur();
    });
    expect(text(renderer)).toContain("Enter a whole number of dollars");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("keeps choices, switches and limit disabled until both settings reads settle", async () => {
    let releaseLimit!: (reply: Reply) => void;
    const waitingLimit = new Promise<Reply>((resolve) => {
      releaseLimit = resolve;
    });
    const fallback = defaults();
    install((method, url, body) =>
      method === "GET" && url === "/api/modules/finance/preferences"
        ? waitingLimit
        : fallback(method, url, body)
    );
    const renderer = await render();
    expect(text(renderer)).toContain("Loading your current choices and dollar limit");
    expect(radio(renderer, "all").props.disabled).toBe(true);
    expect(renderer.root.findByProps({ id: "fnm-limit" }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({ id: "fnm-limit" }).props.value).toBe("");
    await act(async () => {
      renderer.root.findByProps({ "aria-controls": "fnm-customize" }).props.onClick();
    });
    const switches = renderer.root.findAll(
      (n) => n.type === "input" && n.props.type === "checkbox"
    );
    expect(switches).toHaveLength(5);
    expect(switches.every((n) => n.props.disabled)).toBe(true);
    // A stale event cannot write through the disabled presentation.
    await act(async () => {
      radio(renderer, "all").props.onChange();
      switches[0]!.props.onChange({ target: { checked: true } });
      renderer.root.findByProps({ id: "fnm-limit" }).props.onBlur();
    });
    expect(calls.some((c) => c.method === "PATCH" || c.url.endsWith("/finance/freedom"))).toBe(
      false
    );
    await act(async () => {
      releaseLimit({
        status: 200,
        body: { preferences: [{ key: "freedomLimitDollars", value: 250 }] }
      });
    });
    expect(radio(renderer, "all").props.disabled).not.toBe(true);
    expect(renderer.root.findByProps({ id: "fnm-limit" }).props.value).toBe("$250");
  });

  it.each([
    { status: 503, body: {} },
    { status: 200, body: {} },
    { status: 200, body: { preferences: [{ key: "freedomLimitDollars", value: "unknown" }] } }
  ])(
    "shows an unavailable limit instead of an editable $100 after invalid reads: %j",
    async (reply) => {
      install(defaults({ "GET /api/modules/finance/preferences": reply }));
      const renderer = await render();
      expect(text(renderer)).toContain("Couldn't load your dollar limit.");
      expect(text(renderer)).toContain("Retry loading settings");
      expect(radio(renderer, "all").props.disabled).toBe(true);
      expect(renderer.root.findByProps({ id: "fnm-limit" }).props.disabled).toBe(true);
      expect(renderer.root.findByProps({ id: "fnm-limit" }).props.value).toBe("");
      expect(text(renderer)).not.toContain("Couldn't save");
    }
  );

  it("keeps a confirmed limit while policy defaults are unverified, then enables editing after retry", async () => {
    const failed = defaults({ "GET /api/ai/action-policy": { status: 503, body: {} } });
    let recovered = false;
    install((method, url, body) => (recovered ? defaults() : failed)(method, url, body));
    const renderer = await render();
    expect(text(renderer)).toContain("Showing the safe defaults.");
    expect(radio(renderer, "routine").props.checked).toBe(false);
    expect(renderer.root.findByProps({ id: "fnm-limit" }).props.value).toBe("$100");
    expect(renderer.root.findByProps({ id: "fnm-limit" }).props.disabled).toBe(true);
    recovered = true;
    await act(async () => {
      renderer.root
        .findAllByType("button")
        .find((n) => collect(n.props.children).trim() === "Retry loading settings")!
        .props.onClick();
    });
    expect(radio(renderer, "routine").props.checked).toBe(true);
    expect(radio(renderer, "all").props.disabled).not.toBe(true);
    expect(text(renderer)).not.toContain("Couldn't load");
  });

  it("renders an explicit decorative disclosure marker without consuming the shared hit target", async () => {
    install(defaults());
    const renderer = await render();
    const marker = renderer.root.findByProps({ className: "fnm-disclosure-marker" });
    expect(marker.props["aria-hidden"]).toBe("true");
    const disclosure = renderer.root.findByProps({ "aria-controls": "fnm-customize" });
    expect(disclosure.props["aria-expanded"]).toBe(false);
    await act(async () => disclosure.props.onClick());
    expect(
      renderer.root.findByProps({ "aria-controls": "fnm-customize" }).props["aria-expanded"]
    ).toBe(true);
  });

  it("shows the bank key rows to an admin and never the values", async () => {
    install(
      defaults({
        "GET /api/admin/modules/finance/credentials": {
          status: 200,
          body: {
            credentials: [
              {
                credentialId: "finance.plaid-client-id",
                displayName: "Plaid client ID",
                configured: true
              },
              {
                credentialId: "finance.plaid-secret",
                displayName: "Plaid secret",
                configured: false
              }
            ]
          }
        }
      })
    );
    const out = text(await render());
    expect(out).toContain("Bank connection");
    expect(out).toContain("Plaid client ID");
    expect(out).toContain("Saved");
    expect(out).toContain("Replace");
  });
});

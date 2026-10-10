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

type Route = (method: string, url: string, body: unknown) => { status: number; body: unknown };

const calls: Array<{ method: string; url: string; body: unknown }> = [];

function install(route: Route): void {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      const out = route(method, url, body);
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
    expect(out).toContain("Moss hasn't done anything on its own yet.");
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

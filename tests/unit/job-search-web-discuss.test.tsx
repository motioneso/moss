// tests/unit/job-search-web-discuss.test.tsx
// Task 20 (#1304, chat-surface half): discuss.tsx in isolation, plain node environment (same
// reasoning as job-search-web-settings.test.tsx's header — no jsdom needed). assistantSurface is
// a hand-rolled fake satisfying AssistantSurfaceHandleV1 structurally, never the host's real
// chat-surface implementation (module isolation) — submitTurn/setSurfaceKey are spies, so these
// tests exercise only discuss.tsx's own contract: what MatchRecordCard renders, and what
// useDiscuss does and doesn't send. board.tsx's own wiring (the Discuss control's
// presence/absence, the Surface+localRows panel) is covered separately in
// job-search-web-board.test.tsx — this file never renders BoardScreen.
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import {
  MatchRecordCard,
  useDiscuss,
  type UseDiscussResult
} from "../../external-modules/job-search/src/web/screens/discuss";
import * as api from "../../external-modules/job-search/src/web/api";
import type { AssistantSurfaceHandleV1 } from "../../external-modules/job-search/src/domain/seed-prompt";
import type { MatchDetail } from "../../external-modules/job-search/src/web/board-types";

function detail(overrides: Partial<MatchDetail> = {}): MatchDetail {
  return {
    id: "m1",
    title: "Senior Engineer",
    company: "Acme",
    url: "https://jobs.example.com/m1",
    fit: 80,
    want: 70,
    fitReason: "Matches your stated skills.",
    wantReason: "Aligns with your stated priorities.",
    outsideFrame: false,
    state: "new",
    ...overrides
  };
}

// Mirrors board.test.tsx's own flatten/text helpers exactly — react-test-renderer's toJSON()
// tree nests text under `.children`, not `.props.children`.
function flatten(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(flatten).join(" ");
  if (typeof node === "object" && "children" in (node as { children?: unknown })) {
    return flatten((node as { children?: unknown }).children);
  }
  return "";
}

function text(renderer: ReactTestRenderer): string {
  return flatten(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

// A structural fake of the host's real AssistantSurfaceHandleV1 (module isolation forbids
// importing the host's own type from source) — submitTurn/setSurfaceKey are spies so the tests
// below can assert on calls without a real chat-surface test double.
function fakeAssistantSurface(): AssistantSurfaceHandleV1 & {
  setSurfaceKey: ReturnType<typeof vi.fn>;
  submitTurn: ReturnType<typeof vi.fn>;
} {
  return {
    setSurfaceKey: vi.fn(),
    seedContext: vi.fn(async () => undefined),
    seedComposer: vi.fn(),
    submitTurn: vi.fn(async () => undefined),
    Surface: () => null
  };
}

// useDiscuss is a hook — it can only run inside a component. This host renders nothing itself
// and just hands the latest hook result out to the test via onReady, called on every render.
function HookHost(props: {
  assistantSurface: AssistantSurfaceHandleV1 | undefined;
  onReady(result: UseDiscussResult): void;
}): null {
  const result = useDiscuss(props.assistantSurface);
  props.onReady(result);
  return null;
}

async function mountHook(
  assistantSurface: AssistantSurfaceHandleV1 | undefined
): Promise<{ renderer: ReactTestRenderer; current(): UseDiscussResult }> {
  let latest!: UseDiscussResult;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(HookHost, {
        assistantSurface,
        onReady: (result: UseDiscussResult) => {
          latest = result;
        }
      })
    );
  });
  return { renderer, current: () => latest };
}

describe("job-search discuss screen", () => {
  // Case 1/8: the card is built from the record's own fields, never posting prose — asserted
  // here by handing it an excess "body"-shaped field (what a two-param {match, posting} signature
  // would have supplied) and confirming the card never surfaces it, on top of confirming it does
  // render the fields it's documented to.
  it("MatchRecordCard renders the record's own fields, never a raw posting body", async () => {
    const withBody = { ...detail(), body: "RAW-POSTING-BODY-TEXT".repeat(20) } as MatchDetail & {
      body: string;
    };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(MatchRecordCard, { detail: withBody }));
    });
    const rendered = text(renderer);
    expect(rendered).toContain("Acme");
    expect(rendered).toContain("Senior Engineer");
    expect(renderer.root.findByType("h4").props.className.split(" ")).toContain("jds-card-title");
    expect(rendered).toContain("Matches your stated skills.");
    expect(rendered).toContain("Aligns with your stated priorities.");
    expect(rendered).not.toContain("RAW-POSTING-BODY-TEXT");
  });

  // Case 2/8.
  it('discuss() calls submitTurn with controlContext.action "discuss" and matching values.title', async () => {
    const surface = fakeAssistantSurface();
    const { current } = await mountHook(surface);
    await act(async () => {
      current().discuss(detail({ title: "Staff Engineer" }));
    });
    expect(surface.submitTurn).toHaveBeenCalledTimes(1);
    const call = surface.submitTurn.mock.calls[0][0] as {
      controlContext: { action: string; values: { title: string } };
    };
    expect(call.controlContext.action).toBe("discuss");
    expect(call.controlContext.values.title).toBe("Staff Engineer");
  });

  // Case 3/8: prompt-safety.ts's MODULE_CONTROL_KEYS accepts exactly step/action/values at the
  // top level — anything else is silently dropped, never rejected, so a stray key here would
  // fail quietly rather than loudly if this test didn't exist.
  it("controlContext carries only keys core accepts (step, action, values)", async () => {
    const surface = fakeAssistantSurface();
    const { current } = await mountHook(surface);
    await act(async () => {
      current().discuss(detail());
    });
    const call = surface.submitTurn.mock.calls[0][0] as { controlContext: Record<string, unknown> };
    for (const key of Object.keys(call.controlContext)) {
      expect(["step", "action", "values"]).toContain(key);
    }
  });

  // Case 4/8: MatchDetail carries no posting body at all — this proves that guarantee holds even
  // under an adversarial-sized field on the record (what a two-param signature's posting.body
  // would have been), by attaching a 20KB excess field and confirming it never reaches the wire.
  it("stays under the 8192-byte controlContext cap even with a 20KB body-like field on the record", async () => {
    const surface = fakeAssistantSurface();
    const { current } = await mountHook(surface);
    const huge = { ...detail(), body: "x".repeat(20000) } as MatchDetail & { body: string };
    await act(async () => {
      current().discuss(huge);
    });
    const call = surface.submitTurn.mock.calls[0][0] as { controlContext: Record<string, unknown> };
    const bytes = Buffer.byteLength(JSON.stringify(call.controlContext), "utf8");
    expect(bytes).toBeLessThan(8192);
  });

  // Case 5/8: localRows are client state and vanish on reload (discuss.tsx's own header) — the
  // turn text is what actually survives, so it must name the posting on its own.
  it("turn text names the posting (title and company)", async () => {
    const surface = fakeAssistantSurface();
    const { current } = await mountHook(surface);
    await act(async () => {
      current().discuss(detail({ title: "Staff Engineer", company: "Globex" }));
    });
    const call = surface.submitTurn.mock.calls[0][0] as { text: string };
    expect(call.text).toContain("Staff Engineer");
    expect(call.text).toContain("Globex");
  });

  // Case 6/8: bind-before-send is useProfileThread's job, done once before a board ever renders —
  // a second binder in Discuss is exactly how the drawer ends up pointed at the wrong thread.
  it("never calls setSurfaceKey", async () => {
    const surface = fakeAssistantSurface();
    const { current } = await mountHook(surface);
    await act(async () => {
      current().discuss(detail());
    });
    expect(surface.setSurfaceKey).not.toHaveBeenCalled();
  });

  // Case 7/8: Discuss is a chat write (submitTurn), not a queued command — unlike Dismiss, it has
  // no reason to ever touch runQueue. discuss.tsx doesn't even import api.ts, so this spy on the
  // real export is a regression guard against that ever changing silently.
  it("never routes through runQueue", async () => {
    const spy = vi.spyOn(api, "runQueue");
    const surface = fakeAssistantSurface();
    const { current } = await mountHook(surface);
    await act(async () => {
      current().discuss(detail());
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  // Case 8/8: no assistantSurface means Discuss cannot do anything real — a safe no-op, never a
  // throw, so board.tsx doesn't need its own try/catch around a call it already gates on presence.
  it("with no assistantSurface, discuss() is a safe no-op — no throw, no submitTurn", async () => {
    const { current } = await mountHook(undefined);
    await act(async () => {
      expect(() => current().discuss(detail())).not.toThrow();
    });
    expect(current().discussing).toBe("m1");
  });
});

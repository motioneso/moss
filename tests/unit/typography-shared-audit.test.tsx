// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EmptyState, Eyebrow, Masthead, MastheadDateline, Thread } from "@moss/ui";
import type { ModuleDto } from "@moss/shared";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { CommandPalette } from "../../apps/web/src/shell/command-palette.js";
import { buildCommandPaletteCommands } from "../../apps/web/src/shell/command-palette-model.js";

vi.mock("../../apps/web/src/api/use-assistant-name.js", () => ({
  useAssistantName: () => "Alfred"
}));

const read = (path: string) => readFileSync(resolve(path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const tokenBlock = /:root[^{]*\{([^}]+)\}/.exec(read("apps/web/src/styles/tokens.css"))?.[1] ?? "";
const tokens = new Map(
  [...tokenBlock.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!])
);

// jsdom does not resolve custom properties. Substitute the shipped root token values before
// asking its CSS cascade for computed typography; this does not establish browser layout.
function resolveTokens(value: string): string {
  return value.replace(/var\((--[\w-]+)\)/g, (original, name: string) => {
    const token = tokens.get(name);
    return token ? resolveTokens(token) : original;
  });
}

const sharedSheets = [
  "packages/ui/src/styles/components-core.css",
  "packages/ui/src/styles/components-moss.css",
  "packages/ui/src/styles/components-moss-today.css",
  "packages/ui/src/styles/components-chat.css",
  "packages/ui/src/styles/components-empty.css",
  "packages/ui/src/styles/components-settings-1.css",
  "packages/ui/src/styles/components-command-palette.css",
  "apps/web/src/styles/kit-chat.css"
];
let host: HTMLDivElement;
let style: HTMLStyleElement;
let root: Root | undefined;
let client: QueryClient | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  style = document.createElement("style");
  style.textContent = resolveTokens(sharedSheets.map(read).join("\n"));
  document.head.append(style);
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  act(() => root?.unmount());
  client?.clear();
  root = undefined;
  client = undefined;
  host.remove();
  style.remove();
  vi.unstubAllGlobals();
});

function computed(selector: string): CSSStyleDeclaration {
  const element = host.querySelector(selector);
  expect(element, selector).not.toBeNull();
  return getComputedStyle(element!);
}

function moduleFixture(id: string): ModuleDto {
  return { id, name: id, version: "0.0.0", lifecycle: "optional", navigation: [], settings: [] };
}

describe("shared typography audit", () => {
  it("keeps empty and source titles explicit across inherited and heading defaults", () => {
    style.textContent += ".audit-parent { font-weight:400; line-height:1.5; }";
    host.innerHTML = renderToStaticMarkup(
      <div className="audit-parent">
        <EmptyState title="No projects yet" />
        <h2 className="jds-empty__title">No meals yet</h2>
        <div className="chatd-empty__title">Choose a provider</div>
        <div className="source-tray__title">
          A long source title that can wrap while retaining the compact reading role
        </div>
      </div>
    );
    for (const selector of ["div.jds-empty__title", "h2.jds-empty__title", ".chatd-empty__title"]) {
      const title = computed(selector);
      expect(title.fontFamily).toContain("Archivo");
      expect(title.fontWeight).toBe("600");
      expect(title.lineHeight).toBe("1.15");
    }
    expect(computed("div.jds-empty__title").fontSize).toBe("21px");
    expect(computed(".chatd-empty__title").fontSize).toBe("19px");
    expect(computed(".source-tray__title").fontWeight).toBe("600");
    expect(computed(".source-tray__title").fontSize).toBe("17px");
    expect(computed(".source-tray__title").lineHeight).toBe("1.3");
  });

  it("uses one eyebrow role while preserving the named Masthead dateline treatment", () => {
    host.innerHTML = renderToStaticMarkup(
      <>
        <Eyebrow>Start here</Eyebrow>
        <span className="jds-eyebrow audit-raw-eyebrow">Section label</span>
        <Masthead eyebrow="Your projects" title="Workshop" />
        <MastheadDateline>Thursday, 15 October</MastheadDateline>
      </>
    );
    const eyebrow = computed(".jds-eyebrow");
    const masthead = computed(".jds-masthead__eyebrow");
    for (const role of [eyebrow, computed(".audit-raw-eyebrow"), masthead]) {
      expect(role.fontSize).toBe("11px");
      expect(role.fontWeight).toBe("700");
      expect(parseFloat(role.letterSpacing)).toBeCloseTo(0.99);
      expect(role.textTransform).toBe("uppercase");
      expect(role.fontFamily).toBe(eyebrow.fontFamily);
    }
    expect(computed(".jds-masthead__dateline").fontSize).toBe("12px");
    expect(parseFloat(computed(".jds-masthead__dateline").letterSpacing)).toBeCloseTo(2.16);
  });

  it("keeps semantic block and settings headings at their existing geometry", () => {
    host.innerHTML =
      '<h2 class="jds-brief__title">Long-term goals</h2><h3 class="pane__cardtitle">Permissions</h3>';
    for (const selector of [".jds-brief__title", ".pane__cardtitle"]) {
      expect(computed(selector).marginTop).toBe("0px");
      expect(computed(selector).marginBottom).toBe("0px");
    }
    expect(computed(".jds-brief__title").fontSize).toBe("24px");
    expect(computed(".jds-brief__title").fontWeight).toBe("600");
    expect(computed(".pane__cardtitle").fontSize).toBe("20px");
    expect(computed(".pane__cardtitle").fontWeight).toBe("800");
  });

  it("renders all Markdown heading depths above the floor even in a small parent", () => {
    style.textContent += ".audit-small { font-size:9px; }";
    const headings = Array.from(
      { length: 6 },
      (_, index) => `${"#".repeat(index + 1)} Level ${index + 1}`
    );
    host.innerHTML = renderToStaticMarkup(
      <div className="audit-small">
        <Thread
          records={[
            {
              kind: "reply",
              text: `${headings.join("\n\n")}\n\n- Outer\n  - Nested\n\n| Name | Value |\n| --- | --- |\n| Item | One |\n\nInline \`code\`.\n\n\`\`\`js\nconst n = 1;\n\`\`\``
            }
          ]}
        />
      </div>
    );
    for (let depth = 1; depth <= 6; depth += 1) {
      const title = computed(`.chatd-md h${depth}`);
      expect(title.fontSize).toMatch(/^\d+(\.\d+)?px$/);
      expect(parseFloat(title.fontSize)).toBeGreaterThanOrEqual(11);
      expect(title.lineHeight).toBe("1.3");
      if (depth > 1) expect(title.marginTop).toBe("16px");
      expect(title.marginBottom).toBe("8px");
      expect(host.querySelector(`h${depth}`)?.textContent).toBe(`Level ${depth}`);
    }
    expect(host.querySelector("ul ul li")?.textContent).toBe("Nested");
    expect(host.querySelector("table td")?.textContent).toBe("Item");
    expect(host.querySelector("p code")?.textContent).toBe("code");
    expect(host.querySelector("pre code")?.textContent).toContain("const n = 1;");
  });

  it("keeps palette hints above the floor and names task-list no-results in its own stage", async () => {
    client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } }
    });
    client.setQueryData(queryKeys.tasks.lists, { lists: [{ id: "work", name: "Work" }] });
    root = createRoot(host);
    await act(async () =>
      root?.render(
        <QueryClientProvider client={client!}>
          <CommandPalette
            modules={[moduleFixture("tasks")]}
            disabledModuleIds={[]}
            themes={undefined}
            navigate={() => undefined}
          />
        </QueryClientProvider>
      )
    );
    act(() => window.dispatchEvent(new Event("jarvis:open-command-palette")));
    for (const selector of [".kbar__esc", ".kbar__group", ".kbar__foot kbd"]) {
      expect(computed(selector).fontSize).toBe("11px");
    }
    const input = host.querySelector("input")!;
    function search(value: string) {
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          value
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    search("no such command");
    expect(host.querySelector(".kbar__empty")?.textContent).toBe("No matching commands.");
    search("Create task");
    act(() => host.querySelector<HTMLElement>('[role="option"]')!.click());
    expect(host.querySelector(".kbar__group")?.textContent).toBe("Task lists");
    search("no such list");
    expect(host.querySelector(".kbar__empty")?.textContent).toBe("No matching task lists.");
  });

  it("describes settings destinations in user terms and keeps the configured assistant name", () => {
    const commands = buildCommandPaletteCommands({
      assistantName: "Alfred",
      modules: [moduleFixture("tasks"), moduleFixture("notifications")],
      disabledModuleIds: [],
      themes: undefined
    });
    expect(commands.find((command) => command.id === "task:settings")?.description).toBe(
      "Choose what Alfred can do with your tasks"
    );
    expect(commands.find((command) => command.id === "settings:modules")?.description).toBe(
      "Manage the features you've turned on"
    );
    expect(commands.find((command) => command.id === "settings:notifications")?.description).toBe(
      "Choose which alerts you get"
    );
  });
});

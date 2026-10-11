// Shared setup for the #2984 R2.6 live proof. A plain module, not a spec.
//
// The stand-in tool server is tests/uat/fixtures/classifier-mcp-fixture-server.ts, run on the
// host. Its control routes set the tool list and read back every call that reached it.
import { readFileSync } from "node:fs";

import { expect, type Page } from "@playwright/test";
import type {
  IntegrationClassifierToolSort,
  IntegrationDetail,
  ListIntegrationsResponse
} from "../../packages/shared/src/integrations-api.js";
import {
  defaultFixtureTools,
  type FixtureCall,
  type FixtureTool
} from "../uat/fixtures/classifier-mcp-fixture-server.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`set ${name} before running the R2.6 live proof`);
  return value;
}

export const R26 = {
  get ownerEmail() {
    return required("LIVE_OWNER_EMAIL");
  },
  get ownerPassword() {
    return required("LIVE_OWNER_PASSWORD");
  },
  get toolServer() {
    return required("LIVE_R26_TOOL_SERVER");
  },
  get shotDir() {
    return process.env.LIVE_R26_SHOT_DIR ?? "/tmp/build-2984-r26";
  }
};

/** Made on the old code before the upgrade. */
export const OLD_HUB = "Old smart hub";
/** Made on current main after the upgrade. */
export const NEW_HUB = "New smart hub";

export const NOTIFY_TOOL = "send_phone_notification";
export const EMAIL_TOOL = "email_hub_report";
export const RESET_TOOL = "factory_reset_hub";

export const SIZES = [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }]
] as const;

/** The stand-in hub's four tools plus two sending tools and a destructive reset. */
export function r26ToolList(): FixtureTool[] {
  return [
    ...defaultFixtureTools(),
    {
      name: NOTIFY_TOOL,
      description: "Send a push notification to the owner's phone.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string", description: "The text to send." } }
      },
      annotations: { openWorldHint: true }
    },
    {
      name: EMAIL_TOOL,
      description: "Email a status report about the hub to any email address.",
      inputSchema: {
        type: "object",
        properties: { to: { type: "string", description: "The address to email." } }
      },
      annotations: { openWorldHint: true }
    },
    {
      name: RESET_TOOL,
      description: "Erase every device, automation and setting on the hub permanently.",
      inputSchema: { type: "object", properties: {} },
      annotations: { destructiveHint: true }
    }
  ];
}

export async function setToolServerTools(tools: readonly FixtureTool[]): Promise<void> {
  const response = await fetch(`${R26.toolServer}/__control/tools`, {
    method: "POST",
    body: JSON.stringify(tools)
  });
  expect(response.ok, "the tool server accepted the tool list").toBe(true);
}

export async function toolServerCalls(tool: string): Promise<readonly FixtureCall[]> {
  const state = (await (await fetch(`${R26.toolServer}/__control/state`)).json()) as {
    calls: readonly FixtureCall[];
  };
  return state.calls.filter((call) => call.tool === tool);
}

/** Puts every stand-in device back to off, so a door shows unlocked only after the turn under test. */
export async function switchAllDevicesOff(): Promise<void> {
  const response = await fetch(`${R26.toolServer}/__control/devices`, {
    method: "POST",
    body: JSON.stringify([
      { id: "light.kitchen", name: "Kitchen light", on: false },
      { id: "light.porch", name: "Porch light", on: false },
      { id: "lock.front", name: "Front door", on: false }
    ])
  });
  expect(response.ok, "the tool server reset its devices").toBe(true);
}

/** Whether the stand-in tool server holds the named device switched on (a door counts as unlocked). */
export async function deviceOn(name: string): Promise<boolean> {
  const state = (await (await fetch(`${R26.toolServer}/__control/state`)).json()) as {
    devices: readonly { name: string; on: boolean }[];
  };
  return state.devices.find((device) => device.name === name)?.on === true;
}

export async function connectionId(page: Page, name: string): Promise<string> {
  const list = (await (
    await page.request.get("/api/integrations")
  ).json()) as ListIntegrationsResponse;
  const id = list.integrations.find((row) => row.name === name)?.id;
  if (!id) throw new Error(`no connection named ${name}`);
  return id;
}

export async function readDetail(page: Page, name: string): Promise<IntegrationDetail> {
  const id = await connectionId(page, name);
  const response = await page.request.get(`/api/integrations/${id}`);
  expect(response.ok(), `GET /api/integrations/${id} -> ${response.status()}`).toBe(true);
  return (await response.json()) as IntegrationDetail;
}

export function sortOf(detail: IntegrationDetail, tool: string): IntegrationClassifierToolSort {
  const sort = detail.classifierTools.find((entry) => entry.toolName === tool);
  if (!sort) throw new Error(`no sort record for ${tool}`);
  return sort;
}

export async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Email").fill(R26.ownerEmail);
  await page.getByLabel("Password").fill(R26.ownerPassword);
  await page.locator("form").getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: /^Account menu(?:,|$)/ })).toBeVisible({
    timeout: 30_000
  });
}

export async function openConnection(page: Page, name: string): Promise<void> {
  await page.goto("/settings?section=connections");
  await page
    .locator(".set-row", { hasText: name })
    .first()
    .getByRole("button", { name: "Configure" })
    .click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

/** Within each control strip, same-line neighbours sit at least 8px apart and no text is under 11px. */
export async function assertNoCrowding(page: Page, label: string): Promise<void> {
  const problems = await page.evaluate(() => {
    const found: string[] = [];
    const strips = document.querySelectorAll(
      ".intg-tools__acts, .intg-tools__ctl, .intg__controls, .intg__acts, .intg-tools__bar, .intg-clsf"
    );
    for (const strip of strips) {
      const kids = [...strip.children]
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && r.height > 0);
      for (let i = 0; i < kids.length; i++) {
        for (let j = i + 1; j < kids.length; j++) {
          const a = kids[i]!.r;
          const b = kids[j]!.r;
          if (!(a.top < b.bottom && b.top < a.bottom)) continue;
          const gap = Math.max(b.left - a.right, a.left - b.right);
          if (gap < 7.5) found.push(`${strip.className}: ${gap.toFixed(1)}px`);
        }
      }
    }
    const root = document.querySelector(".set2") ?? document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !node.textContent?.trim()) continue;
      const rect = parent.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const size = Number.parseFloat(getComputedStyle(parent).fontSize);
      if (size < 11) found.push(`text "${node.textContent.trim()}" at ${size}px`);
    }
    return found;
  });
  expect(problems, `crowding at ${label}`).toEqual([]);
}

/** Desktop and phone pictures of the current page, each after the crowding check. */
export async function shootBoth(page: Page, name: string): Promise<void> {
  for (const [size, viewport] of SIZES) {
    await page.setViewportSize(viewport);
    await assertNoCrowding(page, `${name} ${size}`);
    await page.screenshot({ path: `${R26.shotDir}/${name}-${size}.png`, fullPage: true });
  }
  await page.setViewportSize(SIZES[0][1]);
}

export interface SortRun {
  readonly op: string;
  readonly status: string;
  readonly calls?: number;
  readonly written?: number;
}

/**
 * The worker's own "tool sorting finished" lines for one connection, in order. The worker log
 * is the run's record of how many model calls each sort made.
 */
export function sortRuns(connectionId: string): SortRun[] {
  const path = process.env.LIVE_R26_WORKER_LOG;
  if (!path) throw new Error("set LIVE_R26_WORKER_LOG to the worker's log file");
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.includes('"integrations: tool sorting finished"'))
    .map((line) => JSON.parse(line) as SortRun & { connectionId: string })
    .filter((line) => line.connectionId === connectionId)
    .map(({ op, status, calls, written }) => ({ op, status, calls, written }));
}

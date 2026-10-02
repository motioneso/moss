import { createHash } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// Classifier gate 2b.4 (#2899): proves the real connection-detail classifier section on a live
// instance. No chat-capable model exists at any UAT seed level (#1121), so the prepare path is
// exercised as the honest setup-failure branch, and the reviewed entry is seeded through the same
// real PUT the screen uses (fingerprint computed here exactly as
// packages/integrations/src/classifier-fingerprint.ts does). This proves the screen path, the
// consent contract (the connection switch never opts a tool in) and persistence across reload.
//
// 2b.6 assembles the full connect -> prepare -> approve -> shadow proof; this spec is the 2b.4
// UI half and is named so the two do not collide.
export const uatLevel = { level: "solo-admin", without: [] } as const;

const BASE = process.env.JARVIS_UAT_BASE_URL;

function requireBaseURL(): string {
  if (!BASE) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return BASE;
}

async function signIn(page: Page): Promise<void> {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.locator(".jds-usermenu__trigger");
  await expect(skipSetup.or(userMenu).first()).toBeVisible();
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(userMenu).toBeVisible();
}

const SPEC = {
  openapi: "3.0.0",
  info: { title: "Home hub", version: "1" },
  paths: {
    "/lights": {
      get: {
        operationId: "list_lights",
        summary: "List all lights",
        tags: ["Lights"]
      }
    }
  }
};

interface DetailTool {
  readonly name: string;
  readonly description: string;
  readonly group: string;
  readonly inputSchema: unknown;
  readonly readOnly?: boolean;
  readonly idempotent?: boolean;
  readonly destructive?: boolean;
}

interface Detail {
  readonly id: string;
  readonly classifierEnabled: boolean;
  readonly classifierPreparation: readonly { readonly toolName: string; readonly optIn: boolean }[];
  readonly tools: readonly DetailTool[];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Mirror of toolDefinitionFingerprint (packages/integrations/src/classifier-fingerprint.ts). */
function fingerprint(tool: DetailTool): string {
  const canonical = JSON.stringify(
    canonicalize({
      name: tool.name,
      description: tool.description,
      group: tool.group,
      inputSchema: tool.inputSchema,
      readOnly: tool.readOnly ?? null,
      idempotent: tool.idempotent ?? null,
      destructive: tool.destructive ?? null
    })
  );
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

async function fetchDetail(page: Page, id: string): Promise<Detail> {
  const detail = await page.evaluate(async (connectionId) => {
    const response = await fetch(`/api/integrations/${connectionId}`, {
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw new Error(`GET detail -> ${response.status}`);
    return response.json();
  }, id);
  return detail as Detail;
}

test("reviewed classifier switches on a real connection (#2899)", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await page.goto(`${requireBaseURL()}/settings?section=integrations`);
  await expect(page.getByRole("button", { name: "Add connection" })).toBeVisible();

  // 1. Add a connection through the real screen, pasting a spec so no network is needed.
  await page.getByRole("button", { name: "Add connection" }).click();
  await page.getByRole("group", { name: "Kind" }).getByRole("button", { name: "API" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Home hub");
  await page.getByLabel("URL", { exact: true }).fill("http://home.local");
  await page.getByRole("button", { name: "Paste the spec" }).click();
  await page.getByLabel("Spec", { exact: true }).fill(JSON.stringify(SPEC));
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  await expect(page.getByText("list_lights").first()).toBeVisible();
  const url = new URL(page.url());
  const id = url.searchParams.get("integration");
  expect(id, "the connection detail opens at ?integration=<id>").toBeTruthy();
  const connectionId = id as string;

  // 2. The ordinary controls are present and untouched before any classifier interaction. The
  //    switch input is visually hidden inside its track, so assert state, not visibility.
  await expect(page.getByRole("checkbox", { name: "Enable list_lights" })).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Allow repeated identical calls to list_lights" })
  ).not.toBeChecked();

  // 3. The classifier section starts off, with its disclosure visible before any model request.
  const classifierSwitch = page.getByRole("checkbox", {
    name: "Let the classifier use this connection"
  });
  await expect(classifierSwitch).not.toBeChecked();
  await expect(
    page.getByText("Messages and device names go to the classifier provider.")
  ).toBeVisible();
  await expect(page.getByText("What is sent, and what it costs")).toBeVisible();

  // 4. Keyboard: focus the switch and toggle it with Space; it persists across a reload.
  await classifierSwitch.focus();
  await page.keyboard.press("Space");
  await expect(classifierSwitch).toBeChecked();
  await page.reload();
  await expect(
    page.getByRole("checkbox", { name: "Let the classifier use this connection" })
  ).toBeChecked();

  // 5. Prepare with no default chat model: the setup failure is named, the fix is linked, and
  //    nothing is stored. The connection switch did not opt the tool in by itself.
  await page.getByRole("button", { name: "Prepare 1 tool" }).click();
  await expect(page.getByText("No default chat model is set.")).toBeVisible();
  await expect(page.getByRole("link", { name: /structured output/ })).toBeVisible();
  await expect(page.getByText("Nothing changed.")).toBeVisible();
  let detail = await fetchDetail(page, connectionId);
  expect(detail.classifierPreparation).toHaveLength(0);

  // 6. Seed one reviewed, opted-in entry through the same real PUT the screen uses.
  const tool = detail.tools.find((candidate) => candidate.name === "list_lights");
  expect(tool, "the discovered tool is present").toBeTruthy();
  const reviewedFingerprint = fingerprint(tool as DetailTool);
  const putStatus = await page.evaluate(
    async ({ connectionId: cid, toolName, fp }) => {
      const response = await fetch(
        `/api/integrations/${cid}/classifier/tools/${encodeURIComponent(toolName)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            optIn: true,
            reviewedRisk: "read",
            description: "List all the lights.",
            arguments: {},
            replyTemplate: "Listed the lights.",
            reviewedFingerprint: fp
          })
        }
      );
      return response.status;
    },
    { connectionId, toolName: "list_lights", fp: reviewedFingerprint }
  );
  expect(putStatus).toBe(200);

  await page.goto(`${requireBaseURL()}/settings?section=integrations&integration=${connectionId}`);
  await expect(page.getByText("Approved")).toBeVisible();
  await expect(page.getByText("Risk: Only reads")).toBeVisible();
  const toolSwitch = page.getByRole("checkbox", { name: "Classifier may use list_lights" });
  await expect(toolSwitch).toBeChecked();

  // 7. A stale save (an old tab) is rejected with 409 and stores nothing.
  const staleStatus = await page.evaluate(
    async ({ connectionId: cid }) => {
      const response = await fetch(`/api/integrations/${cid}/classifier/tools/list_lights`, {
        method: "PUT",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          optIn: true,
          reviewedRisk: "read",
          description: "A superseded draft.",
          arguments: {},
          replyTemplate: "Superseded.",
          reviewedFingerprint: "sha256:superseded"
        })
      });
      return response.status;
    },
    { connectionId }
  );
  expect(staleStatus).toBe(409);

  // 8. Opt out through the real screen switch, and prove it persisted on reload. The switch input
  //    is visually hidden, so toggle it by keyboard (focus + Space), which is also the access path.
  await toolSwitch.focus();
  await page.keyboard.press("Space");
  await expect(toolSwitch).not.toBeChecked();
  await page.reload();
  await expect(
    page.getByRole("checkbox", { name: "Classifier may use list_lights" })
  ).not.toBeChecked();

  // 9. Remove the review through the screen; the section returns to not-prepared.
  await page.getByRole("button", { name: "Remove list_lights review" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
  await page.goto(`${requireBaseURL()}/settings?section=integrations&integration=${connectionId}`);
  await expect(page.getByText("Not prepared")).toBeVisible();
  detail = await fetchDetail(page, connectionId);
  expect(detail.classifierPreparation).toHaveLength(0);

  // 10. The ordinary controls are still exactly as they were.
  await expect(page.getByRole("checkbox", { name: "Enable list_lights" })).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Allow repeated identical calls to list_lights" })
  ).not.toBeChecked();
});

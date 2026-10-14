import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { buildUatComposeArgs } from "../provisioner.js";
import { UAT_ADMIN_ID } from "../seed/admin.js";
import {
  readUatJson,
  requireUatBaseURL,
  requireUatProjectName,
  signInUatAdmin
} from "./real-chat-signin.js";

export const uatLevel = { level: "admin+data", without: ["finance"] } as const;

function controlApp(project: string, args: readonly string[]) {
  execFileSync("docker", buildUatComposeArgs(project, [...args, "jarv1s"]), {
    stdio: "inherit"
  });
}

// Deliberately stops only this provisioned UAT service, never a shared dev instance. Moss's
// responses are not intercepted, replayed or rewritten. Existing synthetic notes are the input.
test("source changes and resumed archives tell the truth through real interruptions (#3397)", async ({
  page
}) => {
  test.setTimeout(300_000);
  const project = requireUatProjectName();
  const noteRoot = `/data/vaults/${UAT_ADMIN_ID}`;
  let appStopped = false;
  let appPaused = false;
  let exportPosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/me/export") {
      exportPosts += 1;
    }
  });

  try {
    await signInUatAdmin(page);
    await readUatJson(await page.request.put("/api/me/notes-source", { data: { path: null } }));
    await page.goto(`${requireUatBaseURL()}/settings?section=modules`);
    const categories = page.getByRole("navigation", { name: "Settings categories" });
    await expect(categories).toBeVisible();

    // Warm the lazy Connections code through its real UI before stopping the service.
    // The remount then fails an actual source refresh with a cached unlinked source;
    // a service outage must not be confused with a missing JavaScript chunk.
    await categories.getByRole("button", { name: "Connections" }).click();
    const source = page.locator(".vault");
    await expect(source.getByText("No folder linked", { exact: true })).toBeVisible();
    await categories.getByRole("button", { name: "Modules" }).click();
    controlApp(project, ["stop"]);
    appStopped = true;
    // The real app keeps successful queries fresh for 15s and disables focus refetch.
    // Wait for wall-clock expiry before remount, then observe the actual outage GET.
    await page.waitForTimeout(16_000);
    const sourceRefresh = page.waitForRequest(
      (request) =>
        request.method() === "GET" && new URL(request.url()).pathname === "/api/me/notes-source"
    );
    await categories.getByRole("button", { name: "Connections" }).click();
    await sourceRefresh;
    await expect(source.getByText("Couldn't check linked folder")).toBeVisible();
    await expect(source.getByText("No folder linked", { exact: true })).toHaveCount(0);
    await expect(source.getByRole("button", { name: "Browse…" })).toBeDisabled();
    controlApp(project, ["up", "-d", "--no-deps", "--no-recreate", "--wait"]);
    appStopped = false;
    await source.getByRole("button", { name: "Try again" }).click();
    await expect(source.getByText("No folder linked", { exact: true })).toBeVisible();

    // Use the real folder chooser, then verify the persisted source independently.
    await source.getByRole("button", { name: "Browse…" }).click();
    await page.locator(".vroot").filter({ hasText: noteRoot }).click();
    await page.getByRole("button", { name: "Use this folder" }).click();
    await expect(source.locator(".vault__path")).toHaveText(noteRoot);
    expect(await readUatJson(await page.request.get("/api/me/notes-source"))).toEqual({
      path: noteRoot
    });

    // A real paused server leaves the write pending. No success is announced until it resumes.
    controlApp(project, ["pause"]);
    appPaused = true;
    await source.getByRole("button", { name: "Unlink", exact: true }).click();
    const unlinkConfirm = page.getByRole("dialog", { name: "Unlink this folder?" });
    await unlinkConfirm.getByRole("button", { name: "Unlink", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(source.getByRole("button", { name: "Unlinking…" })).toBeDisabled();
    await expect(source.getByRole("button", { name: "Sync now" })).toBeDisabled();
    await expect(page.getByText("Folder unlinked", { exact: true })).toHaveCount(0);
    await expect(source.locator(".vault__path")).toHaveText(noteRoot);
    controlApp(project, ["unpause"]);
    appPaused = false;
    await expect(source.getByText("No folder linked", { exact: true })).toBeVisible();
    expect(await readUatJson(await page.request.get("/api/me/notes-source"))).toEqual({
      path: null
    });

    // Re-link only this synthetic folder to verify the rejection path against a real outage.
    await readUatJson(await page.request.put("/api/me/notes-source", { data: { path: noteRoot } }));
    await page.reload();
    await expect(source.locator(".vault__path")).toHaveText(noteRoot);
    controlApp(project, ["stop"]);
    appStopped = true;
    await source.getByRole("button", { name: "Unlink", exact: true }).click();
    await unlinkConfirm.getByRole("button", { name: "Unlink", exact: true }).click();
    await expect(source.getByRole("button", { name: "Unlink", exact: true })).toBeEnabled();
    await expect(source.locator(".vault__path")).toHaveText(noteRoot);
    await expect(page.getByText("Folder unlinked", { exact: true })).toHaveCount(0);
    controlApp(project, ["up", "-d", "--no-deps", "--no-recreate", "--wait"]);
    appStopped = false;
    expect(await readUatJson(await page.request.get("/api/me/notes-source"))).toEqual({
      path: noteRoot
    });

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(source.locator(".vault__path")).toHaveText(noteRoot);
      await expect(source.getByRole("button", { name: "Unlink", exact: true })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true);
    }

    await page.setViewportSize({ width: 1280, height: 800 });

    // Real export worker and same-job recovery after a status-read failure.
    await categories.getByRole("button", { name: "Account & preferences" }).click();
    await page.getByRole("button", { name: "Prepare export" }).click();
    const downloadLink = page.getByRole("link", { name: "Download", exact: true });
    await expect(downloadLink).toBeVisible({ timeout: 60_000 });
    const jobId = await page.evaluate(() =>
      window.sessionStorage.getItem("moss.settings.export-job-id")
    );
    expect(jobId).not.toBeNull();
    await categories.getByRole("button", { name: "Modules" }).click();
    controlApp(project, ["stop"]);
    appStopped = true;
    await page.waitForTimeout(16_000);
    const exportRefresh = page.waitForRequest(
      (request) =>
        request.method() === "GET" &&
        new URL(request.url()).pathname === `/api/me/export/status/${jobId}`
    );
    await categories.getByRole("button", { name: "Account & preferences" }).click();
    await exportRefresh;
    await expect(page.getByText(/Couldn't check your export/)).toBeVisible({
      timeout: 30_000
    });
    await expect(downloadLink).toHaveCount(0);
    expect(
      await page.evaluate(() => window.sessionStorage.getItem("moss.settings.export-job-id"))
    ).toBe(jobId);
    expect(exportPosts).toBe(1);
    controlApp(project, ["up", "-d", "--no-deps", "--no-recreate", "--wait"]);
    appStopped = false;
    await page
      .locator("section")
      .filter({ has: page.getByText("Your data", { exact: true }) })
      .getByRole("button", { name: "Try again", exact: true })
      .click();
    await expect(downloadLink).toBeVisible();
    expect(exportPosts).toBe(1);
    await expect(downloadLink).toHaveAttribute("href", `/api/me/export/download/${jobId}`);

    const downloadPromise = page.waitForEvent("download");
    await downloadLink.click();
    const download = await downloadPromise;
    const downloadedPath = await download.path();
    expect(downloadedPath).not.toBeNull();
    const archive = JSON.parse(await readFile(downloadedPath!, "utf8")) as {
      format: string;
      userId: string;
      sections: {
        vault_files: Array<{
          path: string;
          encoding: string;
          content: string;
          byteLength: number;
          sha256: string;
        }>;
      };
      manifest: { vaultFiles: { scope: string; includedCount: number; limitations: string[] } };
    };
    expect(archive.format).toBe("jarvis-archive/v1");
    expect(archive.userId).toBe(UAT_ADMIN_ID);
    const welcome = archive.sections.vault_files.find((file) => file.path === "welcome.md");
    expect(welcome).toBeDefined();
    expect(welcome!.encoding).toBe("base64");
    const bytes = Buffer.from(welcome!.content, "base64");
    expect(bytes.toString("utf8")).toBe(
      "# Welcome\n\nThis is a seeded UAT note for the lived-in demo account.\n"
    );
    expect(welcome!.byteLength).toBe(bytes.byteLength);
    expect(welcome!.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(archive.sections.vault_files.map((file) => file.path)).toContain(
      "meeting-notes/2026-01-10-kickoff.md"
    );
    expect(archive.manifest.vaultFiles.scope).toBe("owned-markdown");
    expect(archive.manifest.vaultFiles.includedCount).toBe(archive.sections.vault_files.length);
    expect(archive.manifest.vaultFiles.limitations.join(" ")).toContain("linked");
    expect(archive.sections.vault_files.some((file) => file.path.startsWith("exports/"))).toBe(
      false
    );

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true);
      await expect(downloadLink).toBeVisible();
    }
  } finally {
    if (appPaused) controlApp(project, ["unpause"]);
    if (appStopped) controlApp(project, ["up", "-d", "--no-deps", "--no-recreate", "--wait"]);
  }
});

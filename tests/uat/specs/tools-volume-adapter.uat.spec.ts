import { execFileSync } from "node:child_process";

import { expect, test, type Page } from "@playwright/test";
import {
  bringUpRealChatModel,
  readUatJson,
  requireUatProjectName,
  signInUatAdmin
} from "./real-chat-signin.js";
import { uatRealChatProvider } from "../real-chat-env.js";

// #2689 slice 2: chat runs the Codex chat adapter from the tools volume when it is installed, and
// from the image copy once it is gone. Opt-in like real-chat-onboarding: needs the operator's own
// Codex login, so it skips on every default/CI run.
export const uatLevel = { level: "solo-admin", without: [] } as const;

const REAL_CHAT_CONFIGURED = Boolean(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED);
// The adapter under test belongs to the Codex CLI; a Claude run never starts it.
const CODEX_SELECTED = uatRealChatProvider() === "codex";
const SCAN = String.raw`for d in /proc/[0-9]*; do tr '\0' ' ' < $d/cmdline 2>/dev/null | grep -q "codex-acp/dist/index[.]js" && echo $d | cut -d/ -f3; done; true`;
const ADAPTER_SLOT = "/data/cli-tools/providers/openai-compatible-adapter";

function inStack(...command: string[]): string {
  const container = `${requireUatProjectName()}-jarv1s-1`;
  return execFileSync("docker", ["exec", container, ...command], { encoding: "utf8" });
}

/** Command lines of running Codex adapter processes. */
function adapterProcesses(): Array<{ args: string }> {
  return inStack("sh", "-c", SCAN)
    .split("\n")
    .filter(Boolean)
    .map((pid) => ({ args: inStack("sh", "-c", `tr '\\0' ' ' < /proc/${pid}/cmdline`).trim() }))
    .filter((p) => p.args.includes("codex-acp/dist/index.js"));
}

/** Command lines of running processes started from the tools-volume Codex CLI (what CODEX_PATH points at). */
function volumeCodexProcesses(): string[] {
  const scan = String.raw`for d in /proc/[0-9]*; do c=$(tr '\0' ' ' < $d/cmdline 2>/dev/null); case "$c" in */data/cli-tools/providers/openai-compatible/releases/*) echo "$c";; esac; done; true`;
  return inStack("sh", "-c", scan).split("\n").filter(Boolean);
}

async function turn(page: Page): Promise<void> {
  const body = (await readUatJson(
    await page.request.post("/api/chat/turn", {
      data: { text: "Reply with exactly the three words: adapter path works." }
    })
  )) as { reply?: string };
  expect((body.reply ?? "").trim().length, "chat turn reply was empty").toBeGreaterThan(0);
}

test("chat answers through the tools volume adapter, then through the image copy once it is deleted", async ({
  page
}) => {
  test.skip(
    !REAL_CHAT_CONFIGURED || !CODEX_SELECTED,
    "needs the Codex real-chat login for this run (#2689)"
  );
  test.setTimeout(300_000);
  await signInUatAdmin(page);
  await bringUpRealChatModel(page);

  // 1. Installed on the volume: the provider install also put the adapter there.
  console.log(
    "[proof] adapter slot:\n" + inStack("ls", "-l", ADAPTER_SLOT, `${ADAPTER_SLOT}/releases`)
  );
  await turn(page);
  const viaVolume = adapterProcesses();
  console.log("[proof] running adapter (volume):", JSON.stringify(viaVolume));
  expect(viaVolume.length, "no Codex adapter process found after a turn").toBeGreaterThan(0);
  for (const p of viaVolume) {
    expect(p.args).toContain(`${ADAPTER_SLOT}/releases/`);
  }
  const cliProcs = volumeCodexProcesses();
  console.log("[proof] processes running the tools-volume Codex CLI:", JSON.stringify(cliProcs));
  expect(cliProcs.length, "no process runs the tools-volume Codex CLI").toBeGreaterThan(0);

  // 2. Delete the adapter and stop the running one; the next turn must start a fresh adapter.
  // The slot belongs to the runner's own account, and the container's root has no override rights.
  execFileSync("docker", [
    "exec",
    "-u",
    "node",
    `${requireUatProjectName()}-jarv1s-1`,
    "rm",
    "-rf",
    ADAPTER_SLOT
  ]);
  inStack("sh", "-c", `for p in $(${SCAN}); do kill $p; done; sleep 2; true`);
  // A new conversation makes chat start a fresh adapter instead of reusing the killed one.
  const cleared = await page.request.post("/api/chat/clear");
  expect(cleared.status(), "clearing the conversation failed").toBeLessThan(300);
  await turn(page);
  const viaImage = adapterProcesses();
  console.log("[proof] running adapter (after delete):", JSON.stringify(viaImage));
  expect(viaImage.length, "no Codex adapter process found after the fallback turn").toBeGreaterThan(
    0
  );
  for (const p of viaImage) {
    expect(p.args).not.toContain("/data/cli-tools/");
    expect(p.args).toContain("codex-acp/dist/index.js");
  }
});

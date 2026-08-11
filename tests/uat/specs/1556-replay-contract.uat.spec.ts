import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

const execFileAsync = promisify(execFile);

// #1556 Phase 1: live-path proof for the replay contract (D1-D4, D8) — a forced relaunch past
// the default replay window must still answer a continuity question about an early turn, add
// zero visible turns of its own (spec AC-5), and log chat.replay.injected with trigger:relaunch.
// Needs a real, instruction-following chat model (same gap real-chat-onboarding.uat.spec.ts
// documents), so this reuses that spec's REAL_CHAT_CONFIGURED gate rather than the fake provider.
export const uatLevel = { level: "solo-admin", without: [] } as const;

const REAL_CHAT_CONFIGURED = Boolean(process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE);

const POLL_DEADLINE_MS = 60_000;
const POLL_INITIAL_INTERVAL_MS = 500;
const POLL_MAX_INTERVAL_MS = 4_000;

// packages/chat/src/live/replay-window.ts DEFAULT_REPLAY_MESSAGES=40 (messages, i.e. user+
// assistant pairs). 45 turns = ~90 stored messages, clearing that write-gate threshold with
// margin so the turn-1 fact falls out of the recent window and must come back via the summary.
const SEED_TURN_COUNT = 45;
const DISTINCTIVE_FACT_TOKEN = "Zippledorf-7734";

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) {
    throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }
  return baseURL;
}

function requireProjectName(): string {
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!projectName) {
    throw new Error("JARVIS_UAT_PROJECT_NAME must be set by run-uat.ts");
  }
  return projectName;
}

// Copied (not imported) from real-chat-onboarding.uat.spec.ts — same reason that file gives for
// copying from runtime-context.uat.spec.ts: importing across spec files would also register the
// source file's top-level test() calls here.
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

interface ConfiguredModel {
  readonly capabilities: readonly string[];
  readonly status: string;
}

function hasChatCapableActiveModel(models: readonly ConfiguredModel[]): boolean {
  return models.some((model) => model.status === "active" && model.capabilities.includes("chat"));
}

async function readJson(response: APIResponse): Promise<unknown> {
  expect(response.ok(), `${response.url()} -> ${response.status()}`).toBeTruthy();
  return response.json();
}

test("forced relaunch replays prior context and answers a continuity question (#1556)", async ({
  page
}) => {
  test.skip(
    !REAL_CHAT_CONFIGURED,
    "no real-chat token configured for this run (JARVIS_UAT_REAL_CHAT_ENV_FILE unset) — #1556"
  );
  // 45 sequential real-model turns plus relaunch and a continuity turn, all serial round-trips.
  test.setTimeout(900_000);

  const projectName = requireProjectName();

  await signIn(page);

  const beginBody = (await readJson(
    await page.request.post("/api/onboarding/provider-login/begin", {
      data: { providerKind: "anthropic" }
    })
  )) as { status?: string };
  expect(
    beginBody.status,
    `provider-login/begin did not settle to ready (got "${beginBody.status}") — #1556`
  ).toBe("ready");

  const deadline = Date.now() + POLL_DEADLINE_MS;
  let interval = POLL_INITIAL_INTERVAL_MS;
  let lastModels: readonly ConfiguredModel[] = [];
  let ready = false;
  while (Date.now() < deadline) {
    const body = (await readJson(await page.request.get("/api/ai/models"))) as {
      models: readonly ConfiguredModel[];
    };
    lastModels = body.models;
    if (hasChatCapableActiveModel(lastModels)) {
      ready = true;
      break;
    }
    await page.waitForTimeout(Math.min(interval, Math.max(0, deadline - Date.now())));
    interval = Math.min(interval * 2, POLL_MAX_INTERVAL_MS);
  }
  expect(
    ready,
    `no chat-capable active model after ${POLL_DEADLINE_MS}ms; last /api/ai/models: ` +
      JSON.stringify(lastModels)
  ).toBeTruthy();

  // Turn 1: state the early, distinctive fact the continuity question will later probe for.
  const turn1Body = (await readJson(
    await page.request.post("/api/chat/turn", {
      data: {
        text: `Please remember this for later and reply with only the single word "noted": my childhood dog's name was ${DISTINCTIVE_FACT_TOKEN}.`
      }
    })
  )) as { reply?: string };
  expect(typeof turn1Body.reply, "turn 1 returned no string reply").toBe("string");

  // Turns 2..45: filler, pushing the thread past the replay write-gate threshold.
  for (let turnNumber = 2; turnNumber <= SEED_TURN_COUNT; turnNumber++) {
    const fillerBody = (await readJson(
      await page.request.post("/api/chat/turn", {
        data: { text: `Turn ${turnNumber}: reply with only the single word "ok".` }
      })
    )) as { reply?: string };
    expect(typeof fillerBody.reply, `turn ${turnNumber} returned no string reply`).toBe("string");
  }

  // Resolve the seeded thread and its pre-relaunch message count (AC-5 no-prose baseline).
  const threadsBody = (await readJson(await page.request.get("/api/chat/threads"))) as {
    threads: readonly { id: string }[];
  };
  expect(threadsBody.threads.length, "no chat thread found after seeding").toBeGreaterThan(0);
  const threadId = threadsBody.threads[0]?.id;
  if (!threadId) {
    throw new Error("seeded thread has no id");
  }

  const messagesBeforeRelaunch = (await readJson(
    await page.request.get(`/api/chat/threads/${threadId}/messages`)
  )) as { messages: readonly unknown[] };
  const countBeforeRelaunch = messagesBeforeRelaunch.messages.length;
  expect(countBeforeRelaunch, "expected ~90 stored messages after 45 seed turns").toBeGreaterThan(
    SEED_TURN_COUNT
  );

  // Force a relaunch — the simplest deterministic trigger, confirmed equivalent to
  // healAndRelaunch per plan D8 (no signal distinguishes the two forceReplay:true paths).
  const switchResp = await page.request.post("/api/chat/switch");
  expect(switchResp.ok(), `/api/chat/switch -> ${switchResp.status()}`).toBeTruthy();

  // AC-5 no-prose check: the forced relaunch itself must add zero visible turns.
  const messagesAfterRelaunch = (await readJson(
    await page.request.get(`/api/chat/threads/${threadId}/messages`)
  )) as { messages: readonly unknown[] };
  expect(
    messagesAfterRelaunch.messages.length,
    "forced relaunch added visible turns — spec AC-5 requires zero"
  ).toBe(countBeforeRelaunch);

  // Ask the continuity question through the real API — only the replayed window/summary can
  // answer it correctly, since turn 1 is well outside the last ~40 stored messages by now.
  const continuityBody = (await readJson(
    await page.request.post("/api/chat/turn", {
      data: { text: "What was the name of my childhood dog? Answer with just the name." }
    })
  )) as { reply?: string };
  expect(typeof continuityBody.reply, "continuity turn returned no string reply").toBe("string");
  const continuityReply = continuityBody.reply ?? "";
  expect(
    continuityReply.includes(DISTINCTIVE_FACT_TOKEN),
    `continuity reply did not reference the turn-1 fact "${DISTINCTIVE_FACT_TOKEN}": "${continuityReply}"`
  ).toBeTruthy();

  // Server-log proof: chat.replay.injected fired for the relaunch with trigger:relaunch.
  // packages/chat/src/live/persistence.ts listPriorTurns logs via bare console.info (no
  // logger wrapper), so each event is one raw JSON line on the container's stdout.
  const containerName = `${projectName}-jarv1s-1`;
  const logs = await execFileAsync("docker", ["logs", containerName])
    .then(({ stdout, stderr }) => `${stdout}\n${stderr}`)
    .catch(
      (error: { stdout?: string; stderr?: string }) =>
        `${error.stdout ?? ""}\n${error.stderr ?? ""}`
    );
  const hasRelaunchInjectionLog = logs.split("\n").some((line) => {
    if (!line.includes('"event":"chat.replay.injected"')) return false;
    try {
      const parsed = JSON.parse(line) as { event?: string; trigger?: string };
      return parsed.event === "chat.replay.injected" && parsed.trigger === "relaunch";
    } catch {
      return false;
    }
  });
  expect(
    hasRelaunchInjectionLog,
    `no chat.replay.injected log line with trigger:relaunch found in \`docker logs ${containerName}\``
  ).toBeTruthy();
});

import { expect, test } from "@playwright/test";
import { bringUpRealChatModel, readUatJson, signInUatAdmin } from "./real-chat-signin.js";

// #1121/#2732: the real-LLM half of runtime-context.uat.spec.ts's deferred assertions. That file
// `test.fixme`s every real chat reply because the DEFAULT harness seeds only a fake provider bound
// to module.news — no seed level can drive a turn to a model reply. This spec closes that gap for
// the ONE opt-in configuration where a real, instruction-following chat model IS reachable: the
// operator's own signed-in Codex CLI login, copied into the stack by the provisioner (tests/uat/
// real-chat-env.ts). It stays skipped for every default/CI run so the gate remains credential-free
// (Coordinator constraint 1).
export const uatLevel = { level: "solo-admin", without: [] } as const;

// #2732: the provisioner sets this ONLY after copying a real Codex login into the stack. Its
// presence is the authoritative "a real chat model can be reached THIS run" signal — absent on
// every default/CI run, so the whole spec skips rather than failing. run-uat.ts spawns Playwright
// with `...process.env` (tests/uat/run-uat.ts:92-96), so the var the provisioner set on the
// harness process reaches here.
const REAL_CHAT_CONFIGURED = Boolean(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED);

test("real Codex login yields the cheapest chat-capable model and answers a turn (#1121, #2732)", async ({
  page
}) => {
  test.skip(
    !REAL_CHAT_CONFIGURED,
    "no real-chat login configured for this run (JARVIS_UAT_REAL_CHAT_CONFIGURED unset) — #1121"
  );
  // Generous: a cold real provider probe + async model discovery + one real model round-trip all
  // happen serially below; the default per-test timeout would flake on a slow upstream.
  test.setTimeout(180_000);

  await signInUatAdmin(page);

  // The CLI binary is NOT present on a fresh cli-tools volume even though the provisioner already
  // copied the host's Codex login into the cli-auth volume (tests/uat/real-chat-env.ts) — login
  // and binary install are separate steps (uat-real-chat-onboarding-cli-tools-missing). Installs
  // the CLI, drives its admin-gated login, discovers the cheapest active chat-capable model, and
  // binds it as the account's chat override (tests/uat/specs/real-chat-signin.ts).
  await bringUpRealChatModel(page);

  // Drive a real turn and assert a real reply. /api/chat/turn returns { reply, assistantMessageId }
  // synchronously (packages/chat/src/live-routes.ts:177-181). We assert only that a real,
  // model-generated reply came back — never the exact text (a real model is non-deterministic).
  const turnBody = (await readUatJson(
    await page.request.post("/api/chat/turn", {
      data: { text: "Reply with exactly the three words: real chat works." }
    })
  )) as { reply?: string };
  expect(typeof turnBody.reply, "chat turn returned no string reply").toBe("string");
  expect((turnBody.reply ?? "").trim().length, "chat turn reply was empty").toBeGreaterThan(0);
});

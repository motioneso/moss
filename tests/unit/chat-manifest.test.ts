import { readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { chatModuleManifest } from "@moss/chat";

describe("chatModuleManifest", () => {
  it("explains the actual removable meeting chip escape for subscription chat", () => {
    const feature = chatModuleManifest.features.find(
      (item) => item.id === "chat.meeting_questions"
    )!;
    expect(feature.errors?.find((item) => item.code === "meeting_chat_unsupported")).toEqual({
      code: "meeting_chat_unsupported",
      class: "prerequisite",
      remediationRef: "chat.meeting_questions.configure",
      description:
        "Meeting questions need an available API-key model. Remove the About this meeting chip to continue ordinary subscription chat. Enabled overrides fail closed; contact an admin when locked."
    });
    expect(feature.remediations).toEqual([
      {
        id: "chat.meeting_questions.configure",
        description:
          "Remove the About this meeting chip for ordinary subscription chat. To ask about a meeting, choose an allowed active API-key chat model in AI providers; administrator pins still apply.",
        path: "/settings?section=aiproviders"
      }
    ]);
    expect(feature.description).toContain(
      "Failed questions remain above their error in the open chat."
    );
  });
  it("lists every chat SQL migration file in order", async () => {
    const sqlFiles = (await readdir("packages/chat/sql"))
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map((file) => `sql/${file}`);

    expect(chatModuleManifest.database.migrations).toEqual(sqlFiles);
  });
});

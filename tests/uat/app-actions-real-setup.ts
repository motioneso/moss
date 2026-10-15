import { chromium, expect, firefox } from "@playwright/test";

import { readClaimedWebPort } from "./provisioned-run.js";
import { disposableStackProblems } from "./specs/app-actions-real-proof.js";
import {
  readUatJson,
  requireUatBaseURL,
  requireUatProjectName,
  signInUatAdmin
} from "./specs/real-chat-signin.js";

/** #3338 lets installed trust run after recall; this scenario exercises asking paths. */
export default async function prepareAskingOwner(): Promise<void> {
  expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("1");
  expect(
    disposableStackProblems({
      baseURL: requireUatBaseURL(),
      projectName: requireUatProjectName(),
      claimedWebPort: readClaimedWebPort()
    })
  ).toEqual([]);
  const browserType = process.env.MOSS_UAT_BROWSER === "firefox" ? firefox : chromium;
  const browser = await browserType.launch();
  try {
    const page = await browser.newPage({ baseURL: requireUatBaseURL() });
    await signInUatAdmin(page);
    const policy = {
      moduleId: "settings",
      actionFamilyId: "settings.preference-write",
      tier: "ask_each_time"
    };
    expect(
      await readUatJson(
        await page.request.patch("/api/ai/action-policy/settings/settings.preference-write", {
          data: { tier: policy.tier }
        })
      )
    ).toEqual(policy);
    expect(await readUatJson(await page.request.get("/api/ai/action-policy"))).toEqual(
      expect.objectContaining({ policies: expect.arrayContaining([policy]) })
    );
    expect(await readUatJson(await page.request.get("/api/me/yolo"))).toEqual(
      expect.objectContaining({ self: expect.objectContaining({ enabled: false, active: false }) })
    );
    console.log(
      "[3065 owner setup] real owner API saved and verified settings.preference-write=ask_each_time; Auto-approve off"
    );
  } finally {
    await browser.close();
  }
}

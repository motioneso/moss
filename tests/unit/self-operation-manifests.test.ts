import { describe, expect, it } from "vitest";
import { tasksModuleManifest } from "../../packages/tasks/src/manifest.js";
import { commitmentsModuleManifest } from "../../packages/commitments/src/manifest.js";
import { goalsModuleManifest } from "../../packages/goals/src/manifest.js";
import { notesModuleManifest } from "../../packages/notes/src/manifest.js";
import { peopleModuleManifest } from "../../packages/people/src/manifest.js";
import { memoryModuleManifest } from "../../packages/memory/src/manifest.js";
import { newsModuleManifest } from "../../packages/news/src/manifest.js";
import { emailModuleManifest } from "../../packages/email/src/manifest.js";
import { calendarModuleManifest } from "../../packages/calendar/src/manifest.js";
import { webModuleManifest } from "../../packages/web-research/src/manifest.js";
import { sportsModuleManifest } from "../../packages/sports/src/manifest.js";
import { getBuiltInModuleManifests } from "../../packages/module-registry/src/index.js";
import { isSelfOperationExcluded } from "../../packages/ai/src/gateway/self-operation.js";
import type { ModuleAssistantToolManifest } from "../../packages/module-sdk/src/index.js";

const GRANTED_AT_INSTALL_TASK_TOOLS = [
  "tasks.create",
  "tasks.update",
  "tasks.updateStatus",
  "tasks.breakDown",
  "tasks.addActivity",
  "tasks.assignTag",
  "tasks.unassignTag",
  "tasks.createList",
  "tasks.renameList",
  "tasks.createTag",
  "tasks.renameTag"
];

// #1263 Task B item 1: deleteList/deleteTag moved out of granted_at_install -- task_cleanup's
// defaultTier is always_confirm, and install must never promote an always_confirm family's tier.
const USER_PROMOTABLE_TASK_TOOLS = ["tasks.deleteList", "tasks.deleteTag"];

const GRANTED_AT_INSTALL_COMMITMENT_TOOLS = [
  "commitments.accept",
  "commitments.reject",
  "commitments.snooze"
];

const GRANTED_AT_INSTALL_GOALS_TOOLS = ["goals.create", "goals.update", "goals.addEvidence"];

const GRANTED_AT_INSTALL_NOTES_TOOLS = ["notes.create", "notes.edit", "notes.delete"];

const GRANTED_AT_INSTALL_PEOPLE_TOOLS = ["people.acceptMatch", "people.rejectMatch"];
const CONFIRM_ALWAYS_PEOPLE_TOOLS = ["people.merge", "people.splitIdentity"];

describe("Tasks self-operation manifest classification", () => {
  it("classifies 11 Tasks write tools as granted_at_install", () => {
    const tools = tasksModuleManifest.assistantTools ?? [];
    for (const name of GRANTED_AT_INSTALL_TASK_TOOLS) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, `expected tool ${name} to exist`).toBeDefined();
      expect(tool?.selfOperationGrant, `expected ${name} to be granted_at_install`).toBe(
        "granted_at_install"
      );
    }
  });

  // #1263 Task B item 1: task_cleanup's defaultTier is always_confirm, so its two tools must be
  // user_promotable, not granted_at_install -- install must never promote an always_confirm family.
  it("classifies 2 Tasks write tools (task_cleanup) as user_promotable", () => {
    const tools = tasksModuleManifest.assistantTools ?? [];
    for (const name of USER_PROMOTABLE_TASK_TOOLS) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, `expected tool ${name} to exist`).toBeDefined();
      expect(tool?.selfOperationGrant, `expected ${name} to be user_promotable`).toBe(
        "user_promotable"
      );
    }
  });
});

describe("Commitments self-operation manifest classification", () => {
  it("classifies all 3 Commitments write tools as granted_at_install", () => {
    const tools = commitmentsModuleManifest.assistantTools ?? [];
    for (const name of GRANTED_AT_INSTALL_COMMITMENT_TOOLS) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, `expected tool ${name} to exist`).toBeDefined();
      expect(tool?.selfOperationGrant, `expected ${name} to be granted_at_install`).toBe(
        "granted_at_install"
      );
    }
  });
});

describe("Goals self-operation manifest classification", () => {
  it("classifies all 3 Goals write tools as granted_at_install", () => {
    const tools = goalsModuleManifest.assistantTools ?? [];
    for (const name of GRANTED_AT_INSTALL_GOALS_TOOLS) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, `expected tool ${name} to exist`).toBeDefined();
      expect(tool?.selfOperationGrant, `expected ${name} to be granted_at_install`).toBe(
        "granted_at_install"
      );
    }
  });
});

describe("Notes self-operation manifest classification", () => {
  it("classifies Notes create, edit, and delete as granted_at_install", () => {
    const tools = notesModuleManifest.assistantTools ?? [];
    for (const name of GRANTED_AT_INSTALL_NOTES_TOOLS) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, `expected tool ${name} to exist`).toBeDefined();
      expect(tool?.selfOperationGrant, `expected ${name} to be granted_at_install`).toBe(
        "granted_at_install"
      );
    }
  });

  it("grants notes.delete at install as an auto-executable write", () => {
    const tools = notesModuleManifest.assistantTools ?? [];
    const deleteTool = tools.find((candidate) => candidate.name === "notes.delete");
    expect(deleteTool, "expected tool notes.delete to exist").toBeDefined();
    expect(deleteTool?.risk).toBe("write");
    expect(deleteTool?.actionFamilyId).toBe("note_changes");
    expect(deleteTool?.executionPolicy).toBe("auto");
    expect(deleteTool?.selfOperationGrant).toBe("granted_at_install");
  });

  it("keeps overwrite confirmation conditional while ordinary note writes are auto-capable", async () => {
    const tools = notesModuleManifest.assistantTools ?? [];
    const createTool = tools.find((candidate) => candidate.name === "notes.create");
    expect(createTool, "expected tool notes.create to exist").toBeDefined();
    expect(createTool?.executionPolicy).toBe("auto");
    expect(
      await createTool?.requiresConfirmation?.({} as never, { overwrite: true }, {} as never)
    ).toBe(true);
    expect(
      await createTool?.requiresConfirmation?.({} as never, { overwrite: false }, {} as never)
    ).toBe(false);
  });
});

describe("People self-operation manifest classification", () => {
  it("classifies People with exactly two binding confirm_always declarations", () => {
    const tools = peopleModuleManifest.assistantTools ?? [];
    for (const name of GRANTED_AT_INSTALL_PEOPLE_TOOLS) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, `expected tool ${name} to exist`).toBeDefined();
      expect(tool?.selfOperationGrant, `expected ${name} to be granted_at_install`).toBe(
        "granted_at_install"
      );
    }
    for (const name of CONFIRM_ALWAYS_PEOPLE_TOOLS) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, `expected tool ${name} to exist`).toBeDefined();
      expect(tool?.risk).toBe("destructive");
      expect(tool?.selfOperationGrant, `expected ${name} to be confirm_always`).toBe(
        "confirm_always"
      );
    }
    const confirmAlwaysCount = tools.filter(
      (tool) => tool.selfOperationGrant === "confirm_always"
    ).length;
    expect(confirmAlwaysCount).toBe(2);
  });
});

describe("Memory self-operation manifest classification", () => {
  it("classifies remember as granted and forget as binding confirm_always", () => {
    const tools = memoryModuleManifest.assistantTools ?? [];
    const remember = tools.find((candidate) => candidate.name === "memory.remember");
    expect(remember, "expected tool memory.remember to exist").toBeDefined();
    expect(remember?.risk).toBe("write");
    expect(remember?.actionFamilyId).toBe("memory_management");
    expect(remember?.executionPolicy).toBe("auto");
    expect(remember?.selfOperationGrant).toBe("granted_at_install");

    const forget = tools.find((candidate) => candidate.name === "memory.forget");
    expect(forget, "expected tool memory.forget to exist").toBeDefined();
    expect(forget?.risk).toBe("destructive");
    expect(forget?.selfOperationGrant).toBe("confirm_always");
  });
});

const GRANTED_AT_INSTALL_NEWS_TOOLS = [
  "news.confirmSource",
  "news.removeSource",
  "news.addTopic",
  "news.removeTopic",
  "news.addExclusion"
];

describe("News self-operation manifest classification", () => {
  it("classifies all 5 News personalization writes as granted_at_install", () => {
    const tools = newsModuleManifest.assistantTools ?? [];
    for (const name of GRANTED_AT_INSTALL_NEWS_TOOLS) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, `expected tool ${name} to exist`).toBeDefined();
      expect(tool?.risk).toBe("write");
      expect(tool?.actionFamilyId).toBe("news_personalization");
      expect(tool?.executionPolicy).toBe("auto");
      expect(tool?.selfOperationGrant, `expected ${name} to be granted_at_install`).toBe(
        "granted_at_install"
      );
    }
  });
});

const GRANTED_AT_INSTALL_SPORTS_TOOLS = ["sports.followTeam", "sports.unfollowTeam"];

describe("Sports self-operation manifest classification", () => {
  it("classifies both follow tools as granted_at_install", () => {
    const tools = sportsModuleManifest.assistantTools ?? [];
    for (const name of GRANTED_AT_INSTALL_SPORTS_TOOLS) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, `expected tool ${name} to exist`).toBeDefined();
      expect(tool?.risk).toBe("write");
      expect(tool?.actionFamilyId).toBe("sports_follows");
      expect(tool?.executionPolicy).toBe("auto");
      expect(tool?.selfOperationGrant, `expected ${name} to be granted_at_install`).toBe(
        "granted_at_install"
      );
    }
  });
});

describe("Email self-operation manifest classification", () => {
  it("classifies email.draftReply as granted_at_install", () => {
    const tools = emailModuleManifest.assistantTools ?? [];
    const draftReply = tools.find((candidate) => candidate.name === "email.draftReply");
    expect(draftReply, "expected tool email.draftReply to exist").toBeDefined();
    expect(draftReply?.risk).toBe("write");
    expect(draftReply?.actionFamilyId).toBe("email_drafts");
    expect(draftReply?.executionPolicy).toBe("auto");
    expect(draftReply?.selfOperationGrant).toBe("granted_at_install");
  });

  it("keeps email.sendReply destructive and confirm_always so mail is never sent without approval", () => {
    const tools = emailModuleManifest.assistantTools ?? [];
    const sendReply = tools.find((candidate) => candidate.name === "email.sendReply");
    expect(sendReply, "expected tool email.sendReply to exist").toBeDefined();
    expect(sendReply?.risk).toBe("destructive");
    expect(sendReply?.selfOperationGrant).toBe("confirm_always");
    expect(sendReply?.actionFamilyId).toBeUndefined();
    expect(sendReply?.executionPolicy).toBeUndefined();
  });
});

describe("Calendar self-operation manifest classification", () => {
  it("classifies both createEvent and deleteEvent as user_promotable", () => {
    const tools = calendarModuleManifest.assistantTools ?? [];

    const createEvent = tools.find((candidate) => candidate.name === "calendar.createEvent");
    expect(createEvent, "expected tool calendar.createEvent to exist").toBeDefined();
    expect(createEvent?.risk).toBe("write");
    expect(createEvent?.actionFamilyId).toBe("calendar_writeback");
    expect(createEvent?.executionPolicy).toBe("auto");
    // Not granted_at_install: the proactive follow-through worker (module-registry/src/index.ts:711)
    // reads calendar_writeback's tier unattended, so install must not promote it (Fable, PR #1268).
    expect(createEvent?.selfOperationGrant).toBe("user_promotable");

    const deleteEvent = tools.find((candidate) => candidate.name === "calendar.deleteEvent");
    expect(deleteEvent, "expected tool calendar.deleteEvent to exist").toBeDefined();
    expect(deleteEvent?.risk).toBe("write");
    expect(deleteEvent?.actionFamilyId).toBe("calendar_management");
    expect(deleteEvent?.executionPolicy).toBe("auto");
    expect(deleteEvent?.selfOperationGrant).toBe("user_promotable");
  });

  it("keeps both Calendar write families locked to allow trusted_auto and always_confirm", () => {
    const families = calendarModuleManifest.assistantActionFamilies ?? [];

    const writeback = families.find((candidate) => candidate.id === "calendar_writeback");
    expect(writeback, "expected family calendar_writeback to exist").toBeDefined();
    expect(writeback?.allowedTiers).toContain("trusted_auto");
    expect(writeback?.allowedTiers).toContain("always_confirm");

    const management = families.find((candidate) => candidate.id === "calendar_management");
    expect(management, "expected family calendar_management to exist").toBeDefined();
    expect(management?.defaultTier).toBe("always_confirm");
    expect(management?.allowedTiers).toContain("trusted_auto");
    expect(management?.allowedTiers).toContain("always_confirm");
  });
});

describe("Web Research self-operation manifest classification", () => {
  it("classifies web.read as confirm_always with no promotable family", () => {
    const tools: readonly ModuleAssistantToolManifest[] = webModuleManifest.assistantTools ?? [];
    const webRead = tools.find((candidate) => candidate.name === "web.read");
    expect(webRead, "expected tool web.read to exist").toBeDefined();
    expect(webRead?.risk).toBe("write");
    // No actionFamilyId, no executionPolicy: policy.ts:40 must confirm every call. web-research
    // has no approved spec (spec 2's remaining-modules list stops at calendar/email/ai), and
    // web.read is the v0.1.0 audit's prompt-injection-to-exfiltration finding — an unattended
    // auto-approve here would resurrect that HIGH. Opus security review on PR #1268; #1263.
    expect(webRead?.actionFamilyId).toBeUndefined();
    expect(webRead?.executionPolicy).toBeUndefined();
    expect(webRead?.selfOperationGrant).toBe("confirm_always");

    const manifestAssistantActionFamilies = (
      webModuleManifest as { assistantActionFamilies?: readonly unknown[] }
    ).assistantActionFamilies;
    expect(manifestAssistantActionFamilies ?? []).toEqual([]);
  });
});

// Five tools, not four: the odd one out is web.read (risk "write", not "destructive"). It is
// deliberately listed here rather than made auto-run-eligible: pre-PR #1268 it carried no
// actionFamilyId, so policy.ts:40 confirmed every call, and that card was the last human control
// on the v0.1.0 audit's web.read prompt-injection-to-exfiltration finding. Do not "tidy" this to
// risk: "destructive" to match the other four, and do not give it a family — either would either
// misclassify the risk or reopen the auto-approve door. See Opus security review on PR #1268 (#1263).
const PLANNED_CONFIRM_ALWAYS_TOOL_NAMES = [
  "memory.forget",
  "people.merge",
  "people.splitIdentity",
  "email.sendReply",
  "web.read"
];

describe("Sports/News denylist check (#1265)", () => {
  it("neither news nor sports write tools intersect the Spec 1 excluded set", () => {
    const modules = [newsModuleManifest, sportsModuleManifest];
    for (const manifest of modules) {
      for (const tool of manifest.assistantTools ?? []) {
        if (tool.risk === "read") continue;
        expect(
          isSelfOperationExcluded(manifest.id, tool),
          `expected ${manifest.id}.${tool.name} not to be self-operation-excluded`
        ).toBe(false);
      }
    }
  });

  // ALSO-2: the check above only ever exercises the false branch (nothing in news/sports is
  // excluded), so it can never fail if isSelfOperationExcluded were stubbed to always return
  // false. Assert the true branch against a real SELF_OPERATION_EXCLUSIONS entry
  // (self_authority.settings, prefix "settings.yolo.") so a regression there is caught.
  it("matches a known-excluded moduleId/tool-name-prefix pair (self_authority.settings)", () => {
    expect(isSelfOperationExcluded("settings", { name: "settings.yolo.enable" })).toBe(true);
  });
});

describe("Complete built-in self-operation inventory (#1263)", () => {
  it("classifies every built-in write/destructive tool across exactly the three legal buckets, summing to 50", () => {
    // People declares its grants in packages/people/src/tools.ts, not a manifest.ts — this
    // walks the real getBuiltInModuleManifests() registry (which resolves that indirection),
    // so it does not undercount the way a manifest.ts-only grep would (34 instead of 38).
    const manifests = getBuiltInModuleManifests();

    const grantedAtInstall: string[] = [];
    const confirmAlways: string[] = [];
    const userPromotable: string[] = [];
    const unclassified: string[] = [];
    const excluded: string[] = [];

    for (const manifest of manifests) {
      for (const tool of manifest.assistantTools ?? []) {
        if (tool.risk === "read") continue;

        if (isSelfOperationExcluded(manifest.id, tool)) {
          excluded.push(`${manifest.id}.${tool.name}`);
          continue;
        }

        switch (tool.selfOperationGrant) {
          case "granted_at_install":
            grantedAtInstall.push(`${manifest.id}.${tool.name}`);
            break;
          case "confirm_always":
            confirmAlways.push(tool.name);
            break;
          case "user_promotable":
            userPromotable.push(tool.name);
            break;
          default:
            unclassified.push(`${manifest.id}.${tool.name}`);
        }
      }
    }

    expect(
      unclassified,
      `expected zero unclassified built-in write tools, found: ${unclassified.join(", ")}`
    ).toEqual([]);
    expect(
      excluded,
      `expected zero excluded built-in write tools, found: ${excluded.join(", ")}`
    ).toEqual([]);

    // #1265: +2 (sports.followTeam, sports.unfollowTeam), both granted_at_install — the sports
    // module's first write tools, added on top of #1264's settings-module bump below.
    // #1888: +1 (workshop.buildModule), granted_at_install. Calling it writes a plan and parks the
    // build at awaiting_plan_approval — it installs and ships nothing, and the plan card the user
    // must press "Build it" on is the real gate. Admin-only is enforced separately in the host
    // service, not by this tier.
    expect(grantedAtInstall.length).toBe(40);
    expect(confirmAlways.length).toBe(5);
    expect(userPromotable.length).toBe(5);

    // Task 12a moved calendar.deleteEvent out of granted_at_install (33 -> ...). PR #1268's
    // security reviews moved two more: Fable moved calendar.createEvent to user_promotable
    // (the proactive follow-through worker is a second unattended reader of calendar_writeback's
    // tier), and Opus moved web.read to confirm_always (no approved spec covers web-research, and
    // an auto-run family would have reopened the v0.1.0 audit's exfiltration finding). #1263
    // Task B item 1 moved two more: tasks.deleteList/tasks.deleteTag out of granted_at_install,
    // because task_cleanup's defaultTier is always_confirm and install must never promote an
    // always_confirm family's tier. That left granted at 29, confirm_always at 5, user_promotable
    // at 4 — 38 total. #1268 then added chat.setResponseStyle (granted_at_install), and #1264
    // added the settings module's seven self-operation tools (theme mode, locale x2, quiet hours,
    // weather location, notification preference, and the mandatory undo-apply tool), all
    // granted_at_install — 29 + 1 + 7 = 37 granted. #1265 then added sports.followTeam and
    // sports.unfollowTeam (also granted_at_install) — 37 + 2 = 39 granted, 48 write/destructive
    // tools total. #1698's calendar lifecycle rebuild added calendar.rescheduleEvent as a new
    // user_promotable tool (same tier as the existing create/delete calendar tools) — 39 + 5 + 5
    // = 49 total. #1888 added workshop.buildModule (granted_at_install) — 40 + 5 + 5 = 50 total.
    expect(grantedAtInstall.length + confirmAlways.length + userPromotable.length).toBe(50);

    expect(confirmAlways.sort()).toEqual([...PLANNED_CONFIRM_ALWAYS_TOOL_NAMES].sort());
    expect(userPromotable.sort()).toEqual(
      [
        "calendar.deleteEvent",
        "calendar.createEvent",
        "calendar.rescheduleEvent",
        "tasks.deleteList",
        "tasks.deleteTag"
      ].sort()
    );
  });
});

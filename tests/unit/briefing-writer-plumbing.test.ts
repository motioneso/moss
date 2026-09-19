import { beforeEach, describe, expect, it, vi } from "vitest";

// Fail-first cover for the p8 briefing-writer opt-in: the seed level calls
// the writer chunk only when a fixture base URL is set, and the provisioner
// addresses the writer fixture by container name on its own port.

const levelMocks = vi.hoisted(() => ({
  briefingWriterChunk: vi.fn().mockResolvedValue(undefined),
  aiChunk: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("../uat/seed/connections.js", () => ({
  createMigrationOwnerDb: () => ({ destroy: vi.fn().mockResolvedValue(undefined) }),
  createAppRuntimeRunner: () => ({ destroy: vi.fn().mockResolvedValue(undefined) })
}));
vi.mock("../uat/seed/admin.js", () => ({
  seedSoloAdmin: vi.fn().mockResolvedValue({ userId: "00000000-0000-4000-8000-000000000001" })
}));
vi.mock("../uat/seed/chunks/onboarding.js", () => ({ seedOnboardingChunk: vi.fn() }));
vi.mock("../uat/seed/chunks/ai.js", () => ({ seedAiProviderChunk: levelMocks.aiChunk }));
vi.mock("../uat/seed/chunks/chat-script.js", () => ({ seedScriptedChatProviderChunk: vi.fn() }));
vi.mock("../uat/seed/chunks/job-search-ai.js", () => ({
  seedJobSearchAiProviderChunk: vi.fn()
}));
vi.mock("../uat/seed/chunks/news.js", () => ({ seedNewsChunk: vi.fn() }));
vi.mock("../uat/seed/chunks/sports.js", () => ({
  seedSportsChunk: vi.fn(),
  seedSportsPublicSourceFixtures: vi.fn()
}));
vi.mock("../uat/seed/chunks/tasks.js", () => ({ seedTasksChunk: vi.fn() }));
vi.mock("../uat/seed/chunks/calendar.js", () => ({ seedCalendarChunk: vi.fn() }));
vi.mock("../uat/seed/chunks/notes.js", () => ({ seedNotesChunk: vi.fn() }));
vi.mock("../uat/seed/chunks/finance.js", () => ({ seedFinanceChunk: vi.fn() }));
vi.mock("../uat/seed/chunks/workshop-storage.js", () => ({
  installWorkshopStorageFixture: vi.fn()
}));
vi.mock("../uat/seed/chunks/briefing-writer-ai.js", () => ({
  seedBriefingWriterAiProviderChunk: levelMocks.briefingWriterChunk
}));

import { seedLevel } from "../uat/seed/levels.js";
import {
  briefingWriterFixtureBaseUrlFor,
  briefingWriterFixtureContainerName,
  buildSeedHookInput,
  generateUatRunId
} from "../uat/provisioner.js";

describe("briefing-writer opt-in plumbing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("seeds the writer chunk when a fixture base URL is set", async () => {
    await seedLevel({
      level: "admin+data",
      briefingWriterAiProviderBaseUrl: "http://uat-1-bwfixture:8081"
    });

    expect(levelMocks.briefingWriterChunk).toHaveBeenCalledOnce();
    const args = levelMocks.briefingWriterChunk.mock.calls[0]!;
    expect(args[1]).toBe("00000000-0000-4000-8000-000000000001");
    expect(args[2]).toBe("http://uat-1-bwfixture:8081");
  });

  it("leaves seeding byte-identical without the flag", async () => {
    await seedLevel({ level: "admin+data" });

    expect(levelMocks.briefingWriterChunk).not.toHaveBeenCalled();
    expect(levelMocks.aiChunk).toHaveBeenCalledOnce();
  });

  it("addresses the writer fixture by container name on its own port", () => {
    const { projectName } = generateUatRunId();
    const url = briefingWriterFixtureBaseUrlFor(projectName);

    expect(url).toBe(`http://${briefingWriterFixtureContainerName(projectName)}:8081`);
    expect(url).not.toContain("127.0.0.1");
    expect(url).not.toContain("localhost");
  });

  it("scopes the writer container name to the project", () => {
    const first = briefingWriterFixtureContainerName(generateUatRunId().projectName);
    const second = briefingWriterFixtureContainerName(generateUatRunId().projectName);

    expect(first).not.toBe(second);
    expect(first.startsWith("uat-")).toBe(true);
  });

  it("threads the writer base URL from provision options to the seed hook", () => {
    const input = buildSeedHookInput(
      "uat-1",
      "admin+data",
      { withBriefingWriterFixture: true },
      undefined,
      "http://uat-1-bwfixture:8081"
    );

    expect(input.briefingWriterAiProviderBaseUrl).toBe("http://uat-1-bwfixture:8081");
  });
});

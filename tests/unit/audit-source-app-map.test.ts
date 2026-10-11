import { describe, expect, it } from "vitest";

import { CORE_APP_SETTINGS } from "@moss/shared";

function descriptionOf(id: string): string {
  const setting = CORE_APP_SETTINGS.find((entry) => entry.id === id);
  expect(setting).toBeDefined();
  return setting!.description;
}

describe("source and account-export app-map outcomes (#3397)", () => {
  it("describes ready-archive deadline recovery without an automatic replacement export", () => {
    const description = descriptionOf("profile");
    expect(description).toContain("expiry deadline while this page stays open");
    expect(description).toContain("Download disappears when an archive expires");
    expect(description).toContain("prepare a new archive without one starting automatically");
  });

  it("describes pending-save protection across navigation and obsolete-read rejection", () => {
    const description = descriptionOf("connections");
    expect(description).toContain("Changes stay disabled while a save is pending");
    expect(description).toContain("even after leaving and returning");
    expect(description).toContain("an older source check cannot replace a confirmed save");
  });
});

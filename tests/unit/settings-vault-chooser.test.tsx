import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { ApiError } from "../../apps/web/src/api/client.js";
import {
  shouldShowNotesRootRecovery,
  VaultChooser
} from "../../apps/web/src/settings/settings-vault-chooser.js";

function renderChooser(
  options: {
    readonly current?: string;
    readonly title?: string;
    readonly backLabel?: string;
    readonly roots?: Array<{ readonly name: string; readonly path: string }>;
  } = {}
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.settings.notesSourceDirectories(null), {
    path: null,
    directories: options.roots ?? []
  });
  return renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(VaultChooser, {
        current: options.current ?? "",
        title: options.title,
        backLabel: options.backLabel,
        onCancel: () => {},
        onChoose: () => {}
      })
    )
  );
}

describe("VaultChooser trust boundaries", () => {
  it("does not render a raw server-path input", () => {
    const html = renderChooser();
    expect(html).not.toContain("Type a path on the server");
    expect(html).not.toContain('placeholder="/data/external-notes"');
  });

  it("limits Notes recovery to unavailable or truly empty roots", () => {
    expect(shouldShowNotesRootRecovery(undefined, 0)).toBe(true);
    expect(shouldShowNotesRootRecovery(undefined, 1)).toBe(false);
    expect(shouldShowNotesRootRecovery(new ApiError(503, "Notes roots unavailable"), 0)).toBe(true);
    expect(shouldShowNotesRootRecovery(new ApiError(500, "unexpected"), 0)).toBe(false);
  });
});

describe("one folder chooser everywhere (#2268)", () => {
  it("browses the allowed notes roots whatever screen opened it", () => {
    const html = renderChooser({ roots: [{ name: "notes", path: "/data/external-notes" }] });
    expect(html).toContain("/data/external-notes");
    expect(html).toContain("Use this folder");
  });

  it("defaults to the notes source heading and back label", () => {
    const html = renderChooser();
    expect(html).toContain("Choose a notes folder");
    expect(html).toContain("Data sources");
  });

  it("takes a heading and back label from the screen that opened it", () => {
    const html = renderChooser({ title: "Choose a People folder", backLabel: "People" });
    expect(html).toContain("Choose a People folder");
    expect(html).toContain("People");
    expect(html).not.toContain("Choose a notes folder");
  });

  it("the People settings screen opens this same chooser, with no separate People mode", () => {
    const pane = readFileSync(
      new URL("../../apps/web/src/settings/settings-people-pane.tsx", import.meta.url),
      "utf8"
    );
    expect(pane).toContain("<VaultChooser");
    expect(pane).toContain('title="Choose a People folder"');
    expect(pane).toContain('backLabel="People"');

    const chooser = readFileSync(
      new URL("../../apps/web/src/settings/settings-vault-chooser.tsx", import.meta.url),
      "utf8"
    );
    expect(chooser).not.toContain('"people"');
    expect(chooser).not.toContain("getPeopleNotesDirectories");
  });
});

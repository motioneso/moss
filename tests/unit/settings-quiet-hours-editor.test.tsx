// @vitest-environment jsdom
// #3130 - the Alerts & quiet hours editor keeps the saved schedule, the unsaved draft and save
// errors apart, and never presents a conflicting schedule as the one saved setting.
// #3131 - while saved schedules differ, the owner chooses one and nothing changes until it saves.
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GetQuietHoursSettingsResponse, QuietHoursSettingsDto } from "@moss/shared";
import { Combobox } from "@moss/ui";
import { QuietHoursEditor } from "../../apps/web/src/settings/settings-quiet-hours-editor.js";

const overnight: QuietHoursSettingsDto = {
  enabled: true,
  start: "22:00",
  end: "07:00",
  timezone: "America/Chicago"
};

function loaded(
  quietHours: QuietHoursSettingsDto,
  version = "1:100",
  authority: GetQuietHoursSettingsResponse["authority"] = { status: "canonical", alerts: null }
): GetQuietHoursSettingsResponse {
  return { quietHours, authority, version };
}

type Handler = (body: unknown) => Response | Promise<Response>;

/** Routes the editor's real API calls; each PUT or choice is answered by its next queued handler. */
function serve(
  initial: GetQuietHoursSettingsResponse,
  puts: Handler[] = [],
  choices: Handler[] = []
) {
  let current = initial;
  const sent: unknown[] = [];
  const chosen: unknown[] = [];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input);
    const json = (value: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(value), { status }));
    if (url === "/api/me/locale") {
      return json({ locale: { timezone: "Europe/Paris", region: "en-US", dateFormat: "24" } });
    }
    if (url === "/api/me/quiet-hours" && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as unknown;
      sent.push(body);
      const handler = puts.shift();
      if (!handler) throw new Error("unexpected PUT");
      return Promise.resolve(handler(body));
    }
    if (url === "/api/me/quiet-hours/resolution" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as unknown;
      chosen.push(body);
      const handler = choices.shift();
      if (!handler) throw new Error("unexpected choice");
      return Promise.resolve(handler(body));
    }
    if (url === "/api/me/quiet-hours") return json(current);
    throw new Error(`unexpected request ${url}`);
  });
  return {
    fetchMock,
    sent,
    chosen,
    setStored(next: GetQuietHoursSettingsResponse) {
      current = next;
    }
  };
}

function text(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join("");
  return text((node as { children?: unknown }).children);
}

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

let client: QueryClient;

async function mount(): Promise<ReactTestRenderer> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(createElement(QueryClientProvider, { client }, createElement(QuietHoursEditor)));
  });
  await flush();
  return tree;
}

const byLabel = (tree: ReactTestRenderer, label: string): ReactTestInstance =>
  tree.root.find((n) => typeof n.type === "string" && n.props["aria-label"] === label);
const button = (tree: ReactTestRenderer, label: string) =>
  tree.root.findAll((n) => n.type === "button" && text(n.children) === label);
const out = (tree: ReactTestRenderer) => text(tree.toJSON());

function setTime(tree: ReactTestRenderer, label: string, value: string) {
  act(() => {
    byLabel(tree, label).props.onChange({ currentTarget: { value } });
  });
}

async function save(tree: ReactTestRenderer) {
  await act(async () => {
    button(tree, "Save quiet hours")[0]!.props.onClick();
  });
  await flush();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("QuietHoursEditor", () => {
  it("shows the saved overnight schedule with nothing to save", async () => {
    serve(loaded(overnight));
    const tree = await mount();

    expect(out(tree)).toContain("Saved schedule: every day, 22:00 to 07:00, America/Chicago time.");
    expect(byLabel(tree, "Quiet hours from").props.value).toBe("22:00");
    expect(byLabel(tree, "Quiet hours until").props.value).toBe("07:00");
    expect(byLabel(tree, "Enable quiet hours").props.checked).toBe(true);
    expect(out(tree)).not.toContain("Unsaved changes");
    expect(button(tree, "Save quiet hours")[0]!.props.disabled).toBe(true);
  });

  it("keeps the saved line on the stored schedule while a draft is unsaved", async () => {
    serve(loaded(overnight));
    const tree = await mount();

    setTime(tree, "Quiet hours from", "23:30");

    expect(out(tree)).toContain("Unsaved changes");
    expect(out(tree)).toContain("Saved schedule: every day, 22:00 to 07:00");
    expect(byLabel(tree, "Quiet hours from").props.value).toBe("23:30");
    expect(button(tree, "Save quiet hours")[0]!.props.disabled).toBe(false);
  });

  it("saves the whole draft against the loaded version and then shows it as saved", async () => {
    const next = { ...overnight, start: "23:30", end: "06:00" };
    const api = serve(loaded(overnight), [
      () => new Response(JSON.stringify(loaded(next, "2:200")), { status: 200 })
    ]);
    const tree = await mount();

    setTime(tree, "Quiet hours from", "23:30");
    setTime(tree, "Quiet hours until", "06:00");
    await save(tree);

    expect(api.sent).toEqual([{ quietHours: next, expectedVersion: "1:100" }]);
    expect(out(tree)).toContain("Saved schedule: every day, 23:30 to 06:00, America/Chicago time.");
    expect(out(tree)).toContain("Quiet hours saved.");
    expect(out(tree)).not.toContain("Unsaved changes");
  });

  it("keeps the effective schedule and the draft when a save fails, and retries the draft", async () => {
    const next = { ...overnight, start: "23:30" };
    const api = serve(loaded(overnight), [
      () => new Response(JSON.stringify({ error: "Settings are unavailable" }), { status: 503 }),
      () => new Response(JSON.stringify(loaded(next, "2:200")), { status: 200 })
    ]);
    const tree = await mount();

    setTime(tree, "Quiet hours from", "23:30");
    await save(tree);

    expect(out(tree)).toContain("Quiet hours could not save");
    expect(out(tree)).toContain("Your previous schedule still applies.");
    expect(out(tree)).toContain("Saved schedule: every day, 22:00 to 07:00");
    expect(byLabel(tree, "Quiet hours from").props.value).toBe("23:30");
    expect(out(tree)).toContain("Unsaved changes");

    await act(async () => {
      button(tree, "Try again")[0]!.props.onClick();
    });
    await flush();

    expect(api.sent).toHaveLength(2);
    expect(api.sent[1]).toEqual({ quietHours: next, expectedVersion: "1:100" });
    expect(out(tree)).toContain("Saved schedule: every day, 23:30 to 07:00");
  });

  it("fails an offline save at once and keeps the draft", async () => {
    serve(loaded(overnight), [
      () => {
        throw new TypeError("Failed to fetch");
      }
    ]);
    const tree = await mount();
    onlineManager.setOnline(false);

    setTime(tree, "Quiet hours from", "23:30");
    try {
      await save(tree);
    } finally {
      onlineManager.setOnline(true);
    }

    expect(out(tree)).toContain(
      "Quiet hours could not save: Failed to fetch. Your previous schedule still applies."
    );
    expect(out(tree)).toContain("Saved schedule: every day, 22:00 to 07:00");
    expect(byLabel(tree, "Quiet hours from").props.value).toBe("23:30");
    expect(button(tree, "Try again")).toHaveLength(1);
  });

  it("refuses the same start and end time without sending anything", async () => {
    const api = serve(loaded(overnight));
    const tree = await mount();

    setTime(tree, "Quiet hours until", "22:00");
    await save(tree);

    expect(api.sent).toEqual([]);
    expect(out(tree)).toContain("Choose different start and end times.");
    expect(out(tree)).toContain("Saved schedule: every day, 22:00 to 07:00");
    expect(byLabel(tree, "Quiet hours until").props.value).toBe("22:00");
  });

  it("shows the latest stored schedule when another change won", async () => {
    const elsewhere = { ...overnight, start: "21:00" };
    const api = serve(loaded(overnight), [
      () => {
        api.setStored(loaded(elsewhere, "2:200"));
        return new Response(JSON.stringify({ error: "conflict" }), { status: 409 });
      }
    ]);
    const tree = await mount();

    setTime(tree, "Quiet hours from", "23:30");
    await save(tree);

    expect(out(tree)).toContain("Quiet hours changed somewhere else");
    expect(out(tree)).toContain("Saved schedule: every day, 21:00 to 07:00");
    expect(byLabel(tree, "Quiet hours from").props.value).toBe("21:00");
    expect(out(tree)).not.toContain("Unsaved changes");
  });

  it("saves a draft against the version it was built from, even after a refetch", async () => {
    const elsewhere = { ...overnight, timezone: "Europe/Paris" };
    const api = serve(loaded(overnight), [
      (body) => {
        const { expectedVersion } = body as { expectedVersion: string | null };
        if (expectedVersion !== "2:200") {
          return new Response(JSON.stringify({ error: "conflict" }), { status: 409 });
        }
        return new Response(JSON.stringify(loaded(overnight, "3:300")), { status: 200 });
      }
    ]);
    const tree = await mount();

    setTime(tree, "Quiet hours until", "06:00");
    api.setStored(loaded(elsewhere, "2:200"));
    await act(async () => {
      await client.refetchQueries({ queryKey: ["settings"] });
    });
    await flush();
    await save(tree);

    expect(api.sent).toEqual([
      { quietHours: { ...overnight, end: "06:00" }, expectedVersion: "1:100" }
    ]);
    expect(out(tree)).toContain("Quiet hours changed somewhere else");
    expect(out(tree)).toContain("Saved schedule: every day, 22:00 to 07:00, Europe/Paris time.");
  });

  it("starts a fresh draft once a refetch makes the stored schedule match it", async () => {
    const matched = { ...overnight, end: "06:00" };
    const api = serve(loaded(overnight), [
      (body) => {
        const { expectedVersion } = body as { expectedVersion: string | null };
        if (expectedVersion !== "2:200") {
          return new Response(JSON.stringify({ error: "conflict" }), { status: 409 });
        }
        return new Response(JSON.stringify(loaded({ ...matched, start: "23:00" }, "3:300")), {
          status: 200
        });
      }
    ]);
    const tree = await mount();

    setTime(tree, "Quiet hours until", "06:00");
    api.setStored(loaded(matched, "2:200"));
    await act(async () => {
      await client.refetchQueries({ queryKey: ["settings"] });
    });
    await flush();
    expect(out(tree)).not.toContain("Unsaved changes");
    setTime(tree, "Quiet hours from", "23:00");
    await save(tree);

    expect(api.sent).toEqual([
      { quietHours: { ...matched, start: "23:00" }, expectedVersion: "2:200" }
    ]);
    expect(out(tree)).toContain("Quiet hours saved.");
  });

  it("can follow the profile time zone and names it", async () => {
    const next = { ...overnight, timezone: null };
    const api = serve(loaded(overnight), [
      () => new Response(JSON.stringify(loaded(next, "2:200")), { status: 200 })
    ]);
    const tree = await mount();

    const zone = tree.root.find((n) => n.type === Combobox);
    expect(zone.props.options[0].label).toBe("Profile time zone (Europe/Paris)");
    act(() => {
      zone.props.onChange(zone.props.options[0].value);
    });
    await save(tree);

    expect(api.sent).toEqual([{ quietHours: next, expectedVersion: "1:100" }]);
    expect(out(tree)).toContain("your profile time zone (Europe/Paris)");
  });

  const differing = loaded(overnight, "1:100:abc", {
    status: "conflict",
    alerts: { enabled: true, start: "23:00", end: "08:00" }
  });
  const fromAlerts = { enabled: true, start: "23:00", end: "08:00", timezone: null };

  async function choose(tree: ReactTestRenderer, label: string) {
    await act(async () => {
      button(tree, label)[0]!.props.onClick();
    });
    await flush();
  }

  it("offers both saved schedules and hides the form until the owner chooses", async () => {
    serve(differing);
    const tree = await mount();

    expect(out(tree)).toContain("Your saved quiet hours differ.");
    expect(out(tree)).toContain("Nothing changes until you choose.");
    expect(button(tree, "Use 22:00 to 07:00 (America/Chicago)")).toHaveLength(1);
    expect(button(tree, "Use 23:00 to 08:00")).toHaveLength(1);
    expect(button(tree, "Save quiet hours")).toHaveLength(0);
    expect(tree.root.findAll((n) => n.props["aria-label"] === "Enable quiet hours")).toHaveLength(
      0
    );
    expect(out(tree)).not.toContain("Saved schedule");
  });

  it("sends the chosen schedule with the loaded version, then shows it as saved", async () => {
    const api = serve(
      differing,
      [],
      [() => new Response(JSON.stringify(loaded(fromAlerts, "2:200")), { status: 200 })]
    );
    const tree = await mount();

    await choose(tree, "Use 23:00 to 08:00");

    expect(api.chosen).toEqual([
      { choice: "alerts", quietHours: fromAlerts, expectedVersion: "1:100:abc" }
    ]);
    expect(out(tree)).toContain("Using your saved email alert schedule: 23:00 to 08:00.");
    expect(out(tree)).toContain(
      "Saved schedule: every day, 23:00 to 08:00, your profile time zone (Europe/Paris)."
    );
    expect(out(tree)).not.toContain("Your saved quiet hours differ.");
    expect(button(tree, "Save quiet hours")).toHaveLength(1);
  });

  it("keeps both schedules on offer when the choice fails, and retries the same choice", async () => {
    const api = serve(
      differing,
      [],
      [
        () => new Response(JSON.stringify({ error: "Settings are unavailable" }), { status: 503 }),
        () => new Response(JSON.stringify(loaded(overnight, "2:200")), { status: 200 })
      ]
    );
    const tree = await mount();

    await choose(tree, "Use 22:00 to 07:00 (America/Chicago)");

    expect(out(tree)).toContain(
      "Your choice could not save: Settings are unavailable. Your previous schedules still apply."
    );
    expect(out(tree)).toContain("Your saved quiet hours differ.");
    expect(button(tree, "Use 23:00 to 08:00")).toHaveLength(1);
    expect(button(tree, "Save quiet hours")).toHaveLength(0);

    await choose(tree, "Try again");

    expect(api.chosen).toHaveLength(2);
    expect(api.chosen[1]).toEqual(api.chosen[0]);
    expect(api.chosen[1]).toMatchObject({ choice: "profile", quietHours: overnight });
    expect(out(tree)).toContain(
      "Kept your saved quiet hours: 22:00 to 07:00, America/Chicago time."
    );
    expect(out(tree)).not.toContain("Try again");
  });

  it("shows the latest schedules when the choice lost to another change", async () => {
    const elsewhere = { ...overnight, start: "21:00" };
    const api = serve(
      differing,
      [],
      [
        () => {
          api.setStored(loaded(elsewhere, "2:200"));
          return new Response(JSON.stringify({ error: "conflict" }), { status: 409 });
        }
      ]
    );
    const tree = await mount();

    await choose(tree, "Use 23:00 to 08:00");

    expect(out(tree)).toContain(
      "Quiet hours changed somewhere else, so your choice was not saved."
    );
    expect(out(tree)).toContain("Saved schedule: every day, 21:00 to 07:00");
    expect(out(tree)).not.toContain("Your saved quiet hours differ.");
  });

  it("holds both choices while one is saving", async () => {
    let answer!: (response: Response) => void;
    serve(differing, [], [() => new Promise<Response>((resolve) => (answer = resolve))]);
    const tree = await mount();

    await choose(tree, "Use 23:00 to 08:00");

    expect(button(tree, "Use 23:00 to 08:00")[0]!.props.disabled).toBe(true);
    expect(button(tree, "Use 22:00 to 07:00 (America/Chicago)")[0]!.props.disabled).toBe(true);
    await act(async () => {
      answer(new Response(JSON.stringify(loaded(fromAlerts, "2:200")), { status: 200 }));
    });
    await flush();
    expect(out(tree)).toContain("Using your saved email alert schedule");
  });

  it("says when the saved schedule cannot be read in full, without calling it saved", async () => {
    serve(loaded(overnight, "1:100", { status: "malformed", alerts: null }));
    const tree = await mount();

    expect(out(tree)).toContain("Part of your saved quiet hours could not be read.");
    expect(out(tree)).toContain("Notifications follow: every day, 22:00 to 07:00");
    expect(out(tree)).not.toContain("Saved schedule");
  });

  it("holds the controls while loading and offers Try again after a failed load", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "Quiet hours are unavailable right now" }), {
          status: 503
        })
      )
    );
    const tree = await mount();

    expect(out(tree)).toContain("Quiet hours are unavailable right now");
    expect(button(tree, "Try again")).toHaveLength(1);
    expect(byLabel(tree, "Quiet hours from").props.disabled).toBe(true);
    expect(button(tree, "Save quiet hours")[0]!.props.disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });
});

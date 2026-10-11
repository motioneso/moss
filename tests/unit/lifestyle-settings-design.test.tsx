// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import WellnessSettings from "../../packages/wellness/src/settings/index.js";
import EmailSettings from "../../packages/email/src/settings/index.js";

function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } }
  });
}
function fail(queryClient: QueryClient, queryKey: readonly unknown[]) {
  queryClient
    .getQueryCache()
    .build(queryClient, { queryKey })
    .setState({ status: "error", error: new Error("Read failed"), fetchStatus: "idle" });
}
function renderSettings(queryClient: QueryClient, wellness = true) {
  return renderToString(
    <QueryClientProvider client={queryClient}>
      {wellness ? <WellnessSettings /> : <EmailSettings />}
    </QueryClientProvider>
  );
}
afterEach(() => vi.unstubAllGlobals());

describe("Unverified settings are never presented as saved switches", () => {
  it.each([true, false])(
    "shows a loading sentence instead of interactive defaults (wellness=%s)",
    (wellness) => {
      const html = renderSettings(client(), wellness);
      expect(html).toContain("Loading");
      expect(html).not.toContain('type="checkbox"');
      expect(html).not.toContain("Could not save");
    }
  );
  it("offers a Wellness read retry without confusing it with save failure", () => {
    const queryClient = client();
    fail(queryClient, ["wellness", "ai-consent"]);
    const html = renderSettings(queryClient);
    expect(html).toContain("Could not load Wellness AI access");
    expect(html).toContain("Try again");
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("Could not save");
  });
  it("offers Email read retry and prevents partial reads from authorizing default changes", () => {
    const queryClient = client();
    queryClient.setQueryData(["settings", "source-behaviors"], { sources: [] });
    fail(queryClient, ["email", "briefing-settings"]);
    const html = renderSettings(queryClient, false);
    expect(html).toContain("Could not load email settings");
    expect(html).toContain("Try again");
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("Could not save");
  });
  it("retains the last confirmed Wellness choice on refresh failure", () => {
    const queryClient = client();
    queryClient.setQueryData(["wellness", "ai-consent"], { effective: false, explicit: false });
    fail(queryClient, ["wellness", "ai-consent"]);
    const html = renderSettings(queryClient);
    expect(html).toContain("Showing the last saved choice");
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('checked=""');
  });
  it("announces a failed Wellness write while preserving the confirmed value", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 }))
    );
    const queryClient = client();
    queryClient.setQueryData(["wellness", "ai-consent"], { effective: false, explicit: false });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={queryClient}>
          <WellnessSettings />
        </QueryClientProvider>
      );
    });
    await act(async () => {
      renderer.root.findByType("input").props.onChange({ target: { checked: true } });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(renderer.root.findByType("input").props.checked).toBe(false);
    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(1);
    await act(async () => renderer.unmount());
    queryClient.clear();
  });
});

const emailSettings = {
  createTasks: true,
  suggestReplies: true,
  draftReplies: true,
  autoSend: false
};
const sourceResponse = (enabled: boolean) => ({
  sources: [
    {
      id: "email",
      name: "Email",
      description: "",
      behaviors: [
        {
          id: "email.briefings",
          sourceId: "email",
          name: "Email",
          description: "",
          default: "default-on",
          enabled,
          toggleable: true
        }
      ]
    }
  ]
});
const policyResponse = (tier: string) => ({
  moduleId: "email",
  actionFamilyId: "email_drafts",
  tier
});
const otherPolicy = { moduleId: "calendar", actionFamilyId: "events", tier: "ask_each_time" };
const readFixtures = [
  {
    key: ["settings", "source-behaviors"],
    path: "/api/me/source-behaviors",
    data: sourceResponse(true)
  },
  {
    key: ["email", "briefing-settings"],
    path: "/api/email/briefing-settings",
    data: { settings: emailSettings }
  },
  { key: ["email", "task-mode"], path: "/api/email/task-creation-mode", data: { mode: "suggest" } },
  {
    key: ["ai", "action-policy"],
    path: "/api/ai/action-policy",
    data: { policies: [otherPolicy, policyResponse("trusted_auto")] }
  },
  {
    key: ["wellness", "ai-consent"],
    path: "/api/wellness/ai-consent",
    data: { effective: true, explicit: true }
  }
];
const raceCases = [
  {
    label: "Allow your assistant to read your wellness data",
    index: 4,
    oldValue: true,
    newValue: false,
    write: { effective: false, explicit: false },
    wellness: true
  },
  {
    label: "Include email signal in briefings",
    index: 0,
    oldValue: true,
    newValue: false,
    write: sourceResponse(false)
  },
  ...(
    [
      ["Create tasks from email signals", "createTasks"],
      ["Suggest replies", "suggestReplies"],
      ["Draft replies", "draftReplies"],
      ["Auto-send replies", "autoSend"]
    ] as const
  ).map(([label, field]) => ({
    label,
    index: 1,
    oldValue: emailSettings[field],
    newValue: !emailSettings[field],
    write: { settings: { ...emailSettings, [field]: !emailSettings[field] } }
  })),
  {
    label: "Email task creation mode",
    index: 2,
    oldValue: "suggest",
    newValue: "off",
    write: { mode: "off" }
  },
  {
    label: "Let your assistant draft email replies without asking",
    index: 3,
    oldValue: true,
    newValue: false,
    write: policyResponse("ask_each_time")
  }
];
function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
const flushSettings = async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
};

async function settingsRaceHarness(target: (typeof raceCases)[number], staleError = false) {
  const queryClient = client();
  for (const fixture of readFixtures) queryClient.setQueryData(fixture.key, fixture.data);
  const fixture = readFixtures[target.index]!;
  if (staleError) fail(queryClient, fixture.key);
  const write = deferredResponse();
  const retryWrite = deferredResponse();
  let writes = 0;
  const reads: ReturnType<typeof deferredResponse>[] = [];
  let freshRead = false;
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === "PUT" || init?.method === "PATCH")
      return writes++ === 0 ? write.promise : retryWrite.promise;
    if (path === fixture.path && !freshRead) {
      const read = deferredResponse();
      reads.push(read);
      return read.promise;
    }
    return jsonResponse(readFixtures.find((item) => item.path === path)!.data);
  });
  vi.stubGlobal("fetch", fetchMock);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={queryClient}>
        {"wellness" in target ? <WellnessSettings /> : <EmailSettings />}
      </QueryClientProvider>
    );
  });
  const control = () =>
    renderer.root.find(
      (node) =>
        (node.type === "input" || node.type === "select") &&
        node.props["aria-label"] === target.label
    );
  const value = () =>
    typeof target.oldValue === "string" ? control().props.value : control().props.checked;
  const change = async () =>
    act(async () => {
      control().props.onChange(
        typeof target.newValue === "string"
          ? { currentTarget: { value: target.newValue } }
          : { target: { checked: target.newValue } }
      );
      await flushSettings();
    });
  const refresh = async () =>
    act(async () => {
      void queryClient.refetchQueries({ queryKey: fixture.key, exact: true });
      await flushSettings();
    });
  return {
    queryClient,
    renderer,
    fixture,
    write,
    retryWrite,
    reads,
    control,
    value,
    change,
    refresh,
    fetchMock,
    freshRead: () => {
      freshRead = true;
    },
    cleanup: async () => {
      await act(async () => renderer.unmount());
      queryClient.clear();
    }
  };
}

describe("Settings write/read ordering", () => {
  for (const target of raceCases) {
    it.each(["before write", "during write", "stale-read retry"])(
      `${target.label}: ignores an older GET (%s) but accepts a later authoritative refresh`,
      async (timing) => {
        const test = await settingsRaceHarness(target, timing === "stale-read retry");
        try {
          expect(test.value()).toBe(target.oldValue);
          if (timing === "before write") await test.refresh();
          if (timing === "stale-read retry") {
            await act(async () => {
              test.renderer.root
                .findAllByType("button")
                .find((button) => button.children.includes("Try again"))!
                .props.onClick();
              await flushSettings();
            });
          }
          await test.change();
          expect(test.control().props.disabled).toBe(true);
          if (timing === "during write") await test.refresh();
          expect(test.reads).toHaveLength(1);
          await act(async () => {
            test.write.resolve(jsonResponse(target.write));
            await flushSettings();
          });
          expect(test.value()).toBe(target.newValue);
          expect(test.control().props.disabled).toBe(false);
          await act(async () => {
            test.reads[0]!.resolve(jsonResponse(test.fixture.data));
            await flushSettings();
          });
          expect(test.value()).toBe(target.newValue);
          if (target.index === 3)
            expect(
              test.queryClient.getQueryData<{ policies: unknown[] }>(test.fixture.key)!.policies
            ).toContainEqual(otherPolicy);
          test.freshRead();
          await test.refresh();
          expect(test.value()).toBe(target.oldValue);
        } finally {
          await test.cleanup();
        }
      }
    );
    it(`${target.label}: keeps the confirmed value after a failed write and supports read and write retry`, async () => {
      const test = await settingsRaceHarness(target, true);
      try {
        await test.change();
        await act(async () => {
          test.write.resolve(new Response("", { status: 503 }));
          await flushSettings();
        });
        expect(test.value()).toBe(target.oldValue);
        expect(test.control().props.disabled).toBe(false);
        expect(test.renderer.root.findAllByProps({ role: "alert" })).toHaveLength(1);
        test.freshRead();
        await act(async () => {
          test.renderer.root
            .findAllByType("button")
            .find((button) => button.children.includes("Try again"))!
            .props.onClick();
          await flushSettings();
        });
        expect(test.value()).toBe(target.oldValue);
        expect(test.queryClient.getQueryState(test.fixture.key)?.status).toBe("success");
        await test.change();
        await act(async () => {
          test.retryWrite.resolve(jsonResponse(target.write));
          await flushSettings();
        });
        expect(test.value()).toBe(target.newValue);
        expect(test.renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
      } finally {
        await test.cleanup();
      }
    });
  }
});

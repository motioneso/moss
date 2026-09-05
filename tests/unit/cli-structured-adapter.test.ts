import { describe, expect, it, vi } from "vitest";

import { CliStructuredAdapter } from "../../packages/chat/src/live/cli-structured-adapter.js";
import type { ChatEngineFactory } from "../../packages/chat/src/live/runtime.js";

describe("CliStructuredAdapter (#982/#869/#981)", () => {
  it("runs the existing one-shot engine and returns raw reply text", async () => {
    const launch = vi.fn(async () => ({ offset: 0 }));
    const submit = vi.fn(async (_text: string) => undefined);
    const factory: ChatEngineFactory = () => ({
      provider: "anthropic",
      launch,
      submit,
      readNew: vi.fn(async () => ({
        records: [{ kind: "reply" as const, text: '{"ok":true}' }],
        offset: 12,
        complete: true
      })),
      interrupt: vi.fn(async () => undefined),
      isAlive: vi.fn(async () => false),
      kill: vi.fn(async () => undefined)
    });
    const adapter = new CliStructuredAdapter("anthropic", factory, 1_000, 0);

    const result = await adapter.generateStructured({
      model: { provider_kind: "anthropic", provider_model_id: "claude-opus-4-8" },
      messages: [{ role: "user", content: "Extract a value" }],
      schema: { type: "object", required: ["ok"] },
      maxOutputTokens: 100
    });

    expect(result).toEqual({
      rawText: '{"ok":true}',
      usage: { inputTokens: 0, outputTokens: 0 }
    });
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-opus-4-8", personaText: expect.any(String) })
    );
    expect(submit.mock.calls[0]?.[0]).toContain("Respond with ONLY a JSON object");
  });

  it("keeps a valid reply that becomes readable during bounded CLI teardown", async () => {
    let tornDown = false;
    const factory: ChatEngineFactory = () => ({
      provider: "anthropic",
      launch: vi.fn(async () => ({ offset: 0 })),
      submit: vi.fn(async () => undefined),
      readNew: vi.fn(async () =>
        tornDown
          ? {
              records: [{ kind: "reply" as const, text: '{"ok":true}' }],
              offset: 12,
              complete: true
            }
          : { records: [], offset: 0, complete: false }
      ),
      interrupt: vi.fn(async () => undefined),
      isAlive: vi.fn(async () => !tornDown),
      kill: vi.fn(async () => {
        tornDown = true;
      })
    });
    const adapter = new CliStructuredAdapter("anthropic", factory, 5, 0);

    await expect(
      adapter.generateStructured({
        model: { provider_kind: "anthropic", provider_model_id: "configured-model" },
        messages: [{ role: "user", content: "Extract a value" }],
        schema: { type: "object", required: ["ok"] },
        maxOutputTokens: 100
      })
    ).resolves.toMatchObject({ rawText: '{"ok":true}' });
  });

  it("selects a waiting foreground call before FIFO background calls", async () => {
    let factoryCalls = 0;
    let releaseActive!: () => void;
    const activeReleased = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    const started: string[] = [];
    const factory: ChatEngineFactory = () => {
      const call = factoryCalls++;
      return {
        provider: "anthropic",
        launch: vi.fn(async () => {
          return { offset: 0 };
        }),
        submit: vi.fn(async (text: string) => {
          started.push(
            ["active", "background-one", "background-two", "foreground"].find((marker) =>
              text.includes(marker)
            ) ?? "unknown"
          );
        }),
        readNew: vi.fn(async () => {
          if (call === 0) await activeReleased;
          return {
            records: [{ kind: "reply" as const, text: `{"call":${call}}` }],
            offset: 1,
            complete: true
          };
        }),
        interrupt: vi.fn(async () => undefined),
        isAlive: vi.fn(async () => false),
        kill: vi.fn(async () => undefined)
      };
    };
    const adapter = new CliStructuredAdapter("anthropic", factory, 1_000, 0);
    const inputFor = (priority: "foreground" | "background", marker: string) => ({
      model: { provider_kind: "anthropic" as const, provider_model_id: "configured-model" },
      messages: [{ role: "user" as const, content: marker }],
      schema: { type: "object" },
      maxOutputTokens: 100,
      priority
    });

    const active = adapter.generateStructured(inputFor("foreground", "active"));
    await vi.waitFor(() => expect(started).toEqual(["active"]));
    const backgroundOne = adapter.generateStructured(inputFor("background", "background-one"));
    const backgroundTwo = adapter.generateStructured(inputFor("background", "background-two"));
    const foreground = adapter.generateStructured(inputFor("foreground", "foreground"));

    releaseActive();
    await Promise.all([active, backgroundOne, backgroundTwo, foreground]);

    expect(started).toEqual(["active", "foreground", "background-one", "background-two"]);
  });

  it("reports a print child exit when no transcript reply becomes readable", async () => {
    const events: Array<{ kind: string; exit?: string }> = [];
    const factory: ChatEngineFactory = () => ({
      provider: "anthropic",
      launch: vi.fn(async () => ({ offset: 0 })),
      submit: vi.fn(async () => undefined),
      readNew: vi.fn(async () => ({ records: [], offset: 0, complete: false })),
      interrupt: vi.fn(async () => undefined),
      isAlive: vi.fn(async () => false),
      kill: vi.fn(async () => undefined)
    });
    const adapter = new CliStructuredAdapter("anthropic", factory, 50, 0);

    await expect(
      adapter.generateStructured({
        model: { provider_kind: "anthropic", provider_model_id: "configured-model" },
        messages: [{ role: "user", content: "Return one JSON object." }],
        schema: { type: "object" },
        maxOutputTokens: 100,
        telemetry: { emit: (event) => events.push({ kind: event.kind, exit: event.exit }) }
      })
    ).rejects.toMatchObject({ name: "CliChatUnavailableError" });

    expect(events.map((event) => event.kind)).toEqual(["invoked", "exit", "elapsed"]);
    expect(events[1]).toMatchObject({ kind: "exit", exit: "no-reply" });
  });

  it("retains one structured stream per exact run scope and closes it explicitly", async () => {
    let launchCount = 0;
    let submitCount = 0;
    let killCount = 0;
    const factory: ChatEngineFactory = () => {
      const resultOffset = 0;
      const structured = {
        launchStructured: vi.fn(async () => {
          launchCount += 1;
          return { offset: 0 };
        }),
        submitStructured: vi.fn(async () => {
          submitCount += 1;
        }),
        readStructured: vi.fn(async (afterOffset: number) => ({
          text: JSON.stringify({ ok: true, index: resultOffset }),
          offset: afterOffset + 1,
          complete: true
        }))
      };
      return {
        provider: "anthropic",
        launch: vi.fn(async () => ({ offset: 0 })),
        submit: vi.fn(async () => undefined),
        readNew: vi.fn(async () => ({ records: [], offset: 0, complete: false })),
        interrupt: vi.fn(async () => undefined),
        isAlive: vi.fn(async () => true),
        kill: vi.fn(async () => {
          killCount += 1;
        }),
        ...structured
      } as never;
    };
    const adapter = new CliStructuredAdapter("anthropic", factory, 1_000, 0);
    const scope = {
      actorUserId: "actor-1",
      connectorAccountId: "account-1",
      lineageId: "run-1"
    };
    const input = (closeScope = false) => ({
      model: { provider_kind: "anthropic" as const, provider_model_id: "configured-model" },
      messages: [{ role: "user" as const, content: "synthetic" }],
      schema: { type: "object", required: ["ok"] },
      maxOutputTokens: 100,
      scope,
      closeScope
    });

    await adapter.generateStructured(input());
    await adapter.generateStructured(input(true));

    expect(launchCount).toBe(1);
    expect(submitCount).toBe(2);
    expect(killCount).toBe(1);
  });

  it("does not reuse a retained stream across actor/account/run scopes", async () => {
    let launchCount = 0;
    const factory: ChatEngineFactory = () => {
      const structured = {
        launchStructured: vi.fn(async () => {
          launchCount += 1;
          return { offset: 0 };
        }),
        submitStructured: vi.fn(async () => undefined),
        readStructured: vi.fn(async () => ({
          text: JSON.stringify({ ok: true }),
          offset: 1,
          complete: true
        }))
      };
      return {
        provider: "anthropic",
        launch: vi.fn(async () => ({ offset: 0 })),
        submit: vi.fn(async () => undefined),
        readNew: vi.fn(async () => ({ records: [], offset: 0, complete: false })),
        interrupt: vi.fn(async () => undefined),
        isAlive: vi.fn(async () => true),
        kill: vi.fn(async () => undefined),
        ...structured
      } as never;
    };
    const adapter = new CliStructuredAdapter("anthropic", factory, 1_000, 0);
    const makeInput = (actorUserId: string) => ({
      model: { provider_kind: "anthropic" as const, provider_model_id: "configured-model" },
      messages: [{ role: "user" as const, content: "synthetic" }],
      schema: { type: "object", required: ["ok"] },
      maxOutputTokens: 100,
      scope: { actorUserId, connectorAccountId: "account-1", lineageId: "run-1" },
      closeScope: true
    });

    await adapter.generateStructured(makeInput("actor-1"));
    await adapter.generateStructured(makeInput("actor-2"));

    expect(launchCount).toBe(2);
  });

  it("terminates a scoped stream when no complete reply is readable", async () => {
    let killCount = 0;
    const factory: ChatEngineFactory = () =>
      ({
        provider: "anthropic",
        launch: vi.fn(async () => ({ offset: 0 })),
        submit: vi.fn(async () => undefined),
        readNew: vi.fn(async () => ({ records: [], offset: 0, complete: false })),
        interrupt: vi.fn(async () => undefined),
        isAlive: vi.fn(async () => false),
        kill: vi.fn(async () => {
          killCount += 1;
        }),
        launchStructured: vi.fn(async () => ({ offset: 0 })),
        submitStructured: vi.fn(async () => undefined),
        readStructured: vi.fn(async () => ({ offset: 0, complete: false }))
      }) as never;
    const adapter = new CliStructuredAdapter("anthropic", factory, 1_000, 0);

    await expect(
      adapter.generateStructured({
        model: { provider_kind: "anthropic", provider_model_id: "configured-model" },
        messages: [{ role: "user", content: "synthetic" }],
        schema: { type: "object" },
        maxOutputTokens: 100,
        scope: { actorUserId: "actor-1", connectorAccountId: "account-1", lineageId: "run-1" }
      })
    ).rejects.toMatchObject({ name: "CliChatUnavailableError" });
    expect(killCount).toBe(1);
  });
});

// ─── #2228: built-in web search for command-line models ───────────────────────────────────────
describe("CliStructuredAdapter — nativeSearch and sources (#2228)", () => {
  it("forwards nativeSearch to the launch and returns the sources the CLI's search reported", async () => {
    const launch = vi.fn(async () => ({ offset: 0 }));
    let call = 0;
    const factory: ChatEngineFactory = () => ({
      provider: "anthropic",
      launch,
      submit: vi.fn(async () => undefined),
      readNew: vi.fn(async () => {
        call += 1;
        return call === 1
          ? {
              records: [
                {
                  kind: "tool" as const,
                  text: "",
                  toolCallId: "toolu_1",
                  sources: [{ title: "A", url: "https://example.com/a" }]
                }
              ],
              offset: 5,
              complete: false
            }
          : {
              records: [
                {
                  kind: "tool" as const,
                  text: "",
                  toolCallId: "toolu_2",
                  sources: [
                    { title: "A again", url: "https://example.com/a" },
                    { title: "B", url: "https://example.com/b" }
                  ]
                },
                { kind: "reply" as const, text: '{"ok":true}' }
              ],
              offset: 12,
              complete: true
            };
      }),
      interrupt: vi.fn(async () => undefined),
      isAlive: vi.fn(async () => true),
      kill: vi.fn(async () => undefined)
    });
    const adapter = new CliStructuredAdapter("anthropic", factory, 1_000, 0);

    const result = await adapter.generateStructured({
      model: { provider_kind: "anthropic", provider_model_id: "claude-opus-4-8" },
      messages: [{ role: "user", content: "What happened today?" }],
      schema: { type: "object", required: ["ok"] },
      maxOutputTokens: 100,
      nativeSearch: true
    });

    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ nativeSearch: true }));
    expect(result).toEqual({
      rawText: '{"ok":true}',
      usage: { inputTokens: 0, outputTokens: 0 },
      sources: [
        { title: "A", url: "https://example.com/a" },
        { title: "B", url: "https://example.com/b" }
      ]
    });
  });

  it("omits nativeSearch from the launch and sources from the result when search was not asked for", async () => {
    const launch = vi.fn(async () => ({ offset: 0 }));
    const factory: ChatEngineFactory = () => ({
      provider: "anthropic",
      launch,
      submit: vi.fn(async () => undefined),
      readNew: vi.fn(async () => ({
        records: [{ kind: "reply" as const, text: '{"ok":true}' }],
        offset: 12,
        complete: true
      })),
      interrupt: vi.fn(async () => undefined),
      isAlive: vi.fn(async () => false),
      kill: vi.fn(async () => undefined)
    });
    const adapter = new CliStructuredAdapter("anthropic", factory, 1_000, 0);

    const result = await adapter.generateStructured({
      model: { provider_kind: "anthropic", provider_model_id: "claude-opus-4-8" },
      messages: [{ role: "user", content: "Extract a value" }],
      schema: { type: "object", required: ["ok"] },
      maxOutputTokens: 100
    });

    expect(launch.mock.calls[0]?.[0]).not.toHaveProperty("nativeSearch");
    expect(result).not.toHaveProperty("sources");
  });

  it("keeps sources on a reply that only becomes readable during teardown", async () => {
    let tornDown = false;
    const factory: ChatEngineFactory = () => ({
      provider: "anthropic",
      launch: vi.fn(async () => ({ offset: 0 })),
      submit: vi.fn(async () => undefined),
      readNew: vi.fn(async () =>
        tornDown
          ? {
              records: [
                {
                  kind: "tool" as const,
                  text: "",
                  sources: [{ title: "Late", url: "https://example.com/late" }]
                },
                { kind: "reply" as const, text: '{"ok":true}' }
              ],
              offset: 12,
              complete: true
            }
          : { records: [], offset: 0, complete: false }
      ),
      interrupt: vi.fn(async () => undefined),
      isAlive: vi.fn(async () => true),
      kill: vi.fn(async () => {
        tornDown = true;
      })
    });
    const adapter = new CliStructuredAdapter("anthropic", factory, 20, 0);

    const result = await adapter.generateStructured({
      model: { provider_kind: "anthropic", provider_model_id: "claude-opus-4-8" },
      messages: [{ role: "user", content: "Extract a value" }],
      schema: { type: "object", required: ["ok"] },
      maxOutputTokens: 100,
      nativeSearch: true
    });

    expect(result).toEqual({
      rawText: '{"ok":true}',
      usage: { inputTokens: 0, outputTokens: 0 },
      sources: [{ title: "Late", url: "https://example.com/late" }]
    });
  });
});

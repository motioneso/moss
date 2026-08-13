import { describe, expect, it } from "vitest";

import {
  AssistantToolGateway,
  compilePattern,
  ConfirmationRegistry,
  SessionTokenRegistry,
  ToolInputValidationError,
  validateToolInput
} from "@moss/ai";
import type { ModuleAssistantToolManifest } from "@moss/module-sdk";
import { tasksModuleManifest } from "@moss/tasks";
import { getBuiltInModuleManifests } from "@moss/module-registry";

describe("tool input validation", () => {
  const schema = {
    type: "object",
    required: ["taskId"],
    properties: { taskId: { type: "string" }, count: { type: "number" } }
  };

  it("accepts valid input", () => {
    expect(validateToolInput(schema, { taskId: "t1", count: 2 })).toEqual({
      taskId: "t1",
      count: 2
    });
  });

  it("rejects a missing required key", () => {
    expect(() => validateToolInput(schema, { count: 2 })).toThrow(ToolInputValidationError);
  });

  it("rejects a wrong declared type", () => {
    expect(() => validateToolInput(schema, { taskId: 5 })).toThrow(ToolInputValidationError);
  });

  it("accepts anything when no schema is declared", () => {
    expect(validateToolInput(undefined, { whatever: true })).toEqual({ whatever: true });
  });

  // #1265 security QA BLOCKING-1(b): the sports follow tools bound their catalog keys with
  // minLength/maxLength/pattern precisely so a model-supplied key cannot be arbitrary. Those
  // keywords were previously parsed by nobody, which would have made the manifest bound decorative
  // — a declared belt that never fires. This is the gateway chokepoint for every module's tool
  // input, so the enforcement lives here rather than in any one module.
  describe("string bounds", () => {
    const bounded = {
      type: "object",
      required: ["key"],
      properties: {
        key: { type: "string", minLength: 1, maxLength: 8, pattern: "^[a-z0-9.]{1,8}$" }
      }
    };

    it("accepts a value inside every bound", () => {
      expect(validateToolInput(bounded, { key: "eng.1" })).toEqual({ key: "eng.1" });
    });

    it("reproduces the external-module ReDoS host-loop stall", () => {
      const started = performance.now();
      expect(() =>
        validateToolInput(
          {
            type: "object",
            properties: { value: { type: "string", pattern: "(a+)+$" } }
          },
          { value: `${"a".repeat(28)}!` }
        )
      ).toThrow(ToolInputValidationError);
      // This is deliberately a wide safety margin around the ~1.5s V8 stall on the
      // current host. The fixed path must move this work off the API event loop.
      expect(performance.now() - started).toBeLessThan(500);
    });

    it("rejects a value over maxLength", () => {
      expect(() => validateToolInput(bounded, { key: "abcdefghij" })).toThrow(
        ToolInputValidationError
      );
    });

    it("rejects a value under minLength", () => {
      expect(() => validateToolInput(bounded, { key: "" })).toThrow(ToolInputValidationError);
    });

    it("rejects a value that does not match the pattern", () => {
      expect(() => validateToolInput(bounded, { key: "../evil" })).toThrow(
        ToolInputValidationError
      );
    });

    // An unanchored pattern must not be satisfied by a matching substring — otherwise
    // "ok/../../etc" would pass a naive `/[a-z]+/.test(...)`.
    it("requires the whole string to match, not a substring", () => {
      const loose = { type: "object", properties: { key: { type: "string", pattern: "[a-z]+" } } };
      expect(() => validateToolInput(loose, { key: "ok/../evil" })).toThrow(
        ToolInputValidationError
      );
    });

    it("leaves non-strings and undeclared bounds alone", () => {
      const mixed = {
        type: "object",
        properties: { n: { type: "number" }, s: { type: "string" } }
      };
      expect(validateToolInput(mixed, { n: 12345678901234, s: "anything at all" })).toEqual({
        n: 12345678901234,
        s: "anything at all"
      });
    });

    // #1265 QA follow-up: compilePattern's catch used to swallow an unparseable `pattern` and
    // return null, which skipped the enforcement guard entirely and admitted unvalidated input.
    // Nothing lints inputSchema patterns before a built-in tool ships (see #1274 for the
    // install-time lint this is a stopgap for), so this asserts the invariant here instead: every
    // built-in tool's declared pattern must compile via the REAL exported compilePattern, not a
    // re-implemented copy that stays green if production's wrapper or flag changes.
    it("compiles every built-in tool's declared inputSchema pattern via the real compilePattern", () => {
      interface PatternWalkNode {
        readonly pattern?: string;
        readonly properties?: Record<string, PatternWalkNode>;
        readonly items?: PatternWalkNode;
      }

      const collectPatterns = (node: PatternWalkNode | undefined, patterns: string[]): void => {
        if (!node) return;
        if (typeof node.pattern === "string") patterns.push(node.pattern);
        if (node.properties) {
          for (const child of Object.values(node.properties)) collectPatterns(child, patterns);
        }
        if (node.items) collectPatterns(node.items, patterns);
      };

      const manifests = getBuiltInModuleManifests();
      const patterns: string[] = [];
      for (const manifest of manifests) {
        for (const tool of manifest.assistantTools ?? []) {
          collectPatterns(tool.inputSchema as PatternWalkNode | undefined, patterns);
        }
      }

      expect(patterns.length).toBeGreaterThan(0);
      for (const pattern of patterns) {
        expect(
          () => compilePattern(pattern),
          `pattern failed to compile: ${pattern}`
        ).not.toThrow();
      }
    });

    // #1265 security QA BLOCKING-1: compilePattern must fail CLOSED, not silently skip the bound.
    describe("compilePattern fails closed", () => {
      it("rejects a pattern that throws under /u instead of admitting all input", () => {
        // Bare `\-` outside a character class is invalid under /u — a common JSON-Schema idiom
        // (e.g. `^\d{4}\-\d{2}\-\d{2}$`) that used to compile to null and skip the guard entirely.
        expect(() => compilePattern("^\\d{4}\\-\\d{2}\\-\\d{2}$")).toThrow(
          ToolInputValidationError
        );
      });

      it("rejects an unbalanced-paren pattern rather than compiling a wrapper that matches anything", () => {
        // Wrapping `[a-z]+)|(.*` as `^(?:[a-z]+)|(.*)$` is valid regex whose top-level alternation
        // sits OUTSIDE the anchors and matches any string. Must be rejected before it is wrapped.
        expect(() => compilePattern("[a-z]+)|(.*")).toThrow(ToolInputValidationError);
        expect(() =>
          validateToolInput(
            { type: "object", properties: { key: { type: "string", pattern: "[a-z]+)|(.*" } } },
            { key: "HOSTILE ANYTHING AT ALL" }
          )
        ).toThrow(ToolInputValidationError);
      });

      it("caches the rejection so a broken pattern keeps rejecting on repeat calls", () => {
        expect(() => compilePattern("\\-broken")).toThrow(ToolInputValidationError);
        expect(() => compilePattern("\\-broken")).toThrow(ToolInputValidationError);
      });

      it("still anchors and matches correctly for a valid pattern", () => {
        const re = compilePattern("[a-z]+");
        expect(re.test("abc")).toBe(true);
        expect(re.test("ok/../evil")).toBe(false);
      });
    });
  });
});

describe("gateway tool output sanitization", () => {
  const runner = {
    withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) => work({})
  };

  it("accepts real task list-family output schemas for items-shaped tool results", async () => {
    const listFamilyTools = [
      "tasks.list",
      "tasks.focus",
      "tasks.atRisk",
      "tasks.overdue",
      "tasks.listLists",
      "tasks.listTags"
    ];
    const taskTools = tasksModuleManifest.assistantTools ?? [];
    const tools = listFamilyTools.map((name) => {
      const tool = taskTools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`missing ${name}`);
      return {
        ...tool,
        execute: async () => ({ data: { items: [] }, columnOrder: ["id"] })
      } satisfies ModuleAssistantToolManifest;
    });
    const tokens = new SessionTokenRegistry();
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [
        {
          id: "tasks",
          name: "Tasks",
          version: "1.0.0",
          publisher: "Jarv1s",
          lifecycle: "required",
          compatibility: { jarv1s: "*" },
          assistantTools: tools
        }
      ],
      repository: {} as never,
      runner: runner as never,
      tokens,
      confirmations: new ConfirmationRegistry(),
      notifier: { emit: () => {} },
      confirmTimeoutMs: 1000
    });
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    for (const toolName of listFamilyTools) {
      const res = await gateway.callTool(
        token,
        toolName,
        toolName === "tasks.listTags" ? { listId: "l1" } : {}
      );

      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error(`expected ${toolName} ok`);
      expect((res.data as { text: string }).text).toContain("items");
    }
  });

  it("drops undeclared output fields before rendering a tool result", async () => {
    const tokens = new SessionTokenRegistry();
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [
        {
          id: "example",
          name: "Example",
          version: "1.0.0",
          publisher: "Jarv1s",
          lifecycle: "optional",
          compatibility: { jarv1s: "*" },
          assistantTools: [
            {
              name: "example.safe",
              description: "Safe output.",
              permissionId: "example.view",
              risk: "read",
              outputSchema: {
                type: "object",
                properties: { visible: { type: "string" } },
                required: ["visible"]
              },
              execute: async () => ({
                data: { visible: "ok", secret: "SECRET", nested: { token: "TOKEN" } }
              })
            }
          ]
        }
      ],
      repository: {} as never,
      runner: runner as never,
      tokens,
      confirmations: new ConfirmationRegistry(),
      notifier: { emit: () => {} },
      confirmTimeoutMs: 1000
    });
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    const res = await gateway.callTool(token, "example.safe", {});

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const text = (res.data as { text: string }).text;
    expect(text).toContain("visible");
    expect(text).toContain("ok");
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("TOKEN");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("nested");
  });

  it("drops undeclared nested fields under declared output fields", async () => {
    const tokens = new SessionTokenRegistry();
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [
        {
          id: "example",
          name: "Example",
          version: "1.0.0",
          publisher: "Jarv1s",
          lifecycle: "optional",
          compatibility: { jarv1s: "*" },
          assistantTools: [
            {
              name: "example.nested-safe",
              description: "Nested safe output.",
              permissionId: "example.view",
              risk: "read",
              outputSchema: {
                type: "object",
                properties: {
                  messages: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        text: { type: "string" },
                        author: {
                          type: "object",
                          properties: { displayName: { type: "string" } },
                          required: ["displayName"]
                        }
                      },
                      required: ["id", "text", "author"]
                    }
                  }
                },
                required: ["messages"]
              },
              execute: async () => ({
                data: {
                  messages: [
                    {
                      id: "m1",
                      text: "hello",
                      author: { displayName: "Ada", email: "ada@example.test", token: "TOKEN" },
                      privateNote: "SECRET"
                    }
                  ]
                }
              })
            }
          ]
        }
      ],
      repository: {} as never,
      runner: runner as never,
      tokens,
      confirmations: new ConfirmationRegistry(),
      notifier: { emit: () => {} },
      confirmTimeoutMs: 1000
    });
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    const res = await gateway.callTool(token, "example.nested-safe", {});

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const text = (res.data as { text: string }).text;
    expect(text).toContain("messages");
    expect(text).toContain("hello");
    expect(text).toContain("Ada");
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("TOKEN");
    expect(text).not.toContain("privateNote");
    expect(text).not.toContain("email");
  });

  it("fails closed when a declared scalar output field receives an object", async () => {
    const tokens = new SessionTokenRegistry();
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [
        {
          id: "example",
          name: "Example",
          version: "1.0.0",
          publisher: "Jarv1s",
          lifecycle: "optional",
          compatibility: { jarv1s: "*" },
          assistantTools: [
            {
              name: "example.scalar-object-leak",
              description: "Scalar object leak probe.",
              permissionId: "example.view",
              risk: "read",
              outputSchema: {
                type: "object",
                properties: { visible: { type: "string" } },
                required: ["visible"]
              },
              execute: async () => ({ data: { visible: { secret: "SECRET" } } })
            }
          ]
        }
      ],
      repository: {} as never,
      runner: runner as never,
      tokens,
      confirmations: new ConfirmationRegistry(),
      notifier: { emit: () => {} },
      confirmTimeoutMs: 1000
    });
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    const res = await gateway.callTool(token, "example.scalar-object-leak", {});

    expect(res).toEqual({ ok: false, error: "Tool example.scalar-object-leak failed" });
    if (res.ok) {
      expect((res.data as { text: string }).text).not.toContain("SECRET");
    }
  });

  it("fails closed when a nullable scalar output field receives an object", async () => {
    const tokens = new SessionTokenRegistry();
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [
        {
          id: "example",
          name: "Example",
          version: "1.0.0",
          publisher: "Jarv1s",
          lifecycle: "optional",
          compatibility: { jarv1s: "*" },
          assistantTools: [
            {
              name: "example.nullable-scalar-object-leak",
              description: "Nullable scalar object leak probe.",
              permissionId: "example.view",
              risk: "read",
              outputSchema: {
                type: "object",
                properties: { visible: { anyOf: [{ type: "string" }, { type: "null" }] } },
                required: ["visible"]
              },
              execute: async () => ({ data: { visible: { secret: "SECRET" } } })
            }
          ]
        }
      ],
      repository: {} as never,
      runner: runner as never,
      tokens,
      confirmations: new ConfirmationRegistry(),
      notifier: { emit: () => {} },
      confirmTimeoutMs: 1000
    });
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    const res = await gateway.callTool(token, "example.nullable-scalar-object-leak", {});

    expect(res).toEqual({ ok: false, error: "Tool example.nullable-scalar-object-leak failed" });
    if (res.ok) {
      expect((res.data as { text: string }).text).not.toContain("SECRET");
    }
  });

  it("fails closed when required output fields are missing", async () => {
    const tokens = new SessionTokenRegistry();
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [
        {
          id: "example",
          name: "Example",
          version: "1.0.0",
          publisher: "Jarv1s",
          lifecycle: "optional",
          compatibility: { jarv1s: "*" },
          assistantTools: [
            {
              name: "example.invalid-output",
              description: "Invalid output.",
              permissionId: "example.view",
              risk: "read",
              outputSchema: {
                type: "object",
                properties: { visible: { type: "string" } },
                required: ["visible"]
              },
              execute: async () => ({ data: { other: "value" } })
            }
          ]
        }
      ],
      repository: {} as never,
      runner: runner as never,
      tokens,
      confirmations: new ConfirmationRegistry(),
      notifier: { emit: () => {} },
      confirmTimeoutMs: 1000
    });
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    const res = await gateway.callTool(token, "example.invalid-output", {});

    expect(res).toEqual({ ok: false, error: "Tool example.invalid-output failed" });
  });

  it("caps rendered tool output before returning it to the model", async () => {
    const tokens = new SessionTokenRegistry();
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [
        {
          id: "example",
          name: "Example",
          version: "1.0.0",
          publisher: "Jarv1s",
          lifecycle: "optional",
          compatibility: { jarv1s: "*" },
          assistantTools: [
            {
              name: "example.large-output",
              description: "Large output.",
              permissionId: "example.view",
              risk: "read",
              outputSchema: {
                type: "object",
                properties: { visible: { type: "string" } },
                required: ["visible"]
              },
              execute: async () => ({ data: { visible: "x".repeat(20_000) } })
            }
          ]
        }
      ],
      repository: {} as never,
      runner: runner as never,
      tokens,
      confirmations: new ConfirmationRegistry(),
      notifier: { emit: () => {} },
      confirmTimeoutMs: 1000
    });
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    const res = await gateway.callTool(token, "example.large-output", {});

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const text = (res.data as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(16_000);
    expect(text).toContain("[truncated tool result]");
  });
});

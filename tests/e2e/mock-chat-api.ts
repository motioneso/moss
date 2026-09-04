import type { Page, Route } from "@playwright/test";
import type {
  AiConfiguredModelDto,
  AiProviderConfigDto,
  AppendChatUserMessageRequest,
  ChatMessageDto,
  ChatMessageStatus,
  ChatSelectedToolMetadataDto,
  ChatThreadDto,
  CreateChatThreadRequest
} from "@moss/shared";

export interface MockChatApiState {
  aiModels?: AiConfiguredModelDto[];
  aiProviders?: AiProviderConfigDto[];
  chatMessages?: Record<string, ChatMessageDto[]>;
  chatThreads?: ChatThreadDto[];
  /** Holds POST /api/chat/clear open until the test releases it (races the private-activation UI). */
  clearGate?: { release: () => void; promise: Promise<void> };
  /** Server-truth privacy state returned by GET /api/chat/privacy. Defaults to false. */
  incognito?: boolean;
  /** Status code for POST /api/chat/private/end. Defaults to 204 (success). */
  endPrivateChatStatus?: number;
}

export async function registerMockChatRoutes(page: Page, state: MockChatApiState): Promise<void> {
  // Match by pathname (not the full URL) so a trailing `?surface=...` query string — added
  // by ChatDrawer's surface-threaded calls (#1533) — doesn't fall these mocks through
  // unmatched to the real network.
  await page.route(
    (url) => /\/api\/chat\/threads\/[^/]+\/messages$/.test(url.pathname),
    (route) => handleChatMessagesRoute(route, state)
  );
  await page.route(/\/api\/chat\/threads\/[^/]+$/, (route) =>
    handleChatThreadDetailRoute(route, state)
  );
  await page.route(
    (url) => url.pathname.endsWith("/api/chat/threads"),
    (route) => handleChatThreadsRoute(route, state)
  );

  // The live-chat drawer is global (mounted in the app shell), so its SSE stream opens
  // on every authenticated page. Stub it with a single empty event-stream (one SSE
  // comment, no records) and hold any reconnect open, so the unmocked stream doesn't
  // fall through to the SPA server and churn. Tests that exercise the drawer register
  // their own /api/chat/stream route afterwards, which takes precedence.
  let streamServed = false;
  await page.route("**/api/chat/stream*", async (route) => {
    if (streamServed) {
      return; // hold the reconnect open (no replay, no churn)
    }
    streamServed = true;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
      body: ":\n\n"
    });
  });

  // Default 204 for POST /api/chat/clear, held open by state.clearGate when a test needs to
  // race the private-activation UI. Tests that register their own /api/chat/clear route
  // afterwards take precedence (Playwright runs the most-recently-registered handler first).
  await page.route(
    (url) => url.pathname.endsWith("/api/chat/clear"),
    async (route) => {
      if (state.clearGate) {
        await state.clearGate.promise;
      }
      await route.fulfill({ status: 204, body: "" });
    }
  );

  await page.route(
    (url) => url.pathname.endsWith("/api/chat/privacy"),
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ incognito: state.incognito ?? false })
      });
    }
  );

  await page.route(
    (url) => url.pathname.endsWith("/api/chat/private/end"),
    async (route) => {
      const status = state.endPrivateChatStatus ?? 204;
      if (status >= 200 && status < 300) {
        await route.fulfill({ status, body: "" });
        return;
      }
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({ error: "Could not end private chat" })
      });
    }
  );
}

export function createMockChatThread(
  id: string,
  title: string,
  overrides: Partial<ChatThreadDto> = {}
): ChatThreadDto {
  return {
    id,
    ownerUserId: "user-1",
    title,
    incognito: false,
    createdAt: "2026-06-06T12:00:00.000Z",
    updatedAt: "2026-06-06T12:00:00.000Z",
    lastMessagePreview: null,
    ...overrides
  };
}

export function createMockChatMessage(
  id: string,
  threadId: string,
  body: string,
  overrides: Partial<ChatMessageDto> = {}
): ChatMessageDto {
  return {
    id,
    threadId,
    ownerUserId: "user-1",
    role: "user",
    status: "stored",
    body,
    modelRoute: null,
    tools: [],
    activity: [],
    createdAt: "2026-06-06T12:00:00.000Z",
    updatedAt: "2026-06-06T12:00:00.000Z",
    ...overrides
  };
}

async function handleChatThreadsRoute(route: Route, state: MockChatApiState): Promise<void> {
  const request = route.request();

  if (request.method() === "GET") {
    return fulfillJson(route, 200, { threads: state.chatThreads ?? [] });
  }

  if (request.method() === "POST") {
    const input = request.postDataJSON() as CreateChatThreadRequest;
    const thread = createMockChatThread(
      `chat-thread-${(state.chatThreads ?? []).length + 1}`,
      input.title
    );

    state.chatThreads = [thread, ...(state.chatThreads ?? [])];
    state.chatMessages = {
      ...(state.chatMessages ?? {}),
      [thread.id]: []
    };

    return fulfillJson(route, 201, { thread });
  }

  return fulfillJson(route, 405, { error: "Method not allowed" });
}

async function handleChatThreadDetailRoute(route: Route, state: MockChatApiState): Promise<void> {
  const request = route.request();
  const threadId = decodeURIComponent(new URL(request.url()).pathname.split("/").pop() ?? "");
  const thread = (state.chatThreads ?? []).find((item) => item.id === threadId);

  if (!thread) {
    return fulfillJson(route, 404, { error: "Chat thread not found" });
  }

  if (request.method() !== "GET") {
    return fulfillJson(route, 405, { error: "Method not allowed" });
  }

  return fulfillJson(route, 200, { thread });
}

async function handleChatMessagesRoute(route: Route, state: MockChatApiState): Promise<void> {
  const request = route.request();
  const segments = new URL(request.url()).pathname.split("/");
  const threadId = decodeURIComponent(segments.at(-2) ?? "");
  const thread = (state.chatThreads ?? []).find((item) => item.id === threadId);

  if (!thread) {
    return fulfillJson(route, 404, { error: "Chat thread not found" });
  }

  if (request.method() === "GET") {
    return fulfillJson(route, 200, { messages: state.chatMessages?.[threadId] ?? [] });
  }

  if (request.method() === "POST") {
    const input = request.postDataJSON() as AppendChatUserMessageRequest;
    const selectedTools = readSelectedTools(input.selectedToolNames ?? []);
    const model = selectChatModel(state);
    const status = selectAssistantStatus(Boolean(model), selectedTools);
    const userMessage = createMockChatMessage(
      `chat-message-${Date.now()}-user`,
      thread.id,
      input.body
    );
    const assistantMessage = createMockChatMessage(
      `chat-message-${Date.now()}-assistant`,
      thread.id,
      assistantBodyForStatus(status),
      {
        role: "assistant",
        status,
        modelRoute: {
          capability: "chat",
          available: Boolean(model),
          reason: model ? "matched-active-model" : "no-active-model",
          model
        },
        tools: selectedTools
      }
    );

    state.chatMessages = {
      ...(state.chatMessages ?? {}),
      [thread.id]: [...(state.chatMessages?.[thread.id] ?? []), userMessage, assistantMessage]
    };

    return fulfillJson(route, 201, {
      thread,
      messages: [userMessage, assistantMessage]
    });
  }

  return fulfillJson(route, 405, { error: "Method not allowed" });
}

function selectChatModel(state: MockChatApiState): AiConfiguredModelDto | null {
  return (
    (state.aiModels ?? []).find((model) => {
      const provider = (state.aiProviders ?? []).find((item) => item.id === model.providerConfigId);

      return (
        model.status === "active" &&
        model.capabilities.includes("chat") &&
        provider?.status === "active"
      );
    }) ?? null
  );
}

function readSelectedTools(selectedToolNames: readonly string[]): ChatSelectedToolMetadataDto[] {
  return [...new Set(selectedToolNames)].map((name) => {
    if (name !== "tasks.updateStatus") {
      throw new Error(`Unknown mock assistant tool: ${name}`);
    }

    return {
      moduleId: "tasks",
      moduleName: "Tasks",
      name: "tasks.updateStatus",
      permissionId: "tasks.update",
      risk: "write"
    };
  });
}

function selectAssistantStatus(
  hasModel: boolean,
  selectedTools: readonly ChatSelectedToolMetadataDto[]
): ChatMessageStatus {
  if (selectedTools.some((tool) => tool.risk !== "read")) {
    return "blocked";
  }

  return hasModel ? "pending" : "no_model";
}

function assistantBodyForStatus(status: ChatMessageStatus): string {
  if (status === "blocked") {
    return "Tool request recorded but blocked pending confirmation and audit in a later slice.";
  }
  if (status === "no_model") {
    return "No active chat-capable model is configured.";
  }

  return "Chat model route is configured. Provider execution is disabled in this slice.";
}

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
}

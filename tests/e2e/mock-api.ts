import type { Page, Route } from "@playwright/test";
import type {
  CalendarEventDto,
  ChatMessageDto,
  ChatThreadDto,
  CreateTaskRequest,
  EmailMessageDto,
  EmailTaskCreationMode,
  MeResponse,
  NotificationDto,
  TaskDefaultView,
  TaskDto,
  TaskListDto,
  TaskTagDto,
  UserDto,
  UpdateTaskRequest
} from "@moss/shared";

import { registerMockAiRoutes, type MockAiApiState } from "./mock-ai-api.js";
import { registerMockBriefingsRoutes, type MockBriefingsApiState } from "./mock-briefings-api.js";
import { registerMockChatRoutes } from "./mock-chat-api.js";
import { registerMockConnectorRoutes, type MockConnectorsApiState } from "./mock-connectors-api.js";
import { modulesResponse, myModulesResponse } from "./mock-modules.js";
import {
  registerMockOnboardingRoutes,
  type MockOnboardingApiState
} from "./mock-onboarding-api.js";
import {
  registerMockNotesPeopleRoutes,
  type MockNotesPeopleApiState
} from "./mock-notes-people-api.js";

export { createMockBriefingDefinition, createMockBriefingRun } from "./mock-briefings-api.js";
export { createMockConnectorAccount, createMockConnectorProviders } from "./mock-connectors-api.js";

export interface MockApiState
  extends
    MockBriefingsApiState,
    MockAiApiState,
    MockConnectorsApiState,
    MockOnboardingApiState,
    MockNotesPeopleApiState {
  authenticated: boolean;
  /**
   * Whether the authenticated user is an instance admin. Defaults to true so
   * existing specs keep their admin surfaces; set false to exercise the
   * non-admin path (admin sections hidden, admin routes 403) — see #171.
   */
  isInstanceAdmin?: boolean;
  /**
   * Phase 4: explicitly drive the bootstrap-owner flag (the founder vs member onboarding
   * branch keys on it). Defaults to the existing "admin ⇒ bootstrap owner" derivation; set it
   * false to exercise the member onboarding path while keeping /api/me coherent.
   */
  isBootstrapOwner?: boolean;
  calendarEvents?: CalendarEventDto[];
  chatMessages?: Record<string, ChatMessageDto[]>;
  chatThreads?: ChatThreadDto[];
  emailMessages?: EmailMessageDto[];
  /** Email → task creation mode (#729); defaults to "suggest". */
  emailTaskMode?: EmailTaskCreationMode;
  adminUsers?: UserDto[];
  notifications: NotificationDto[];
  revokedAdminSessionCount?: number;
  tasks: TaskDto[];
  taskDefaultView?: TaskDefaultView;
  /**
   * Server-side active theme id. The app shell prefers this over the
   * localStorage seed, so dark/theme capture specs must set it here.
   * Defaults to "light".
   */
  themeActiveId?: string;
  /**
   * Stateful lists/tags so rename/delete mutations are reflected by the
   * follow-up refetch (the web UI invalidates and re-reads after mutating).
   * Left undefined by specs that don't care; seeded with a default list +
   * tag lazily on first access.
   */
  taskLists?: TaskListDto[];
  taskTags?: TaskTagDto[];
  /** Holds POST /api/chat/clear open until the test releases it. See MockChatApiState. */
  clearGate?: { release: () => void; promise: Promise<void> };
  /** Server-truth privacy state returned by GET /api/chat/privacy. See MockChatApiState. */
  incognito?: boolean;
  /** Status code for POST /api/chat/private/end. See MockChatApiState. */
  endPrivateChatStatus?: number;
}

function taskListsFor(state: MockApiState): TaskListDto[] {
  if (!state.taskLists) {
    state.taskLists = [
      {
        id: "list-1",
        ownerUserId: "user-1",
        name: "Personal",
        position: 0,
        createdAt: null,
        updatedAt: null
      }
    ];
  }
  return state.taskLists;
}

function taskTagsFor(state: MockApiState): TaskTagDto[] {
  if (!state.taskTags) {
    state.taskTags = [
      {
        id: "tag-urgent",
        ownerUserId: "user-1",
        listId: "list-1",
        name: "urgent",
        createdAt: null
      }
    ];
  }
  return state.taskTags;
}

const meResponse: MeResponse = {
  user: {
    id: "user-1",
    email: "owner@example.test",
    emailVerified: false,
    name: "Owner User",
    isInstanceAdmin: true,
    status: "active" as const,
    isBootstrapOwner: true,
    createdAt: "2026-06-06T12:00:00.000Z",
    updatedAt: "2026-06-06T12:00:00.000Z"
  },
  profilePrefs: { addressed: null },
  hasPasswordCredential: true
};

function meResponseFor(state: MockApiState): MeResponse {
  const isInstanceAdmin = state.isInstanceAdmin ?? true;
  return {
    user: {
      ...meResponse.user,
      isInstanceAdmin,
      // An EXPLICIT state.isBootstrapOwner override wins (member specs pass false); otherwise keep
      // the existing "admin ⇒ bootstrap owner" default. A non-admin can never be the bootstrap
      // owner, so the default keeps the fixture coherent.
      isBootstrapOwner:
        state.isBootstrapOwner ?? (isInstanceAdmin && meResponse.user.isBootstrapOwner)
    },
    profilePrefs: meResponse.profilePrefs,
    hasPasswordCredential: meResponse.hasPasswordCredential
  };
}

function adminUsersFor(state: MockApiState): UserDto[] {
  if (!state.adminUsers) {
    state.adminUsers = [
      meResponseFor(state).user,
      createMockUser("member-1", "Member User", "member@example.test")
    ];
  }
  return state.adminUsers;
}

export async function mockApi(page: Page, state: MockApiState): Promise<void> {
  // Catch-all registered FIRST (lowest Playwright priority — specific routes override it).
  // Prevents unmocked /api/* calls reaching Vite's proxy and causing ECONNREFUSED in CI.
  // Uses a pathname check rather than a glob so it does NOT match Vite source-file requests
  // like /src/api/client.ts (which contain "/api/" but are NOT API calls).
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => fulfillJson(route, 404, { error: "Not mocked" })
  );

  await page.route("**/api/bootstrap/status", (route) =>
    fulfillJson(route, 200, { needsBootstrap: false })
  );
  await page.route("**/api/auth/sign-in/email", (route) => {
    state.authenticated = true;
    return fulfillJson(route, 200, { user: meResponseFor(state).user });
  });
  await page.route("**/api/auth/sign-up/email", (route) => {
    state.authenticated = true;
    return fulfillJson(route, 200, { user: meResponseFor(state).user });
  });
  await page.route("**/api/auth/sign-out", (route) => {
    state.authenticated = false;
    return fulfillJson(route, 200, {});
  });
  await page.route("**/api/me", (route) =>
    state.authenticated
      ? fulfillJson(route, 200, meResponseFor(state))
      : fulfillJson(route, 401, { error: "Session is missing or expired" })
  );
  await page.route("**/api/modules", (route) =>
    state.authenticated
      ? fulfillJson(route, 200, modulesResponse)
      : fulfillJson(route, 401, { error: "Session is missing or expired" })
  );
  // The shell also fetches /api/me/modules for per-actor enablement flags; every module is
  // reported active so existing specs keep their full nav (nav hides only on explicit disable).
  await page.route("**/api/me/modules", (route) =>
    state.authenticated
      ? fulfillJson(route, 200, myModulesResponse)
      : fulfillJson(route, 401, { error: "Session is missing or expired" })
  );
  // Themes — fetched by the app shell on every authenticated page load. The
  // shell prefers this activeId over the localStorage seed, so specs that
  // capture a non-light theme must pass themeActiveId.
  const themesResponse = () => ({
    builtIn: [
      { id: "light", name: "Light", builtIn: true },
      { id: "dark", name: "Dark", builtIn: true }
    ],
    custom: [],
    activeId: state.themeActiveId ?? "light",
    mode: "light"
  });
  await page.route("**/api/me/themes/active", (route) =>
    state.authenticated
      ? fulfillJson(route, 200, themesResponse())
      : fulfillJson(route, 401, { error: "Session is missing or expired" })
  );
  await page.route("**/api/me/themes/**", (route) =>
    state.authenticated
      ? fulfillJson(route, 200, themesResponse())
      : fulfillJson(route, 401, { error: "Session is missing or expired" })
  );
  await page.route("**/api/me/themes", (route) =>
    state.authenticated
      ? fulfillJson(route, 200, themesResponse())
      : fulfillJson(route, 401, { error: "Session is missing or expired" })
  );
  // Sessions
  await page.route("**/api/me/sessions/others", (route) =>
    state.authenticated
      ? fulfillJson(route, 200, { success: true, count: 0 })
      : fulfillJson(route, 401, { error: "Session is missing or expired" })
  );
  await page.route(/\/api\/me\/sessions\/[^/]+$/, (route) =>
    state.authenticated
      ? fulfillJson(route, 200, { success: true })
      : fulfillJson(route, 401, { error: "Session is missing or expired" })
  );
  await page.route("**/api/me/sessions", (route) =>
    state.authenticated
      ? fulfillJson(route, 200, { sessions: [] })
      : fulfillJson(route, 401, { error: "Session is missing or expired" })
  );
  // Goals
  await page.route("**/api/goals", (route) =>
    state.authenticated
      ? fulfillJson(route, 200, { items: [] })
      : fulfillJson(route, 401, { error: "Session is missing or expired" })
  );
  // Locale settings
  await page.route("**/api/me/locale", (route) =>
    state.authenticated
      ? fulfillJson(route, 200, { locale: { timezone: "UTC", region: "en-US", dateFormat: "MDY" } })
      : fulfillJson(route, 401, { error: "Session is missing or expired" })
  );
  // Source behaviors
  await page.route("**/api/me/source-behaviors/**", (route) =>
    state.authenticated
      ? fulfillJson(route, 200, { sources: [] })
      : fulfillJson(route, 401, { error: "Session is missing or expired" })
  );
  await page.route("**/api/me/source-behaviors", (route) =>
    state.authenticated
      ? fulfillJson(route, 200, { sources: [] })
      : fulfillJson(route, 401, { error: "Session is missing or expired" })
  );
  await page.route("**/api/admin/auth/providers", (route) =>
    // Admin-only surface: a non-admin caller is rejected, mirroring the API's
    // requireInstanceAdmin guard so the negative e2e path is realistic (#171).
    (state.isInstanceAdmin ?? true)
      ? fulfillJson(route, 200, {
          providers: [
            {
              id: "email-password",
              displayName: "Email and password",
              providerType: "local",
              enabled: true
            }
          ]
        })
      : fulfillJson(route, 403, { error: "Instance admin required" })
  );
  await registerMockConnectorRoutes(page, state);
  await registerMockAiRoutes(page, state);
  await registerMockBriefingsRoutes(page, state);
  await registerMockChatRoutes(page, state);
  await registerMockOnboardingRoutes(page, state);
  await registerMockNotesPeopleRoutes(page, state);
  await page.route("**/api/admin/users", (route) => handleAdminUsersRoute(route, state));
  await page.route("**/api/admin/users/*/revoke-sessions", (route) =>
    handleAdminUserRevokeSessionsRoute(route, state)
  );
  await page.route(/\/api\/calendar\/events\/[^/]+$/, (route) =>
    handleCalendarEventDetailRoute(route, state)
  );
  await page.route("**/api/calendar/events", (route) => handleCalendarEventListRoute(route, state));
  await page.route(/\/api\/email\/messages\/[^/]+$/, (route) =>
    handleEmailMessageDetailRoute(route, state)
  );
  await page.route("**/api/email/messages", (route) => handleEmailMessageListRoute(route, state));
  await page.route("**/api/email/task-creation-mode", (route) =>
    handleEmailTaskModeRoute(route, state)
  );
  await page.route(/\/api\/notifications\/[^/]+\/read$/, (route) =>
    handleNotificationReadRoute(route, state)
  );
  await page.route("**/api/notifications/read-all", (route) =>
    handleMarkAllNotificationsReadRoute(route, state)
  );
  await page.route("**/api/notifications", (route) => handleNotificationListRoute(route, state));
  // Generic task routes registered first (lowest priority because Playwright uses reverse order)
  await page.route("**/api/tasks", (route) => handleTaskListRoute(route, state));
  await page.route(/\/api\/tasks\/[^/]+$/, (route) => handleTaskDetailRoute(route, state));
  // Specific task sub-routes registered after to take precedence (last-registered wins)
  await page.route("**/api/tasks/*/activity", (route) => {
    if (route.request().method() === "GET") {
      return fulfillJson(route, 200, { activity: [] });
    }
    return fulfillJson(route, 201, {
      activity: {
        id: "activity-1",
        taskId: "task-1",
        actorUserId: "user-1",
        activityType: "comment",
        body: (route.request().postDataJSON() as { readonly body?: string | null }).body ?? null,
        createdAt: "2026-06-06T12:00:00.000Z"
      }
    });
  });
  await page.route("**/api/tasks/*/subtasks", (route) => fulfillJson(route, 200, { tasks: [] }));
  await page.route("**/api/tasks/focus", (route) =>
    fulfillJson(route, 200, { tasks: state.tasks })
  );
  await page.route("**/api/tasks/at-risk", (route) =>
    fulfillJson(route, 200, { tasks: state.tasks })
  );
  await page.route("**/api/tasks/overdue", (route) =>
    fulfillJson(route, 200, { tasks: state.tasks })
  );
  await page.route("**/api/tasks/lists/*/tags", (route) => handleTaskTagsRoute(route, state));
  await page.route("**/api/tasks/lists", (route) => handleTaskListsRoute(route, state));
  await page.route("**/api/tasks/preferences", (route) => handleTaskPreferencesRoute(route, state));
  // Mutation routes registered AFTER the generic + sub-routes above so Playwright's
  // reverse-registration precedence selects these for the more-specific paths. The
  // `.../tags/*` pattern is strictly more specific than the bare `.../tags` picker
  // route above (extra `/*`), so it captures PATCH/DELETE of a specific tag without
  // shadowing the GET/POST tag-picker handler. Most-specific registered LAST.
  await page.route("**/api/tasks/lists/*/tags/*", (route) =>
    handleTaskTagMutateRoute(route, state)
  );
  await page.route("**/api/tasks/lists/*", (route) => handleTaskListMutateRoute(route, state));
  await page.route("**/api/tasks/*/tags", (route) => handleTaskTagAssignmentRoute(route, state));
  await page.route("**/api/tasks/*/tags/*", (route) => handleTaskTagAssignmentRoute(route, state));
}

async function handleCalendarEventListRoute(route: Route, state: MockApiState): Promise<void> {
  if (route.request().method() !== "GET") {
    return fulfillJson(route, 405, { error: "Method not allowed" });
  }

  return fulfillJson(route, 200, { events: state.calendarEvents ?? [] });
}

async function handleCalendarEventDetailRoute(route: Route, state: MockApiState): Promise<void> {
  const request = route.request();
  const eventId = decodeURIComponent(new URL(request.url()).pathname.split("/").pop() ?? "");
  const event = (state.calendarEvents ?? []).find((item) => item.id === eventId);

  if (!event) {
    return fulfillJson(route, 404, { error: "Calendar event not found" });
  }

  if (request.method() !== "GET") {
    return fulfillJson(route, 405, { error: "Method not allowed" });
  }

  return fulfillJson(route, 200, { event });
}

async function handleEmailMessageListRoute(route: Route, state: MockApiState): Promise<void> {
  if (route.request().method() !== "GET") {
    return fulfillJson(route, 405, { error: "Method not allowed" });
  }

  return fulfillJson(route, 200, { messages: state.emailMessages ?? [] });
}

async function handleEmailTaskModeRoute(route: Route, state: MockApiState): Promise<void> {
  const request = route.request();

  if (request.method() === "GET") {
    return fulfillJson(route, 200, { mode: state.emailTaskMode ?? "suggest" });
  }

  if (request.method() === "PUT") {
    const input = request.postDataJSON() as { mode: EmailTaskCreationMode };
    state.emailTaskMode = input.mode;
    return fulfillJson(route, 200, { mode: input.mode });
  }

  return fulfillJson(route, 405, { error: "Method not allowed" });
}

async function handleEmailMessageDetailRoute(route: Route, state: MockApiState): Promise<void> {
  const request = route.request();
  const messageId = decodeURIComponent(new URL(request.url()).pathname.split("/").pop() ?? "");
  const message = (state.emailMessages ?? []).find((item) => item.id === messageId);

  if (!message) {
    return fulfillJson(route, 404, { error: "Email message not found" });
  }

  if (request.method() !== "GET") {
    return fulfillJson(route, 405, { error: "Method not allowed" });
  }

  return fulfillJson(route, 200, { message });
}

async function handleAdminUsersRoute(route: Route, state: MockApiState): Promise<void> {
  if (route.request().method() !== "GET") {
    return fulfillJson(route, 405, { error: "Method not allowed" });
  }

  return fulfillJson(route, 200, { users: adminUsersFor(state) });
}

async function handleAdminUserRevokeSessionsRoute(
  route: Route,
  state: MockApiState
): Promise<void> {
  const request = route.request();
  const userId = decodeURIComponent(new URL(request.url()).pathname.split("/").at(-2) ?? "");

  if (request.method() !== "POST") {
    return fulfillJson(route, 405, { error: "Method not allowed" });
  }

  if (!adminUsersFor(state).some((user) => user.id === userId)) {
    return fulfillJson(route, 404, { error: "User not found" });
  }

  return fulfillJson(route, 200, { success: true, count: state.revokedAdminSessionCount ?? 2 });
}

async function handleNotificationListRoute(route: Route, state: MockApiState): Promise<void> {
  if (route.request().method() !== "GET") {
    return fulfillJson(route, 405, { error: "Method not allowed" });
  }

  return fulfillJson(route, 200, {
    notifications: state.notifications,
    unreadCount: countUnreadNotifications(state.notifications)
  });
}

async function handleNotificationReadRoute(route: Route, state: MockApiState): Promise<void> {
  const request = route.request();
  const segments = new URL(request.url()).pathname.split("/");
  const notificationId = decodeURIComponent(segments.at(-2) ?? "");
  const notification = state.notifications.find((item) => item.id === notificationId);

  if (!notification) {
    return fulfillJson(route, 404, { error: "Notification not found" });
  }

  if (request.method() !== "PATCH") {
    return fulfillJson(route, 405, { error: "Method not allowed" });
  }

  const updatedNotification = {
    ...notification,
    readAt: "2026-06-06T12:00:00.000Z"
  };

  state.notifications = state.notifications.map((item) =>
    item.id === notificationId ? updatedNotification : item
  );

  return fulfillJson(route, 200, { notification: updatedNotification });
}

async function handleMarkAllNotificationsReadRoute(
  route: Route,
  state: MockApiState
): Promise<void> {
  if (route.request().method() !== "PATCH") {
    return fulfillJson(route, 405, { error: "Method not allowed" });
  }

  state.notifications = state.notifications.map((notification) => ({
    ...notification,
    readAt: notification.readAt ?? "2026-06-06T12:00:00.000Z"
  }));

  return fulfillJson(route, 200, {
    unreadCount: countUnreadNotifications(state.notifications)
  });
}

async function handleTaskPreferencesRoute(route: Route, state: MockApiState): Promise<void> {
  if (route.request().method() === "GET") {
    return fulfillJson(route, 200, {
      preferences: { defaultView: state.taskDefaultView ?? "priority", updatedAt: null }
    });
  }

  if (route.request().method() === "PATCH") {
    const body = route.request().postDataJSON() as { readonly defaultView?: string };
    state.taskDefaultView = (body.defaultView as TaskDefaultView) ?? "priority";
    return fulfillJson(route, 200, {
      preferences: { defaultView: state.taskDefaultView, updatedAt: null }
    });
  }

  return fulfillJson(route, 405, { error: "Method not allowed" });
}

async function handleTaskListsRoute(route: Route, state: MockApiState): Promise<void> {
  if (route.request().method() === "GET") {
    return fulfillJson(route, 200, { lists: taskListsFor(state) });
  }

  if (route.request().method() === "POST") {
    const body = route.request().postDataJSON() as { readonly name?: string };
    const lists = taskListsFor(state);
    const list: TaskListDto = {
      id: `list-${lists.length + 1}`,
      ownerUserId: "user-1",
      name: body.name ?? "",
      position: lists.length,
      createdAt: null,
      updatedAt: null
    };
    state.taskLists = [...lists, list];
    return fulfillJson(route, 201, { list });
  }

  return fulfillJson(route, 405, { error: "Method not allowed" });
}

function listIdFromTagsPath(route: Route): string {
  // .../api/tasks/lists/:listId/tags
  const segments = new URL(route.request().url()).pathname.split("/");
  return decodeURIComponent(segments.at(-2) ?? "");
}

async function handleTaskTagsRoute(route: Route, state: MockApiState): Promise<void> {
  const listId = listIdFromTagsPath(route);

  if (route.request().method() === "GET") {
    return fulfillJson(route, 200, {
      tags: taskTagsFor(state).filter((tag) => tag.listId === listId)
    });
  }

  if (route.request().method() === "POST") {
    const body = route.request().postDataJSON() as { readonly name?: string };
    const tags = taskTagsFor(state);
    const tag: TaskTagDto = {
      id: `tag-${tags.length + 1}`,
      ownerUserId: "user-1",
      listId,
      name: body.name ?? "",
      createdAt: null
    };
    state.taskTags = [...tags, tag];
    return fulfillJson(route, 201, { tag });
  }

  return fulfillJson(route, 405, { error: "Method not allowed" });
}

async function handleTaskListRoute(route: Route, state: MockApiState): Promise<void> {
  const request = route.request();

  if (request.method() === "GET") {
    return fulfillJson(route, 200, { tasks: state.tasks });
  }

  if (request.method() === "POST") {
    const input = request.postDataJSON() as CreateTaskRequest;
    const task = createMockTask(`task-${state.tasks.length + 1}`, input.title, {
      description: input.description ?? null,
      dueAt: input.dueAt ?? null,
      priority: input.priority ?? null
    });

    state.tasks = [...state.tasks, task];
    return fulfillJson(route, 201, { task });
  }

  return fulfillJson(route, 405, { error: "Method not allowed" });
}

async function handleTaskDetailRoute(route: Route, state: MockApiState): Promise<void> {
  const request = route.request();
  const taskId = decodeURIComponent(new URL(request.url()).pathname.split("/").pop() ?? "");
  const task = state.tasks.find((item) => item.id === taskId);

  if (!task) {
    return fulfillJson(route, 404, { error: "Task not found" });
  }

  if (request.method() === "GET") {
    return fulfillJson(route, 200, { task });
  }

  if (request.method() === "PATCH") {
    const input = request.postDataJSON() as UpdateTaskRequest;
    const updatedTask: TaskDto = {
      ...task,
      ...input,
      completedAt: input.status === "done" ? "2026-06-06T12:00:00.000Z" : task.completedAt,
      updatedAt: "2026-06-06T12:00:00.000Z"
    };

    state.tasks = state.tasks.map((item) => (item.id === taskId ? updatedTask : item));
    return fulfillJson(route, 200, { task: updatedTask });
  }

  return fulfillJson(route, 405, { error: "Method not allowed" });
}

async function handleTaskTagAssignmentRoute(route: Route, state: MockApiState): Promise<void> {
  const request = route.request();
  const segments = new URL(request.url()).pathname.split("/");
  const method = request.method();

  if (method === "POST") {
    // .../api/tasks/:taskId/tags  → assign the tag in the body, return the task.
    const taskId = decodeURIComponent(segments.at(-2) ?? "");
    const body = request.postDataJSON() as { readonly tagId?: string };
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) {
      return fulfillJson(route, 404, { error: "Task not found" });
    }
    const tag = taskTagsFor(state).find((item) => item.id === body.tagId);
    if (!tag) {
      return fulfillJson(route, 404, { error: "Tag not found" });
    }
    const updatedTask: TaskDto = { ...task, tags: [...task.tags, tag] };
    state.tasks = state.tasks.map((item) => (item.id === taskId ? updatedTask : item));
    return fulfillJson(route, 200, { task: updatedTask });
  }

  if (method === "DELETE") {
    // .../api/tasks/:taskId/tags/:tagId → unassign, return the task.
    const tagId = decodeURIComponent(segments.at(-1) ?? "");
    const taskId = decodeURIComponent(segments.at(-3) ?? "");
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) {
      return fulfillJson(route, 404, { error: "Task not found" });
    }
    const updatedTask: TaskDto = {
      ...task,
      tags: task.tags.filter((item) => item.id !== tagId)
    };
    state.tasks = state.tasks.map((item) => (item.id === taskId ? updatedTask : item));
    return fulfillJson(route, 200, { task: updatedTask });
  }

  return fulfillJson(route, 405, { error: "Method not allowed" });
}

async function handleTaskListMutateRoute(route: Route, state: MockApiState): Promise<void> {
  const request = route.request();
  const listId = decodeURIComponent(new URL(request.url()).pathname.split("/").pop() ?? "");
  const method = request.method();

  if (method === "PATCH") {
    const body = request.postDataJSON() as { readonly name?: string };
    const lists = taskListsFor(state);
    const existing = lists.find((item) => item.id === listId);
    if (!existing) {
      return fulfillJson(route, 404, { error: "List not found" });
    }
    const list: TaskListDto = { ...existing, name: body.name ?? existing.name };
    state.taskLists = lists.map((item) => (item.id === listId ? list : item));
    return fulfillJson(route, 200, { list });
  }

  if (method === "DELETE") {
    state.taskLists = taskListsFor(state).filter((item) => item.id !== listId);
    return fulfillJson(route, 200, { deleted: true });
  }

  return fulfillJson(route, 405, { error: "Method not allowed" });
}

async function handleTaskTagMutateRoute(route: Route, state: MockApiState): Promise<void> {
  const request = route.request();
  const segments = new URL(request.url()).pathname.split("/");
  // .../api/tasks/lists/:listId/tags/:tagId
  const tagId = decodeURIComponent(segments.at(-1) ?? "");
  const method = request.method();

  if (method === "PATCH") {
    const body = request.postDataJSON() as { readonly name?: string };
    const tags = taskTagsFor(state);
    const existing = tags.find((item) => item.id === tagId);
    if (!existing) {
      return fulfillJson(route, 404, { error: "Tag not found" });
    }
    const tag: TaskTagDto = { ...existing, name: body.name ?? existing.name };
    state.taskTags = tags.map((item) => (item.id === tagId ? tag : item));
    return fulfillJson(route, 200, { tag });
  }

  if (method === "DELETE") {
    state.taskTags = taskTagsFor(state).filter((item) => item.id !== tagId);
    return fulfillJson(route, 200, { deleted: true });
  }

  return fulfillJson(route, 405, { error: "Method not allowed" });
}

export function createMockCalendarEvent(
  id: string,
  title: string,
  overrides: Partial<CalendarEventDto> = {}
): CalendarEventDto {
  return {
    id,
    connectorAccountId: "connector-calendar-1",
    ownerUserId: "user-1",
    title,
    startsAt: "2030-06-06T16:00:00.000Z",
    endsAt: "2030-06-06T17:00:00.000Z",
    location: null,
    summary: null,
    bodyExcerpt: null,
    externalId: id,
    isMossBlock: false,
    allDay: false,
    attendeeCount: 0,
    status: null,
    createdAt: "2026-06-06T12:00:00.000Z",
    updatedAt: "2026-06-06T12:00:00.000Z",
    ...overrides
  };
}

export function createMockEmailMessage(
  id: string,
  subject: string,
  overrides: Partial<EmailMessageDto> = {}
): EmailMessageDto {
  return {
    id,
    ownerUserId: "user-1",
    sender: "sender@example.test",
    recipients: [],
    subject,
    snippet: null,
    bodyExcerpt: null,
    summary: null,
    signals: {},
    receivedAt: "2026-06-06T12:00:00.000Z",
    externalId: id,
    createdAt: "2026-06-06T12:00:00.000Z",
    updatedAt: "2026-06-06T12:00:00.000Z",
    ...overrides
  };
}

export function createMockUser(
  id: string,
  name: string,
  email: string,
  overrides: Partial<UserDto> = {}
): UserDto {
  return {
    id,
    email,
    emailVerified: false,
    name,
    isInstanceAdmin: false,
    status: "active",
    isBootstrapOwner: false,
    createdAt: "2026-06-06T12:00:00.000Z",
    updatedAt: "2026-06-06T12:00:00.000Z",
    ...overrides
  };
}

export function createMockTask(
  id: string,
  title: string,
  overrides: Partial<TaskDto> = {}
): TaskDto {
  return {
    id,
    ownerUserId: "user-1",
    listId: "list-1",
    parentTaskId: null,
    title,
    description: null,
    status: "todo",
    priority: null,
    position: 0,
    dueAt: null,
    doAt: null,
    effort: null,
    source: "manual",
    sourceRef: null,
    completedAt: null,
    createdAt: "2026-06-06T12:00:00.000Z",
    updatedAt: "2026-06-06T12:00:00.000Z",
    tags: [],
    suggestionMetadata: null,
    ...overrides
  };
}

export function createMockNotification(
  id: string,
  title: string,
  overrides: Partial<NotificationDto> = {}
): NotificationDto {
  return {
    id,
    moduleId: "briefings",
    actorUserId: "user-1",
    recipientUserId: "user-1",
    title,
    body: null,
    metadata: {},
    readAt: null,
    createdAt: "2026-06-06T12:00:00.000Z",
    href: null,
    ...overrides
  };
}

function countUnreadNotifications(notifications: readonly NotificationDto[]): number {
  return notifications.filter((notification) => !notification.readAt).length;
}

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
}

import type { Page } from "@playwright/test";
import type {
  ExternalModuleDto,
  ListExternalModulesResponse,
  ListModulesResponse,
  ListMyModulesResponse,
  ModuleDto
} from "@moss/shared";

export const modulesResponse: ListModulesResponse = {
  modules: [
    {
      id: "connectors",
      name: "Connectors",
      version: "0.1.0",
      lifecycle: "required",
      navigation: [],
      settings: [
        {
          id: "connectors.user-settings",
          label: "Connectors",
          path: "/settings/connectors",
          scope: "user",
          order: 30
        }
      ]
    },
    {
      id: "tasks",
      name: "Tasks",
      version: "0.1.0",
      lifecycle: "required",
      navigation: [
        {
          id: "tasks",
          label: "Tasks",
          path: "/tasks",
          icon: "check-square",
          order: 10
        }
      ],
      settings: []
    },
    {
      id: "notifications",
      name: "Notifications",
      version: "0.1.0",
      lifecycle: "required",
      navigation: [
        {
          id: "notifications",
          label: "Notifications",
          path: "/notifications",
          icon: "bell",
          order: 30
        }
      ],
      settings: []
    },
    {
      id: "calendar",
      name: "Calendar",
      version: "0.1.0",
      lifecycle: "required",
      navigation: [
        {
          id: "calendar",
          label: "Calendar",
          path: "/calendar",
          icon: "calendar-days",
          order: 35
        }
      ],
      settings: []
    },
    {
      id: "email",
      name: "Email",
      version: "0.1.0",
      lifecycle: "required",
      navigation: [
        {
          id: "email",
          label: "Email",
          path: "/email",
          icon: "mail",
          order: 40
        }
      ],
      settings: []
    },
    {
      id: "ai",
      name: "AI",
      version: "0.1.0",
      lifecycle: "required",
      navigation: [],
      settings: [
        {
          id: "ai.user-settings",
          label: "AI Providers",
          path: "/settings/ai",
          scope: "user",
          order: 40
        }
      ]
    },
    {
      id: "chat",
      name: "Chat",
      version: "0.1.0",
      lifecycle: "required",
      navigation: [
        {
          id: "chat",
          label: "Chat",
          path: "/chat",
          icon: "message-square",
          order: 45
        }
      ],
      settings: []
    },
    {
      id: "briefings",
      name: "Briefings",
      version: "0.1.0",
      lifecycle: "required",
      navigation: [
        {
          id: "briefings",
          label: "Briefings",
          path: "/briefings",
          icon: "newspaper",
          order: 50
        }
      ],
      settings: []
    },
    {
      id: "settings",
      name: "Settings",
      version: "0.0.0",
      lifecycle: "required",
      navigation: [
        {
          id: "settings",
          label: "Settings",
          path: "/settings",
          icon: "settings",
          order: 1000
        }
      ],
      settings: []
    }
  ]
};

/**
 * Per-actor enablement flags for the same module set, all active — the shell hides nav only
 * for modules the actor has explicitly disabled, so the default fixture keeps the full nav.
 */
export const myModulesResponse: ListMyModulesResponse = {
  modules: modulesResponse.modules.map((module) => ({
    id: module.id,
    name: module.name,
    version: module.version,
    lifecycle: module.lifecycle,
    required: module.lifecycle === "required",
    supportsUserDisable: module.lifecycle === "user-toggleable",
    instanceDisabled: false,
    userDisabled: false,
    active: true,
    hasPreferences: false,
    hasUserCredentials: false,
    scope: "everyone" as const
  }))
};

/**
 * Stateful mock for the #917 external-modules admin surface (Settings → Instance modules).
 * Seeds one discovered-but-inactive module; the POST toggle flips its status in-memory so the
 * pane round-trips (enable → refetch shows the switch checked), mirroring the stateful handlers
 * in mock-api.ts (e.g. handleAdminUsersRoute).
 *
 * MUST be registered AFTER mockApi(page, …): Playwright matches the most-recently-registered
 * route first, so these override mockApi's catch-all 404 for /api/*.
 */
export async function mockExternalModules(page: Page): Promise<void> {
  // #996/#860: external modules are always-on now (no server-side flag to mirror) — this
  // mock always seeds `enabled:true`, matching production's always-on ListExternalModulesResponse.
  let current: ExternalModuleDto = {
    id: "acme-widgets",
    name: "Acme Widgets",
    version: "0.1.0",
    publisher: "Acme, Inc.",
    status: "discovered",
    active: false,
    drifted: false,
    disabledReason: null,
    web: null
  };

  // GET list — the pane's initial query and every post-toggle refetch read this.
  await page.route("**/api/admin/external-modules", async (route) => {
    const body: ListExternalModulesResponse = { enabled: true, modules: [current], rejected: [] };
    await route.fulfill({ json: body });
  });

  // POST /api/admin/external-modules/:id — flip the module's status so the refetched list
  // reflects the new enablement, matching the real endpoint's { module } envelope.
  await page.route("**/api/admin/external-modules/*", async (route) => {
    const enabled = (route.request().postDataJSON() as { enabled: boolean }).enabled;
    current = {
      ...current,
      status: enabled ? "enabled" : "disabled",
      active: enabled
    };
    await route.fulfill({ json: { module: current } });
  });
}

/**
 * #916 — mount a fake ENABLED external web module and serve its bundle, so the e2e can drive the
 * real button-click → host-action → editable-draft flow. Registered AFTER mockApi so these routes
 * win (Playwright matches most-recently-registered first).
 *
 * The served bundle is valid ESM: it reads the host React from the runtime global the loader
 * installs at boot (window.__JARVIS_MODULE_RUNTIME__), so exactly one React instance exists, and
 * its Root calls the host action from a user gesture — no JSX/transpile needed to serve it as text.
 */
export async function mockExternalWebModule(page: Page): Promise<void> {
  const moduleId = "demo-module";
  const entrypoint = "dist/web/index.js";

  const externalEntry = {
    id: moduleId,
    name: "Demo Module",
    version: "0.1.0",
    lifecycle: "optional" as const,
    external: true,
    web: { entrypoint, contractVersion: 2 },
    navigation: [{ id: moduleId, label: "Demo Module", path: `/m/${moduleId}`, order: 60 }],
    settings: []
  };

  // /api/modules — the app.tsx externalModuleRoutes filter needs external:true + web set.
  await page.route("**/api/modules", async (route) => {
    const body: ListModulesResponse = {
      modules: [...modulesResponse.modules, externalEntry as unknown as ModuleDto]
    };
    await route.fulfill({ json: body });
  });

  // /api/me/modules — mark it active so the module is enabled for the actor.
  await page.route("**/api/me/modules", async (route) => {
    const body: ListMyModulesResponse = {
      modules: [
        ...myModulesResponse.modules,
        {
          id: moduleId,
          name: "Demo Module",
          version: "0.1.0",
          lifecycle: "optional",
          required: false,
          supportsUserDisable: true,
          instanceDisabled: false,
          userDisabled: false,
          active: true,
          hasPreferences: false,
          hasUserCredentials: false,
          scope: "everyone"
        }
      ]
    };
    await route.fulfill({ json: body });
  });

  // The bundle itself — a real ESM module whose Root invokes the host action from a click.
  // Trailing `*` (not an exact match): the dev-time `import(url)` in loader.ts hits an absolute
  // URL Vite doesn't own, so its browser client appends a `?import` query suffix to the request —
  // an exact-path glob 404s on that suffix, which only ever shows up under Vite dev, never prod
  // (Fastify route matching ignores query strings there).
  // The button copy below is this fake third-party module's own, not the host's, so #1441 leaves it
  // spelled the old way on purpose: the host must never rewrite module-authored text.
  await page.route(`**/api/modules/${moduleId}/web/${entrypoint}*`, async (route) => {
    const bundle = [
      "const { react: React } = window.__JARVIS_MODULE_RUNTIME__;",
      "export default {",
      "  contractVersion: 2,",
      "  Root: (props) => React.createElement(React.Fragment, null,",
      "    React.createElement('span', { 'data-assistant-surface': props.assistantSurface ? 'available' : 'missing' }, props.assistantSurface ? 'Assistant surface available' : 'Assistant surface missing'),",
      "    React.createElement('button', {",
      "      type: 'button',",
      "      onClick: () => props.hostActions.openAssistant({ starterPrompt: 'Help me start.' })",
      "    }, 'Continue with Jarvis')",
      "  )",
      "};"
    ].join("\n");
    await route.fulfill({
      contentType: "text/javascript; charset=utf-8",
      body: bundle
    });
  });
}

/** #1196 — fixture module that mounts the real host AssistantSurface contract. */
export async function mockAssistantSurfaceWebModule(page: Page): Promise<void> {
  await mockExternalWebModule(page);

  await page.route("**/api/modules/demo-module/web/dist/web/index.js*", async (route) => {
    const bundle = [
      "const { react: React } = window.__JARVIS_MODULE_RUNTIME__;",
      "export default {",
      "  contractVersion: 2,",
      "  Root: (props) => {",
      "    if (!props.assistantSurface) return React.createElement('p', null, 'Assistant surface missing');",
      "    const Surface = props.assistantSurface.Surface;",
      "    return React.createElement(Surface, {",
      "      localRows: [",
      "        { id: 'intro', role: 'assistant', content: 'Scripted intro' },",
      "        { id: 'answer', role: 'user', content: 'Scripted answer' }",
      "      ],",
      "      recordKinds: ['reply', 'action_request'],",
      "      typing: true,",
      "      activeControl: React.createElement('button', {",
      "        type: 'button',",
      "        onClick: () => props.hostActions.openAssistant({ starterPrompt: 'Draft routed inline' })",
      "      }, 'Route draft inline'),",
      // Module-authored placeholder, deliberately still the old spelling (#1441): it overrides the
      // host's own `Message ${assistantName}` placeholder, and the spec asserts on the host's
      // aria-label separately — so the two staying different is the point.
      "      composer: { placeholder: 'Message embedded Jarvis' }",
      "    });",
      "  }",
      "};"
    ].join("\n");
    await route.fulfill({
      contentType: "text/javascript; charset=utf-8",
      body: bundle
    });
  });
}

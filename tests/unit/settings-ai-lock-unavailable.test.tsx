// @vitest-environment jsdom
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { ChatLockRows } from "../../apps/web/src/settings/settings-ai-chat-lock-group.js";
import { FeedbackProvider } from "../../apps/web/src/settings/settings-feedback.js";

it("shows the saved unavailable lock as selected so Not locked remains a distinct choice", () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(queryKeys.auth.me, { user: { id: "admin" } });
  client.setQueryData(queryKeys.ai.adminUserAiPin("admin"), {
    pin: {
      pinnedModelId: "missing-model",
      availableModels: [],
      effectiveChatReason: "admin-pin-unavailable",
      effectiveChatModel: null
    }
  });
  const html = renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(FeedbackProvider, null, createElement(ChatLockRows))
    )
  );
  const host = document.createElement("div");
  host.innerHTML = html;
  const select = host.querySelector("select");
  expect(select?.disabled).toBe(false);
  expect(select?.value).toBe("missing-model");
  expect(select?.selectedOptions[0]?.textContent).toBe("Locked model (unavailable)");
  expect(host.textContent).toContain("Chat is blocked until you clear the lock");
  client.clear();
});

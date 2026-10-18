import { describe, expect, it } from "vitest";

import { buildPushPayload, isSameOriginAppPath } from "@moss/notifications";
import { CHAT_MESSAGE_LINK_BASE, chatMessageHref } from "@moss/shared";

import { resolvePageHeading, webRoutes } from "../../apps/web/src/app-route-metadata.js";

// #3481: the link chat puts on a reminder alert survives every notifications check and lands on
// the chat message page, never on Today.
describe("chat message link", () => {
  const messageId = "4f2c7a1e-9b3d-4c8e-a6f0-2d5b8e1c7a90";
  const href = chatMessageHref(messageId);

  it("names the exact message under the chat link base", () => {
    expect(href).toBe(`/chat/messages/${messageId}`);
    expect(href.startsWith(`${CHAT_MESSAGE_LINK_BASE}/`)).toBe(true);
  });

  it("keeps the link through the bell and device alert checks", () => {
    expect(isSameOriginAppPath(href)).toBe(true);
    expect(buildPushPayload({ id: "n1", title: "Reminder from Moss", href }).href).toBe(href);
  });

  it("escapes an id so it cannot leave the chat link path", () => {
    expect(chatMessageHref("../today")).toBe("/chat/messages/..%2Ftoday");
  });

  it("lands on the chat message page", () => {
    const route = webRoutes.find((item) => item.match(href));
    expect(route?.id).toBe("chat-message");
    expect(resolvePageHeading(href, new Date("2026-10-17T12:00:00Z")).title).toBe("Chat");
  });
});

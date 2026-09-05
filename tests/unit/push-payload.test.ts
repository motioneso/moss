import { describe, expect, it } from "vitest";

import { buildPushPayload } from "@moss/notifications";

describe("buildPushPayload", () => {
  it("passes through a short title and body unchanged", () => {
    const payload = buildPushPayload({
      id: "notif-1",
      title: "Task due soon",
      body: "Finish the report",
      href: "/tasks/1"
    });

    expect(payload).toEqual({
      id: "notif-1",
      title: "Task due soon",
      body: "Finish the report",
      href: "/tasks/1"
    });
  });

  it("truncates a title longer than 60 characters", () => {
    const longTitle = "T".repeat(80);
    const payload = buildPushPayload({ id: "notif-2", title: longTitle, body: "x", href: null });

    expect(payload.title).toHaveLength(60);
    expect(payload.title).toBe("T".repeat(60));
  });

  it("truncates the body to 120 characters", () => {
    const longBody = "B".repeat(200);
    const payload = buildPushPayload({ id: "notif-3", title: "t", body: longBody, href: null });

    expect(payload.body).toHaveLength(120);
  });

  it("only carries the body's first line, dropping everything after the first newline", () => {
    const payload = buildPushPayload({
      id: "notif-4",
      title: "t",
      body: "First line\nSecond line with more detail",
      href: null
    });

    expect(payload.body).toBe("First line");
  });

  it("defaults a missing body to an empty string", () => {
    const payload = buildPushPayload({ id: "notif-5", title: "t", href: null });
    expect(payload.body).toBe("");
  });

  it("defaults a missing href to null", () => {
    const payload = buildPushPayload({ id: "notif-6", title: "t", body: "b" });
    expect(payload.href).toBeNull();
  });

  // #743 security finding 4: a link that could leave the app is dropped, not sent.
  it.each([
    "https://evil.example.com/x",
    "//evil.example.com/x",
    "/\\evil.example.com/x",
    "/\\\\evil.example.com",
    "javascript:alert(1)",
    "/tasks/1\n",
    "/tasks/\t1",
    "relative/path",
    ""
  ])("drops an href that is not a same-origin path: %j", (href) => {
    const payload = buildPushPayload({ id: "notif-5", title: "t", body: "b", href });
    expect(payload.href).toBeNull();
  });

  it("keeps a same-origin path with a query and fragment", () => {
    const payload = buildPushPayload({
      id: "notif-6",
      title: "t",
      body: "b",
      href: "/tasks/1?tab=notes#top"
    });
    expect(payload.href).toBe("/tasks/1?tab=notes#top");
  });
});

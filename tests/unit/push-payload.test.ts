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
});

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownMessage, safeUrl } from "../../apps/web/src/chat/markdown-message.js";
import { scheduledReadReport } from "../../packages/chat/src/scheduled-reads/report.js";
import { parseRecord } from "../../apps/web/src/chat/use-chat-stream.js";
import { readScheduledReadSource } from "../../packages/chat/src/route-serializers.js";

const delivered = { version: 1, kind: "reminder", event: "delivered", reminderId: "read" };

describe("scheduled report source rendering", () => {
  it("renders the trusted app link while source markdown and URLs remain plain text", () => {
    const title =
      "[click](javascript:alert(1)) [other](/tasks) https://evil.test javascript:alert(2)";
    const text = scheduledReadReport(
      {
        ok: true,
        data: {},
        structuredData: { task: { id: "item", title, status: "done" } }
      },
      "item"
    );
    expect(text).not.toBeNull();
    const record = parseRecord(
      JSON.stringify({ kind: "reply", text, scheduledReadSource: "tasks" })
    );
    expect(record?.scheduledReadSource).toBe("tasks");
    const html = renderToString(
      <MarkdownMessage text={record!.text} scheduledReadSource={record?.scheduledReadSource} />
    );
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('<a href="/tasks">Source: Tasks</a>');
    expect(html).toContain(title);
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="https://evil.test');
  });

  it("never grants an app link from arbitrary assistant text", () => {
    const html = renderToString(<MarkdownMessage text="[Source: Tasks](/tasks)" />);
    expect(html).not.toContain('href="/tasks"');
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,evil",
      "/tasks",
      "//evil.test",
      "\\evil.test"
    ])
      expect(safeUrl(url)).toBe("");
    expect(safeUrl("https://example.test")).toBe("https://example.test");
  });

  it("accepts only a worker success marker paired with delivered origin", () => {
    expect(readScheduledReadSource({ origin: delivered, scheduledReadSource: "tasks" })).toBe(
      "tasks"
    );
    expect(readScheduledReadSource({ scheduledReadSource: "tasks" })).toBeUndefined();
    expect(
      readScheduledReadSource({ origin: delivered, scheduledReadSource: "//evil.test" })
    ).toBeUndefined();
    expect(
      readScheduledReadSource({
        origin: { ...delivered, event: "saved" },
        scheduledReadSource: "tasks"
      })
    ).toBeUndefined();
  });
});

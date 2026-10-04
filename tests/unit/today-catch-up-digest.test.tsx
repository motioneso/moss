// @vitest-environment jsdom
// Today catch-up digest (#3028): each email's buttons record on the real task and feedback
// clients, and Undo reverses exactly what the button did.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BriefingCatchUpDto, LocaleSettingsDto } from "@moss/shared";

const api = vi.hoisted(() => ({
  createTask: vi.fn(),
  updateTask: vi.fn()
}));
const feedback = vi.hoisted(() => ({
  createUsefulnessFeedback: vi.fn(),
  undoUsefulnessFeedback: vi.fn()
}));

vi.mock("../../apps/web/src/api/client.js", () => api);
vi.mock("../../apps/web/src/api/usefulness-feedback-client.js", () => feedback);

import { BriefingCatchUp } from "../../apps/web/src/today/catch-up-digest.js";

const locale: LocaleSettingsDto = { timezone: "UTC", region: "en-US", dateFormat: "12" };
const now = new Date("2026-06-13T15:00:00.000Z");

const catchUp: BriefingCatchUpDto = {
  source: "email",
  itemCount: 2,
  since: "2026-06-12T07:00:00.000Z",
  leftOutCount: 14,
  asOf: null,
  entries: [
    {
      id: "email-digest:aaaa",
      senderName: "Priya Raman",
      summary: "The signed lease is attached.",
      receivedAt: "2026-06-13T08:14:00.000Z",
      reason: "important",
      cacheMessageId: "cache-1",
      openHref: "https://mail.example.com/m1"
    },
    {
      id: "email-digest:bbbb",
      senderName: "Oakridge Water",
      summary: "Water is off Tuesday morning.",
      receivedAt: "2026-06-12T21:12:00.000Z",
      reason: null,
      cacheMessageId: null,
      openHref: null
    }
  ]
};

let renderer: ReactTestRenderer;
const onOpenChat = vi.fn();

function render(chatAvailable = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    renderer = create(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(BriefingCatchUp, { catchUp, locale, chatAvailable, onOpenChat, now })
      )
    );
  });
}

function textOf(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(textOf).join("");
}

function rowOf(sender: string): ReactTestInstance {
  const row = renderer.root
    .findAll((node) => typeof node.type === "string" && node.props.className === "jds-index__row")
    .find((node) => textOf(node).includes(sender));
  if (!row) throw new Error(`no row for ${sender}`);
  return row;
}

function buttonIn(row: ReactTestInstance, label: string): ReactTestInstance {
  const button = row
    .findAll((node) => node.type === "button")
    .find((node) => textOf(node) === label || node.props["aria-label"]?.startsWith(label));
  if (!button) throw new Error(`no ${label} button`);
  return button;
}

async function click(button: ReactTestInstance) {
  await act(async () => {
    button.props.onClick();
    await Promise.resolve();
  });
}

const allText = () => textOf(renderer.root);

async function settle() {
  await act(async () => {
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  api.createTask.mockResolvedValue({ task: { id: "task-9" } });
  api.updateTask.mockResolvedValue({ task: { id: "task-9" } });
  feedback.createUsefulnessFeedback.mockImplementation(async (input: { kind: string }) => ({
    feedback: { id: `fb-${input.kind}` }
  }));
  feedback.undoUsefulnessFeedback.mockResolvedValue({ feedback: { id: "fb" } });
});

afterEach(() => {
  act(() => renderer.unmount());
  vi.clearAllMocks();
});

describe("BriefingCatchUp", () => {
  it("shows who wrote, what it is about, when, and why it made the list", () => {
    render();
    expect(allText()).toContain("2 emails since Fri 7:00 AM");
    expect(allText()).toContain("Priya Raman");
    expect(allText()).toContain("Important");
    expect(allText()).toContain("The signed lease is attached.");
    expect(textOf(rowOf("Priya Raman"))).toContain("8:14 AM");
    expect(textOf(rowOf("Oakridge Water"))).toContain("Fri 9:12 PM");
    expect(allText()).toContain("Left out 14 newsletters, receipts and notifications.");
  });

  it("offers Open only with a provider link and Reply only for a saved message", () => {
    render();
    const links = rowOf("Priya Raman").findAll((node) => node.type === "a");
    expect(links.map((node) => node.props.href)).toEqual(["https://mail.example.com/m1"]);
    expect(rowOf("Oakridge Water").findAll((node) => node.type === "a")).toHaveLength(0);
    expect(() => buttonIn(rowOf("Oakridge Water"), "Reply")).toThrow();
  });

  it("opens chat with the id-only reply prompt", async () => {
    render();
    await click(buttonIn(rowOf("Priya Raman"), "Reply"));
    expect(onOpenChat).toHaveBeenCalledWith(
      "Draft a reply to the cached email cache-1 using email.draftReply."
    );
  });

  it("dismisses through feedback and undoes the same signal", async () => {
    render();
    await click(buttonIn(rowOf("Priya Raman"), "Dismiss"));
    expect(feedback.createUsefulnessFeedback).toHaveBeenCalledWith({
      targetKind: "briefing_item",
      targetRef: "email-digest:aaaa",
      surface: "briefing",
      kind: "dismiss"
    });
    expect(textOf(rowOf("Priya Raman"))).toContain("Dismissed");

    await click(buttonIn(rowOf("Priya Raman"), "Undo"));
    expect(feedback.undoUsefulnessFeedback).toHaveBeenCalledWith("fb-dismiss");
    expect(api.updateTask).not.toHaveBeenCalled();
    expect(textOf(rowOf("Priya Raman"))).toContain("Add task");
  });

  it("adds a follow-up task, records it, and Undo archives the task", async () => {
    render();
    await click(buttonIn(rowOf("Oakridge Water"), "Add task"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.createTask).toHaveBeenCalledWith({
      title: "Follow up with Oakridge Water",
      description: "Water is off Tuesday morning."
    });
    expect(feedback.createUsefulnessFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ targetRef: "email-digest:bbbb", kind: "more_like_this" })
    );
    expect(textOf(rowOf("Oakridge Water"))).toContain("Added to your tasks");

    await click(buttonIn(rowOf("Oakridge Water"), "Undo"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(feedback.undoUsefulnessFeedback).toHaveBeenCalledWith("fb-more_like_this");
    expect(api.updateTask).toHaveBeenCalledWith("task-9", { status: "archived" });
  });

  it("runs one save per row and keeps Undo off until the save lands", async () => {
    const created = deferred<{ task: { id: string } }>();
    api.createTask.mockReturnValueOnce(created.promise);
    render();

    await click(buttonIn(rowOf("Oakridge Water"), "Add task"));
    expect(buttonIn(rowOf("Oakridge Water"), "Undo").props.disabled).toBe(true);
    await click(buttonIn(rowOf("Oakridge Water"), "Undo"));
    expect(textOf(rowOf("Oakridge Water"))).toContain("Added to your tasks");

    created.resolve({ task: { id: "task-9" } });
    await settle();
    expect(buttonIn(rowOf("Oakridge Water"), "Undo").props.disabled).toBe(false);

    const undone = deferred<{ feedback: { id: string } }>();
    feedback.undoUsefulnessFeedback.mockReturnValueOnce(undone.promise);
    await click(buttonIn(rowOf("Oakridge Water"), "Undo"));
    expect(buttonIn(rowOf("Oakridge Water"), "Add task").props.disabled).toBe(true);
    await click(buttonIn(rowOf("Oakridge Water"), "Add task"));

    undone.resolve({ feedback: { id: "fb" } });
    await settle();
    expect(api.createTask).toHaveBeenCalledTimes(1);
    expect(feedback.createUsefulnessFeedback).toHaveBeenCalledTimes(1);
    expect(api.updateTask).toHaveBeenCalledWith("task-9", { status: "archived" });
    expect(textOf(rowOf("Oakridge Water"))).toContain("Add task");
  });

  it("ignores Undo while the task is saving and puts the row back if the save fails", async () => {
    const created = deferred<{ task: { id: string } }>();
    api.createTask.mockReturnValueOnce(created.promise);
    render();

    await click(buttonIn(rowOf("Oakridge Water"), "Add task"));
    await click(buttonIn(rowOf("Oakridge Water"), "Undo"));
    created.reject(new Error("offline"));
    await settle();

    expect(textOf(rowOf("Oakridge Water"))).toContain("Add task");
    expect(allText()).toContain("That did not save. Try again.");
    expect(feedback.createUsefulnessFeedback).not.toHaveBeenCalled();
  });

  it("puts the row back when a pending dismissal fails", async () => {
    const saved = deferred<{ feedback: { id: string } }>();
    feedback.createUsefulnessFeedback.mockReturnValueOnce(saved.promise);
    render();

    await click(buttonIn(rowOf("Priya Raman"), "Dismiss"));
    await click(buttonIn(rowOf("Priya Raman"), "Undo"));
    saved.reject(new Error("offline"));
    await settle();

    expect(feedback.undoUsefulnessFeedback).not.toHaveBeenCalled();
    expect(textOf(rowOf("Priya Raman"))).toContain("Add task");
    expect(allText()).toContain("That did not save. Try again.");
  });

  it("keeps Undo when the task does not archive, and the retry only archives it", async () => {
    render();
    await click(buttonIn(rowOf("Oakridge Water"), "Add task"));
    await settle();

    api.updateTask.mockRejectedValueOnce(new Error("offline"));
    await click(buttonIn(rowOf("Oakridge Water"), "Undo"));
    await settle();
    expect(textOf(rowOf("Oakridge Water"))).toContain("Added to your tasks");
    expect(allText()).toContain("That did not save. Try again.");

    await click(buttonIn(rowOf("Oakridge Water"), "Undo"));
    await settle();
    expect(feedback.undoUsefulnessFeedback).toHaveBeenCalledTimes(1);
    expect(api.updateTask).toHaveBeenCalledTimes(2);
    expect(textOf(rowOf("Oakridge Water"))).toContain("Add task");
    expect(allText()).not.toContain("That did not save.");
  });

  it("archives a leftover task before dismissing the row", async () => {
    feedback.createUsefulnessFeedback.mockRejectedValueOnce(new Error("offline"));
    api.updateTask.mockRejectedValueOnce(new Error("offline"));
    render();
    await click(buttonIn(rowOf("Oakridge Water"), "Add task"));
    await settle();

    expect(api.updateTask).toHaveBeenCalledTimes(1);

    await click(buttonIn(rowOf("Oakridge Water"), "Dismiss"));
    await settle();
    expect(api.updateTask).toHaveBeenCalledTimes(2);
    expect(api.updateTask).toHaveBeenLastCalledWith("task-9", { status: "archived" });
    expect(feedback.createUsefulnessFeedback).toHaveBeenLastCalledWith(
      expect.objectContaining({ targetRef: "email-digest:bbbb", kind: "dismiss" })
    );
    expect(textOf(rowOf("Oakridge Water"))).toContain("Dismissed");
  });

  it("reuses a task it could not archive instead of creating another", async () => {
    feedback.createUsefulnessFeedback.mockRejectedValueOnce(new Error("offline"));
    api.updateTask.mockRejectedValueOnce(new Error("offline"));
    render();

    await click(buttonIn(rowOf("Oakridge Water"), "Add task"));
    await settle();
    expect(textOf(rowOf("Oakridge Water"))).toContain("Add task");
    expect(allText()).toContain("That did not save. Try again.");

    await click(buttonIn(rowOf("Oakridge Water"), "Add task"));
    await settle();
    expect(api.createTask).toHaveBeenCalledTimes(1);
    expect(textOf(rowOf("Oakridge Water"))).toContain("Added to your tasks");

    await click(buttonIn(rowOf("Oakridge Water"), "Undo"));
    await settle();
    expect(api.updateTask).toHaveBeenLastCalledWith("task-9", { status: "archived" });
  });

  it("puts the row back and says so when saving fails", async () => {
    feedback.createUsefulnessFeedback.mockRejectedValueOnce(new Error("offline"));
    render();
    await click(buttonIn(rowOf("Priya Raman"), "Dismiss"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(textOf(rowOf("Priya Raman"))).toContain("Add task");
    expect(allText()).toContain("That did not save. Try again.");
  });
});

import { describe, expect, it } from "vitest";

import { SessionTokenRegistry } from "@moss/ai";

import {
  admissionFixture,
  admissionTool,
  rejectAdmissionCard
} from "./helpers/gateway-admission-fixture.js";

// #3335: a launch replay has no user turn behind it, so nothing it asks for may run or reach the
// person. Each path must refuse before any card, record, audit row or handler.

const destructive = () =>
  admissionTool("notes.edit", { risk: "destructive", summarize: () => "Edit note" });
const read = () => admissionTool("notes.read", { risk: "read", summarize: () => "Read note" });

const acpRequest = {
  cwd: "/workspace/project",
  home: null,
  sessionId: "session-1",
  turnId: "turn-1",
  toolCallId: "call-1",
  title: "Run a command",
  toolName: "Bash",
  toolInput: { command: "echo hello" }
};

function replaying(tools: Parameters<typeof admissionFixture>[0], yolo: boolean) {
  const h = admissionFixture(tools, { deps: { yoloMode: async () => yolo } });
  h.tokens.beginLaunchReplay(h.token);
  return h;
}

function expectNothingReachedThePerson(h: ReturnType<typeof admissionFixture>) {
  expect(h.records).toEqual([]);
  expect(h.createPending).not.toHaveBeenCalled();
  expect(h.audit).not.toHaveBeenCalled();
  expect(h.confirmations.isAwaiting("action-1")).toBe(false);
}

describe("tool requests during a launch replay", () => {
  it.each([false, true])("refuse a module action without a card (YOLO=%s)", async (yolo) => {
    const tool = destructive();
    const h = replaying([tool], yolo);
    expect(await h.gateway.callTool(h.token, tool.name, {})).toMatchObject({ ok: false });
    expect(tool.execute).not.toHaveBeenCalled();
    expectNothingReachedThePerson(h);
  });

  it("refuse an automatic read", async () => {
    const tool = read();
    const h = replaying([tool], false);
    expect(await h.gateway.callTool(h.token, tool.name, {})).toMatchObject({ ok: false });
    expect(tool.execute).not.toHaveBeenCalled();
    expectNothingReachedThePerson(h);
  });

  it("decline a classifier gate call", async () => {
    const tool = read();
    const h = replaying([tool], false);
    expect(await h.gateway.callToolForGate(h.token, tool.name, {}, "execute")).toEqual({
      kind: "declined",
      reason: "refused"
    });
    expect(tool.execute).not.toHaveBeenCalled();
    expectNothingReachedThePerson(h);
  });

  it.each([false, true])("deny a native tool without a card (YOLO=%s)", async (yolo) => {
    const h = replaying([], yolo);
    expect(
      await h.gateway.requestNativeToolPermission(h.token, {
        toolName: "Bash",
        toolInput: { command: "echo hello" }
      })
    ).toMatchObject({ decision: "deny" });
    expectNothingReachedThePerson(h);
  });

  it.each([false, true])("deny an outside-agent tool without a card (YOLO=%s)", async (yolo) => {
    const h = replaying([], yolo);
    expect(await h.gateway.requestAcpBuiltInPermission(h.token, acpRequest)).toMatchObject({
      decision: "deny"
    });
    expectNothingReachedThePerson(h);
  });

  it("raise the usual card once the replay ends", async () => {
    const tool = destructive();
    const h = replaying([tool], false);
    h.tokens.endLaunchReplay(h.token);
    await rejectAdmissionCard(h, h.gateway.callTool(h.token, tool.name, {}));
    expect(h.records.map((record) => record.kind)).toEqual(["action_request", "action_result"]);
  });
});

describe("launch replay marker on session tokens", () => {
  const identity = {
    actorUserId: "actor-a",
    chatSessionId: "actor-a:chat",
    threadId: "thread-a",
    allowedToolNames: null
  };

  it("is off for a fresh token and follows begin and end", () => {
    const tokens = new SessionTokenRegistry();
    const token = tokens.mint(identity);
    expect(tokens.isInLaunchReplay(token)).toBe(false);
    tokens.beginLaunchReplay(token);
    expect(tokens.isInLaunchReplay(token)).toBe(true);
    tokens.endLaunchReplay(token);
    expect(tokens.isInLaunchReplay(token)).toBe(false);
  });

  it("marks only the named token", () => {
    const tokens = new SessionTokenRegistry();
    const first = tokens.mint(identity);
    const second = tokens.mint(identity);
    tokens.beginLaunchReplay(first);
    expect(tokens.isInLaunchReplay(second)).toBe(false);
  });

  it("ignores unknown tokens", () => {
    const tokens = new SessionTokenRegistry();
    tokens.beginLaunchReplay("jst_unknown");
    expect(tokens.isInLaunchReplay("jst_unknown")).toBe(false);
  });
});

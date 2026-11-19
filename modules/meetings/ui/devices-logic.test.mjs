import test from "node:test";
import assert from "node:assert/strict";
import {
  approvalCopy,
  codeFromHash,
  decisionBody,
  detailLine,
  presence,
  renameCheck
} from "./devices-logic.mjs";

const now = Date.parse("2026-11-18T12:00:00Z");
const mac = { platform: "macos", createdAt: "2026-11-03T09:00:00Z", lastContactAt: "2026-11-18T11:58:00Z" };
const phone = { platform: "android", createdAt: "2026-10-28T09:00:00Z", lastContactAt: "2026-11-17T09:00:00Z" };

test("a recent heartbeat reads Connected, an old one Last seen", () => {
  assert.deepEqual(presence(mac, now), { tone: "ready", text: "Connected" });
  assert.deepEqual(presence(phone, now), { tone: "idle", text: "Last seen yesterday" });
  assert.equal(presence({ ...phone, lastContactAt: "2026-11-03T09:00:00Z" }, now).text, "Last seen Nov 3");
  assert.equal(presence({ ...phone, lastContactAt: null }, now).text, "Not seen yet");
});

test("detail lines name the kind and the link date", () => {
  assert.equal(detailLine(mac, now), "macOS · Linked Nov 3");
  assert.equal(detailLine(phone, now), "Android · Ring linked · Linked Oct 28");
  assert.equal(detailLine({ ...mac, createdAt: "2026-11-18T11:59:00Z" }, now), "macOS · Linked just now");
});

test("rename trims and limits the name", () => {
  assert.deepEqual(renameCheck("  Desk Mac "), { name: "Desk Mac" });
  assert.ok(renameCheck("   ").error);
  assert.ok(renameCheck("x".repeat(65)).error);
  assert.equal(renameCheck("x".repeat(64)).name.length, 64);
});

test("approval wording differs for a Mac and a phone", () => {
  const m = approvalCopy({ deviceName: "Desk", recordingPolicyVersion: 1 });
  assert.equal(m.title, "Do you recognise this Mac?");
  assert.deepEqual(m.can, ["Record meetings when you choose Start", "Send screen history to Backtrack"]);
  assert.equal(m.link, "Link Mac");
  const p = approvalCopy({ deviceName: "Pixel", platform: "android" });
  assert.equal(p.deny, "Not this phone");
  assert.equal(p.can[1], "Bring in recordings from your ring");
  assert.deepEqual(approvalCopy({ deviceName: "Old" }).can, ["Send screen history to Backtrack"]);
});

test("linking a Mac that asked for recording names the policy version", () => {
  assert.deepEqual(decisionBody("c", true, { recordingPolicyVersion: 1 }), {
    code: "c",
    decision: "approve",
    recordingPolicyVersion: 1
  });
  assert.deepEqual(decisionBody("c", false, { recordingPolicyVersion: 1 }), { code: "c", decision: "deny" });
  assert.deepEqual(decisionBody("c", true, { platform: "android" }), { code: "c", decision: "approve" });
});

test("the code is read only when it has the right shape", () => {
  assert.equal(codeFromHash("#code=abcDEF123_-xyz"), "abcDEF123_-xyz");
  assert.equal(codeFromHash("#code=short"), null);
  assert.equal(codeFromHash("#code=has space here"), null);
  assert.equal(codeFromHash(""), null);
});

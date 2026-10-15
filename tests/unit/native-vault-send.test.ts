import { describe, expect, it } from "vitest";
import { sendAcpLine } from "../../packages/cli-runner/src/native-vault-send.js";

function fixture() {
  const written: string[] = [];
  return {
    written,
    session: {
      userId: "owner",
      identity: { uid: 100001, gid: 100001 },
      child: { stdin: { write: (line: string) => written.push(line) } },
      lastActivity: 0
    }
  };
}
describe("native vault preparation before opaque ACP forwarding", () => {
  it("reports a failed preparation, writes nothing, and retries on the next send", async () => {
    const { session, written } = fixture();
    await expect(
      sendAcpLine(session, "first", 100, async () => {
        throw new Error("transient");
      })
    ).rejects.toThrow("transient");
    expect(written).toEqual([]);
    await sendAcpLine(session, "second", 100, async () => {});
    expect(written).toEqual(["second\n"]);
  });
  it("keeps concurrent lines in order while preparation is pending", async () => {
    const { session, written } = fixture();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = sendAcpLine(session, "first", 100, () => barrier);
    const second = sendAcpLine(session, "second", 100, async () => {});
    await Promise.resolve();
    expect(written).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(written).toEqual(["first\n", "second\n"]);
  });
});

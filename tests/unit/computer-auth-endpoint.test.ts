import { once } from "node:events";
import { lstat, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { serveComputerAuth } from "../../apps/api/src/computer/auth-server.js";
import { authFixture, OWNER } from "./computer-auth-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

describe("Computer auth endpoint ownership", () => {
  it("publishes a protected alias and removes its owned endpoint and empty directory once", async () => {
    const f = await authFixture();
    cleanups.push(() => f.close());
    const directory = (await readdir(f.root)).find((name) => name.startsWith(".auth-"));
    expect(directory).toBeDefined();
    expect((await lstat(f.root + "/" + directory)).mode & 0o777).toBe(0o700);
    const endpoint = await lstat(f.socketPath);
    expect(endpoint.isSocket()).toBe(true);
    expect(endpoint.mode & 0o777).toBe(0o600);
    expect(endpoint.nlink).toBe(2);
    const firstClose = f.server.close();
    expect(f.server.close()).toBe(firstClose);
    await firstClose;
    expect(await readdir(f.root)).toEqual([]);
    await f.server.close();
  });

  it("preserves a replacement listener when the original service closes", async () => {
    const f = await authFixture();
    cleanups.push(() => f.close());
    const original = await lstat(f.socketPath);
    await unlink(f.socketPath);
    const replacement = createServer((socket) => socket.destroy());
    cleanups.unshift(() => new Promise<void>((resolve) => replacement.close(() => resolve())));
    replacement.listen(f.socketPath);
    await once(replacement, "listening");
    const identity = await lstat(f.socketPath);
    expect(identity.ino).not.toBe(original.ino);
    await f.server.close();
    expect((await lstat(f.socketPath)).ino).toBe(identity.ino);
    expect(await readdir(f.root)).toEqual(["auth.sock"]);
    // A surviving directory entry must still reach the replacement listener.
    const raw = await f.raw();
    await once(raw, "close");
  });

  it.each(["listener", "file"])(
    "failed exclusive publication preserves an existing %s and removes only the failed bind",
    async (kind) => {
      const f = await authFixture();
      cleanups.push(() => f.close());
      if (kind === "file") {
        await f.server.close();
        await writeFile(f.socketPath, "synthetic-existing-entry");
      }
      const before = await readdir(f.root);
      const original = await lstat(f.socketPath);
      await expect(
        serveComputerAuth({
          socketPath: f.socketPath,
          ownerUserId: OWNER,
          sessions: { assertLive: f.assertLive },
          invalidations: f.invalidations
        })
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readdir(f.root)).toEqual(before);
      expect((await lstat(f.socketPath)).ino).toBe(original.ino);
      if (kind === "file")
        expect(await readFile(f.socketPath, "utf8")).toBe("synthetic-existing-entry");
      else {
        const client = await f.connect();
        await client.assertLive({ actorUserId: OWNER, sessionId: client.binding.sessionId });
      }
    }
  );
});

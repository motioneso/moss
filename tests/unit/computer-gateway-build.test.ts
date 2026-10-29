import { createHash } from "node:crypto";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import type * as Esbuild from "esbuild";
import type * as Fs from "node:fs/promises";
import { buildComputerGateway } from "../../scripts/computer-gateway/build.js";
import { processFixture } from "./computer-process-fixture.js";
import { OWNER, SESSION } from "./computer-auth-fixture.js";
import { WIDTH, HEIGHT } from "./computer-gateway-fixture.js";

vi.mock("esbuild", async (original) => {
  const actual = await original<typeof Esbuild>();
  return { ...actual, build: vi.fn(actual.build) };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof Fs>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.mocked(build).mockReset();
  vi.mocked(build).mockImplementation((await vi.importActual<typeof Esbuild>("esbuild")).build);
  vi.mocked(readFile).mockReset();
  vi.mocked(readFile).mockImplementation(
    (await vi.importActual<typeof Fs>("node:fs/promises")).readFile
  );
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function context() {
  const root = await mkdtemp(join(tmpdir(), "computer-bundle-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return { root, output: join(root, "context") };
}

describe("standalone Computer gateway packaging", () => {
  it("builds a deterministic closed context whose receipt matches the actual source and output bytes", async () => {
    const { root, output } = await context();
    const receipt = await buildComputerGateway(output);
    const second = join(root, "second");
    expect(await buildComputerGateway(second)).toEqual(receipt);
    expect(await readdir(output)).toEqual([
      ".dockerignore",
      "Dockerfile",
      "build.json",
      "gateway.cjs"
    ]);
    for (const file of await readdir(output))
      expect(await readFile(join(output, file))).toEqual(await readFile(join(second, file)));
    const bundle = await readFile(join(output, "gateway.cjs"));
    expect(receipt.bundle).toEqual({ sha256: sha256(bundle), bytes: bundle.length });
    expect(receipt.format).toBe("cjs");
    expect(receipt.target).toBe("node24");
    expect(receipt.compiler).toEqual({ name: "esbuild", version: "0.25.12" });
    expect(receipt.sourceSha256).toHaveProperty("scripts/computer-gateway.ts");
    for (const hashes of [receipt.sourceSha256, receipt.controlSha256]) {
      for (const [path, hash] of Object.entries(hashes)) {
        expect(path).not.toMatch(/^(\/|\.\.)/);
        expect(sha256(await readFile(resolve(path)))).toBe(hash);
      }
    }
    const recipe = await readFile(join(output, "Dockerfile"));
    expect(receipt.dockerfileSha256).toBe(sha256(recipe));
    expect(receipt.dockerignoreSha256).toBe(sha256(await readFile(join(output, ".dockerignore"))));
    expect(recipe.toString()).toContain("FROM " + receipt.baseImage);
    expect(receipt.baseImage).toBe(
      "node:24-bookworm-slim@sha256:2dd9a4f758e173b65fee15388f7706af6fb01ef50cf7a2c0538711d67a6981ae"
    );
    expect(recipe.toString()).toContain("USER 1000:1000");
    expect(recipe.toString()).toContain(
      'ENTRYPOINT ["/usr/local/bin/node", "--max-old-space-size=64", "/opt/moss-computer/gateway.cjs"]'
    );
    expect(recipe.toString()).toContain('CMD ["/config/gateway.json"]');
    expect(recipe.toString()).not.toMatch(/^(RUN|ARG|EXPOSE|VOLUME|HEALTHCHECK)\b/m);
    expect((await readFile(join(output, ".dockerignore"), "utf8")).trim()).toBe(
      "*\n!Dockerfile\n!gateway.cjs"
    );
    expect((await lstat(output)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(join(output, "build.json"), "utf8"))).toEqual(receipt);
    execFileSync(process.execPath, ["--check", join(output, "gateway.cjs")]);
  });

  it("executes the emitted artifact without a loader or checkout: pixels, exclusion, pressed release, return, close and TERM", async () => {
    const { output } = await context();
    await buildComputerGateway(output);
    const f = await processFixture(join(output, "gateway.cjs"));
    cleanups.push(() => f.close());
    const { viewer } = await f.open();
    const watcher = await f.rfb(viewer);
    const update = once(watcher, "update");
    watcher.requestUpdate(false);
    const [frame] = await update;
    expect(frame.rects[0]).toMatchObject({ width: WIDTH, height: HEIGHT });
    expect([...frame.rects[0].data.subarray(0, 4)]).toEqual([204, 34, 17, 0]);
    watcher.keyEvent(66, true);
    expect(f.events).toEqual([]);
    await viewer.takeOver();
    const controller = await f.rfb(viewer, true);
    controller.keyEvent(65, true);
    await vi.waitFor(() => expect(f.events).toContainEqual(["key", 65, true]));
    f.holdFences();
    const returning = viewer.returnToMoss();
    await once(controller, "close");
    f.releaseFences();
    await returning;
    expect(f.events).toContainEqual(["key", 65, false]);
    expect(await viewer.snapshot()).toMatchObject({ mode: "moss", receivingReady: true });
    await viewer.takeOver();
    await f.rfb(viewer, true);
    await viewer.closeViewer();
    expect(f.connections).toBe(1);
    expect(f.events).not.toContainEqual(["key", 66, true]);
    expect(await f.stop()).toBe(0);
    expect(f.childOutput).toBe("Computer gateway listening\n");
    await expect(lstat(f.config.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(f.auth.root)).filter((name) => name.startsWith(".gateway-"))).toEqual([]);
  });

  it("active auth push closes the compiled visual writer and preserves paused state", async () => {
    const { output } = await context();
    await buildComputerGateway(output);
    const f = await processFixture(join(output, "gateway.cjs"));
    cleanups.push(() => f.close());
    const { viewer } = await f.open();
    await viewer.takeOver();
    const controller = await f.rfb(viewer, true);
    const closed = once(controller, "close");
    f.auth.invalidations.invalidate({ actorUserId: OWNER, sessionId: SESSION });
    await closed;
    expect(await viewer.snapshot()).toMatchObject({ mode: "paused", receivingReady: false });
    await expect(viewer.takeOver()).rejects.toThrow();
  });

  it("refuses an existing output directory or symlink without altering its contents", async () => {
    const { root, output } = await context();
    await mkdir(output);
    await writeFile(join(output, "retained"), "previous artifact");
    await expect(buildComputerGateway(output)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readdir(output)).toEqual(["retained"]);
    expect(await readFile(join(output, "retained"), "utf8")).toBe("previous artifact");
    const alias = join(root, "alias");
    await symlink(output, alias);
    await expect(buildComputerGateway(alias)).rejects.toMatchObject({ code: "EEXIST" });
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    expect(await readdir(output)).toEqual(["retained"]);
  });

  it("rejects a real compiler result with a nonbuiltin external before publishing", async () => {
    const { output } = await context();
    const actual = await vi.importActual<typeof Esbuild>("esbuild");
    vi.mocked(build).mockImplementationOnce((options) =>
      actual.build({
        ...options,
        plugins: [
          {
            name: "inject-unbundled-dependency",
            setup(compiler) {
              compiler.onResolve({ filter: /^node:net$/ }, () => ({
                path: "computer-unbundled-dependency",
                external: true
              }));
            }
          },
          ...(options.plugins ?? [])
        ]
      })
    );
    await expect(buildComputerGateway(output)).rejects.toThrow(
      "Computer bundle has nonbuiltin runtime dependencies"
    );
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an input changed after actual compilation before publishing", async () => {
    const { output } = await context();
    const actualBuild = await vi.importActual<typeof Esbuild>("esbuild");
    const actualFs = await vi.importActual<typeof Fs>("node:fs/promises");
    vi.mocked(build).mockImplementationOnce(async (options) => {
      const result = await actualBuild.build(options);
      // Simulate a concurrent edit at the final filesystem read; do not mutate tracked files.
      vi.mocked(readFile).mockImplementationOnce(async () => Buffer.from("changed input"));
      return result;
    });
    await expect(buildComputerGateway(output)).rejects.toThrow(
      "Computer build input changed during compilation"
    );
    vi.mocked(readFile).mockImplementation(actualFs.readFile);
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

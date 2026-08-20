import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

// #1748 — the host half of the admin "Restart app" button. These assertions guard two
// properties that are invisible in review but expensive live: the restart-loop ordering,
// and the promise that the app container never gets Docker access.
describe("infra/host restart unit", () => {
  const readScript = (name: string) =>
    readFile(new URL(`../../infra/host/${name}`, import.meta.url), "utf8");

  it("deletes the request sentinel BEFORE restarting, so a failed restart cannot loop", async () => {
    const script = await readScript("jarv1s-restart.sh");
    const removeAt = script.indexOf('rm -f "$SENTINEL"');
    const restartAt = script.indexOf("docker restart");
    expect(removeAt).toBeGreaterThan(-1);
    expect(restartAt).toBeGreaterThan(-1);
    // Reversed, the path unit re-fires on every failure and the host restart-loops.
    expect(removeAt).toBeLessThan(restartAt);
  });

  it("never reads the sentinel's contents — there is no value for the app to inject", async () => {
    const script = await readScript("jarv1s-restart.sh");
    expect(script).toContain("set -euo pipefail");
    expect(script).not.toMatch(/\$\(\s*cat\s+"?\$SENTINEL/);
    expect(script).not.toMatch(/<\s*"?\$SENTINEL/);
    // The container name comes from the unit's own environment, never from the request.
    expect(script).toContain('CONTAINER="${JARVIS_RESTART_CONTAINER:-moss}"');
  });

  it("touches the liveness marker so the API can tell the watcher exists", async () => {
    const script = await readScript("jarv1s-restart.sh");
    const installer = await readScript("install-restart-unit.sh");
    expect(script).toContain('touch "$ALIVE"');
    expect(installer).toContain('touch "${CONTROL_DIR}/watcher-alive"');
  });

  it("the shipped compose file grants a control directory, never the Docker socket", async () => {
    const compose = await readFile(
      new URL("../../infra/docker-compose.prod.yml", import.meta.url),
      "utf8"
    );
    expect(compose).toContain("./control:/data/control");
    expect(compose).toContain("JARVIS_HOST_CONTROL_DIR: /data/control");
    // The whole point of the design. A socket mount here would make any code execution
    // inside the app container root on the host.
    expect(compose).not.toContain("docker.sock");
  });
});

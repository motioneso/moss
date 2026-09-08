import { describe, expect, it } from "vitest";

import {
  buildSetprivDropCommand,
  buildSetprivRaiseCommand
} from "../../packages/cli-runner/src/setpriv.js";

describe("setpriv command lines", () => {
  it("raises exactly the named capabilities as inheritable and ambient", () => {
    const built = buildSetprivRaiseCommand("node", ["main.js"], { uid: 1000, gid: 1000 }, [
      "chown",
      "setuid",
      "setgid"
    ]);

    expect(built.command).toBe("setpriv");
    expect(built.args).toEqual([
      "--reuid=1000",
      "--regid=1000",
      "--init-groups",
      "--inh-caps=+chown,+setuid,+setgid",
      "--ambient-caps=+chown,+setuid,+setgid",
      "--",
      "node",
      "main.js"
    ]);
  });

  it("drops every inheritable and ambient capability while switching accounts", () => {
    const built = buildSetprivDropCommand("claude", ["--acp"], { uid: 2001, gid: 2001 });

    expect(built.command).toBe("setpriv");
    expect(built.args).toEqual([
      "--reuid=2001",
      "--regid=2001",
      "--init-groups",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--",
      "claude",
      "--acp"
    ]);
  });

  it("carries every argument through untouched, in order", () => {
    const built = buildSetprivDropCommand("sh", ["-c", "echo hi && exit 1"], {
      uid: 42,
      gid: 42
    });

    expect(built.args.slice(-2)).toEqual(["-c", "echo hi && exit 1"]);
  });
});

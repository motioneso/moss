import { describe, expect, it } from "vitest";

import {
  AcpCredentialBadRequestError,
  readAcpSpawnCredential
} from "../../packages/cli-runner/src/acp-spawn-credential.js";

const credential = { apiKey: "test-key-0001", model: "org/model:tag@v2" };

describe("acpSpawn credential address", () => {
  it("accepts a plain http(s) address", () => {
    expect(
      readAcpSpawnCredential({ ...credential, baseUrl: "http://proxy.test/v1" }, "opencode", "chat")
    ).toEqual({ ...credential, baseUrl: "http://proxy.test/v1" });
  });

  it.each([
    ["a username and password", "http://user:hunter2pw@proxy.test/v1"],
    ["a username alone", "https://hunter2user@proxy.test"],
    ["a password alone", "http://:hunter2pw@proxy.test/v1"]
  ])("refuses an address carrying %s, naming no part of it", (_label, baseUrl) => {
    let failure: unknown;
    try {
      readAcpSpawnCredential({ ...credential, baseUrl }, "anthropic", "chat");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AcpCredentialBadRequestError);
    const message = (failure as Error).message;
    expect(message).toBe("acpSpawn.credential.baseUrl must not include a username or password");
    expect(message).not.toMatch(/hunter2|proxy\.test/);
  });
});

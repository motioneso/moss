import { describe, expect, it } from "vitest";

import { OLD_PASSWORD_FORMS, scanFileContents } from "../../scripts/check-no-dev-password.ts";

/**
 * Regression test for #2335. The guard's old-password check advertises plain, base64 and
 * "web-encoded" forms, but the web-encoded branch could never run: it used `encodeURIComponent`,
 * which leaves the password's trailing "!" unescaped, so the encoded form was identical to the
 * plain one and the `!==` guard skipped it. The case below is the one that branch exists for.
 *
 * The password is assembled from parts at runtime, exactly as the guard itself does, so this file
 * never carries a contiguous copy that the guard would then flag.
 */
const OLD_PASSWORD = ["jarvis", "test", "123", "!"].join("");
const OWNER_EMAIL = ["ben", "ben.com"].join("@");

describe("scanFileContents: old development password forms", () => {
  it("flags the plain password", () => {
    const result = scanFileContents("docs/handoff.md", `the password was ${OLD_PASSWORD} today\n`);

    expect(result.oldPasswordLines).toEqual([1]);
  });

  it("flags the base64 form", () => {
    const encoded = Buffer.from(OLD_PASSWORD, "utf8").toString("base64");

    const result = scanFileContents("scripts/thing.ts", `const token = "${encoded}";\n`);

    expect(result.oldPasswordLines).toEqual([1]);
  });

  it("flags the form-urlencoded (web-encoded) form", () => {
    // Prove the form is genuinely different from the plain one, so this test cannot pass
    // vacuously the way the branch used to be skipped.
    const encoded = OLD_PASSWORD_FORMS.urlEncoded;
    expect(encoded).not.toBe(OLD_PASSWORD);
    expect(encoded).toContain("%21");

    const result = scanFileContents("docs/note.md", `pasted as ${encoded} in the url\n`);

    expect(result.oldPasswordLines).toEqual([1]);
  });

  it("flags a copy split across a line break", () => {
    const split = `${OLD_PASSWORD.slice(0, 12)}\n${OLD_PASSWORD.slice(12)}`;

    const result = scanFileContents("docs/note.md", `line one ${split}\n`);

    expect(result.oldPasswordLines).toEqual([1]);
  });

  it("does not flag an unrelated file", () => {
    const result = scanFileContents("docs/note.md", "nothing sensitive here\n");

    expect(result.oldPasswordLines).toEqual([]);
  });
});

describe("scanFileContents: hardcoded owner credential", () => {
  it("flags a literal password in the same object as the owner email", () => {
    const contents = `const OWNER = { email: "${OWNER_EMAIL}", password: "hunter2" };\n`;

    const result = scanFileContents("apps/api/src/seed.ts", contents);

    expect(result.hardcodedCredentialLine).toBe(1);
  });

  it("does not flag a password read from the environment", () => {
    const contents = `const OWNER = { email: "${OWNER_EMAIL}", password: process.env.OWNER_PASSWORD };\n`;

    const result = scanFileContents("apps/api/src/seed.ts", contents);

    expect(result.hardcodedCredentialLine).toBeNull();
  });
});

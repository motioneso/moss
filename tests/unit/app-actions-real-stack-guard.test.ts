import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { disposableStackProblems } from "../uat/specs/app-actions-real-proof.js";

const PROJECT = "uat-4242_0123abcd";

const problems = (baseURL: string, claimedWebPort?: number, projectName = PROJECT) =>
  disposableStackProblems({ baseURL, projectName, claimedWebPort });

describe("#3065 real spec only targets its own throwaway stack (#3278)", () => {
  it("accepts the reserved range when no port was claimed", () => {
    expect(problems("http://127.0.0.1:20000/")).toEqual([]);
    expect(problems("http://127.0.0.1:20099/")).toEqual([]);
  });

  it("accepts exactly the harness's claimed port", () => {
    expect(problems("http://127.0.0.1:5184/", 5184)).toEqual([]);
  });

  describe("rejects every other target", () => {
    it("a claimed-range port with no claim", () => {
      expect(problems("http://127.0.0.1:5184/")).toContain("port is not the harness's");
    });

    it("a port other than the claimed one", () => {
      expect(problems("http://127.0.0.1:5185/", 5184)).toContain("port is not the harness's");
      expect(problems("http://127.0.0.1:20000/", 5184)).toContain("port is not the harness's");
    });

    it("a reserved-range port just outside the range", () => {
      expect(problems("http://127.0.0.1:19999/")).toContain("port is not the harness's");
      expect(problems("http://127.0.0.1:20100/")).toContain("port is not the harness's");
    });

    it("a claim outside the shared dev range, including the dev screen and prod", () => {
      for (const port of [5173, 1533, 3000, 5179, 5300]) {
        expect(problems(`http://127.0.0.1:${port}/`, port)).toContain(
          "claimed port is outside the shared dev range"
        );
      }
    });

    it("a URL with no explicit port", () => {
      expect(problems("http://127.0.0.1/")).toContain("port is not the harness's");
    });

    it("another protocol", () => {
      expect(problems("https://127.0.0.1:5184/", 5184)).toContain("protocol is not http");
    });

    it("any host but loopback", () => {
      for (const host of ["localhost", "0.0.0.0", "10.0.0.5", "moss.example"]) {
        expect(problems(`http://${host}:5184/`, 5184)).toContain("host is not 127.0.0.1");
      }
    });

    it("credentials, a query or a fragment", () => {
      for (const url of [
        "http://user:pw@127.0.0.1:5184/",
        "http://127.0.0.1:5184/?x=1",
        "http://127.0.0.1:5184/#x"
      ]) {
        expect(problems(url, 5184)).toContain("URL carries credentials, a query or a fragment");
      }
    });

    it("a path", () => {
      expect(problems("http://127.0.0.1:5184/app", 5184)).toContain("URL has a path");
    });

    it("a project the harness did not generate", () => {
      for (const project of ["jarv1s-prod", "uat-1_0123abc", "uat-x_0123abcd", "moss-proof"]) {
        expect(problems("http://127.0.0.1:5184/", 5184, project)).toContain(
          "project is not a generated UAT project"
        );
      }
    });
  });
});

const STACK_CHECK =
  /expect\(\s*disposableStackProblems\(\{\s*baseURL: requireUatBaseURL\(\),\s*projectName: requireUatProjectName\(\),\s*claimedWebPort: readClaimedWebPort\(\)\s*\}\),\s*"[^"]+"\s*\)\.toEqual\(\[\]\);/;

/** Whether a spec checks its stack with the shared rules and nothing narrower. */
const usesSharedStackCheck = (text: string) =>
  STACK_CHECK.test(text) && !/UAT_PORT_RANGE_(START|SIZE)/.test(text);

describe.each(["3065-app-actions-real.uat.spec.ts", "3065-app-actions.uat.spec.ts"])(
  "%s checks its stack with the shared claimed-port rules (#3278)",
  (file) => {
    const source = () => readFile(new URL(`../uat/specs/${file}`, import.meta.url), "utf8");

    it("uses the shared check", async () => {
      expect(usesSharedStackCheck(await source())).toBe(true);
    });

    it("negative control: a check that ignores the claim is caught", async () => {
      const text = await source();
      const next = text.replace(
        "claimedWebPort: readClaimedWebPort()",
        "claimedWebPort: undefined"
      );
      expect(next).not.toBe(text);
      expect(usesSharedStackCheck(next)).toBe(false);
    });

    it("negative control: a reserved-range-only port check is caught", async () => {
      const text = await source();
      expect(
        usesSharedStackCheck(
          `${text}\nexpect(port).toBeLessThan(UAT_PORT_RANGE_START + UAT_PORT_RANGE_SIZE);`
        )
      ).toBe(false);
    });
  }
);

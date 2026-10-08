import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("recognizes the installed Vitest semantic429 assertion without accepting SQL or setup errors", () => {
  let assertion = "";
  try {
    expect(undefined, "capture-hour-semantic-429").toBe(429);
  } catch (error) {
    assertion = String(error);
  }
  expect(assertion).toContain("capture-hour-semantic-429");
  const runner = fileURLToPath(
    new URL("../../scripts/check-meeting-link-negative-controls.py", import.meta.url)
  );
  const checked = spawnSync(
    "python3",
    [
      "-c",
      `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("proof_runner", sys.argv[1])
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
control = next(item for item in runner.HOSTED_CONTROLS if item["name"] == "T10-account-hour")
positive, negatives = json.load(sys.stdin)
assert runner.expected_assertion(control, positive), "installed Vitest semantic429 assertion was rejected"
assert not any(runner.expected_assertion(control, failure) for failure in negatives), "unrelated failure was accepted"
runner.self_test()
`,
      runner
    ],
    {
      input: JSON.stringify([
        assertion,
        [
          'error: new row violates check constraint "meeting_capture_start_limits_bounded" (23514)',
          "Error: expected error: new row for relation meeting_capture_start_limits to match object { httpStatus: 429 } __VITEST_REJECTS__",
          "AssertionError: expected undefined to be 429",
          "TypeError: capture-hour-semantic-429 setup failed"
        ]
      ]),
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }
    }
  );
  expect(checked.error).toBeUndefined();
  expect(checked.status, checked.stderr).toBe(0);
});

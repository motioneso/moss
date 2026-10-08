import { writeFileSync } from "node:fs";
import type { Reporter, SerializedError, TestModule, TestRunEndReason } from "vitest/node";

/** Vitest's JSON reporter omits runtime errors; proof must check this separate receipt too. */
export default class MeetingProofRuntimeReporter implements Reporter {
  onTestRunEnd(
    modules: readonly TestModule[],
    unhandledErrors: readonly SerializedError[],
    reason: TestRunEndReason
  ) {
    const path = process.env.MOSS_PROOF_RUNTIME_REPORT;
    if (!path) throw new Error("Missing proof runtime report destination");
    const collectionErrors = modules.reduce(
      (count, module) =>
        count +
        module.errors().length +
        [...module.children.allSuites()].reduce((sum, suite) => sum + suite.errors().length, 0),
      0
    );
    // Counts only: do not persist raw errors, request data, or other private test content.
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        reason,
        moduleCount: modules.length,
        unhandledErrors: unhandledErrors.length,
        collectionErrors
      }) + "\n"
    );
  }
}

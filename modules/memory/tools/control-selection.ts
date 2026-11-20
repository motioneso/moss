// Existing tests that remove row security as a negative control. The db file moves whole.
export const memoryGuardControls: Record<string, string> = {
  account: "export_returns_only_the_callers_rows_and_no_vectors",
  recording:
    "a_second_person_cannot_reach_the_first_persons_recording_memory_and_the_check_has_teeth",
  reembed: "a_second_person_sees_and_touches_nothing_of_the_first_persons_run"
};

export function memoryControlArgs(suite: string, mode = "all"): string[] {
  if (!["all", "skip", "only"].includes(mode)) throw new Error("Unknown Memory control tier");
  const control = memoryGuardControls[suite];
  if (mode === "only") {
    if (!control) throw new Error("No separate Memory control for this suite");
    return [control, "--exact"];
  }
  return mode === "skip" && control ? ["--skip", control, "--exact"] : [];
}

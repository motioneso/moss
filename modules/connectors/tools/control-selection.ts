// Existing tests that remove row security as a negative control. Refresh moves whole.
export const connectorsGuardControls: Record<string, string[]> = {
  db: [
    "a_second_person_cannot_read_update_revoke_or_grant",
    "a_second_person_cannot_write_a_monitor_health_row_for_another_persons_account",
    "a_second_person_cannot_write_an_outlook_health_row_for_another_persons_account",
    "an_existing_install_survives_the_upgrade"
  ],
  google_sync: ["a_second_person_can_neither_start_nor_read_through_another_persons_account"],
  google: ["a_second_person_cannot_start_complete_or_revoke_another_persons_connection"],
  imap: ["a_second_person_cannot_see_or_overwrite_another_persons_mail_account"],
  writes: ["a_second_person_cannot_send_or_draft_through_another_persons_account"]
};

export function connectorsControlArgs(suite: string, mode = "all"): string[] {
  if (!["all", "skip", "only"].includes(mode)) throw new Error("Unknown Connectors control tier");
  const controls = connectorsGuardControls[suite] ?? [];
  if (mode === "only") {
    if (!controls.length) throw new Error("No separate Connectors controls for this suite");
    return [...controls, "--exact"];
  }
  return mode === "skip" && controls.length
    ? [...controls.flatMap((name) => ["--skip", name]), "--exact"]
    : [];
}

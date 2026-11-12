/** Wording and buttons for the re-embed section of the Search model screen. */
export function describe(status) {
  const run = status?.run;
  const other = Number(status?.otherModel) || 0;
  if (run?.status === "running") {
    return {
      text: `Re-embedding: ${run.staged} of ${run.total} passages.`,
      button: "Cancel",
      act: "cancel"
    };
  }
  if (run?.status === "failed" && other > 0) {
    return {
      text: "The last re-embed stopped. Search keeps using the old data.",
      button: "Try again",
      act: "start"
    };
  }
  if (other > 0) {
    const noun = other === 1 ? "passage uses" : "passages use";
    return { text: `${other} ${noun} another model.`, button: "Re-embed", act: "start" };
  }
  return null;
}

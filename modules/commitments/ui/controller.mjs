import { snoozeUntil } from "./view.mjs";

export function reviewController(api, draw, now = () => new Date()) {
  const state = {
    phase: "loading",
    rows: [],
    busy: "",
    error: "",
    notice: "",
    picker: "",
    pickerDate: "",
    minimumDate: ""
  };
  async function load() {
    if (state.busy) return;
    state.phase = "loading";
    state.error = "";
    draw(state);
    try {
      state.rows = await api.pending();
      state.phase = "ready";
    } catch {
      state.phase = "error";
      state.error = "Commitments couldn't load. Try again.";
    }
    draw(state);
  }
  async function act(id, action, date) {
    if (state.busy) return;
    state.error = "";
    state.notice = "";
    if (action === "pick" || action === "cancel") {
      state.picker = action === "pick" ? id : "";
      state.pickerDate = "";
      const tomorrow = new Date(now());
      tomorrow.setDate(tomorrow.getDate() + 1);
      state.minimumDate = [
        tomorrow.getFullYear(),
        String(tomorrow.getMonth() + 1).padStart(2, "0"),
        String(tomorrow.getDate()).padStart(2, "0")
      ].join("-");
      draw(state);
      return;
    }
    if (!state.rows.some((r) => r.id === id)) return;
    let until;
    try {
      if (action === "date") state.pickerDate = date;
      if (!["accepted", "rejected"].includes(action)) until = snoozeUntil(action, now(), date);
    } catch (error) {
      state.error = error.message;
      draw(state);
      return;
    }
    state.busy = id;
    draw(state);
    try {
      await api.change(id, until ? "snoozed" : action, until);
      state.rows = state.rows.filter((row) => row.id !== id);
      state.picker = "";
      state.notice = until
        ? "Snoozed. It will return when it's time to review it."
        : action === "accepted"
          ? "Commitment accepted."
          : "Commitment rejected.";
    } catch {
      state.error =
        "That change couldn't be saved. The suggestion is still here. Try the action again.";
    }
    state.busy = "";
    draw(state);
  }
  return { state, load, act };
}

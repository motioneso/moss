/** One in-memory draft. Saves are serialized; reads never replace typing that happened in flight. */
export function padModel(api, changed = () => {}) {
  const state = {
    text: "",
    saved: "",
    revision: 0,
    loaded: false,
    status: "Loading",
    conflict: false,
    notice: "",
    appendedFrom: 0,
    error: "",
    shortcut: "mod+shift+s"
  };
  let saving = null;
  let reading = false;
  let timer;
  let generation = 0;
  const emit = () => changed({ ...state });
  const dirty = () => state.text !== state.saved;
  async function read(reload = false) {
    if (reading || saving || (state.conflict && !reload)) return;
    reading = true;
    const before = generation;
    const revision = state.revision;
    try {
      const note = await api.read();
      if (saving || revision !== state.revision) return;
      state.shortcut = note.shortcut;
      if (reload && before !== generation) return;
      if (state.error === "Couldn't check for changes. Your text is kept here.") state.error = "";
      if (!state.loaded || reload) {
        state.text = state.saved = note.body;
        state.revision = note.revision;
        state.loaded = true;
        state.conflict = false;
        state.status = "Saved";
        state.error = "";
        generation++;
      } else if (note.revision !== state.revision) {
        if (dirty() || before !== generation) {
          state.conflict = true;
          state.status = "Not saved";
          clearTimeout(timer);
        } else {
          state.notice =
            note.body.startsWith(state.saved + "\n") || (!state.saved && note.body)
              ? "Added to your scratchpad"
              : "";
          state.appendedFrom = state.saved ? state.saved.length + 1 : 0;
          state.text = state.saved = note.body;
          state.revision = note.revision;
          state.status = "Saved";
          state.error = "";
          generation++;
        }
      }
    } catch {
      state.error = state.loaded
        ? "Couldn't check for changes. Your text is kept here."
        : "Couldn't load your scratchpad.";
      if (!state.loaded) state.status = "Unavailable";
    } finally {
      reading = false;
      emit();
    }
  }
  async function save() {
    clearTimeout(timer);
    if (saving) {
      await saving;
      if (dirty() && !state.conflict && !state.error) return save();
      return;
    }
    if (!state.loaded || state.conflict || !dirty()) return;
    const text = state.text;
    if (text.length > 64000) {
      state.status = "Not saved";
      state.error = "Your pad is full. Remove some text and try again.";
      emit();
      return;
    }
    state.status = "Saving";
    state.error = "";
    emit();
    saving = (async () => {
      try {
        const result = await api.save(text, state.revision);
        state.saved = text;
        state.revision = result.revision;
        state.status = dirty() ? "Saving" : "Saved";
      } catch (error) {
        if (error.status === 409) {
          state.conflict = true;
          state.status = "Not saved";
        } else {
          state.status = "Not saved";
          state.error =
            error.status === 413
              ? "Your pad is full. Remove some text and try again."
              : "Couldn't save. Your text is kept here. Try again.";
        }
      }
    })();
    await saving;
    saving = null;
    emit();
    if (dirty() && !state.conflict && !state.error) return save();
  }
  return {
    state,
    read,
    save,
    edit(text) {
      if (!state.loaded) return;
      generation++;
      state.text = text;
      state.notice = "";
      if (!state.conflict) {
        state.status = "Saving";
        state.error = "";
        clearTimeout(timer);
        timer = setTimeout(save, 800);
      }
      emit();
    },
    reload: () => read(true),
    dispose() {
      clearTimeout(timer);
    },
    dirty,
    dismissNotice() {
      state.notice = "";
      emit();
    }
  };
}

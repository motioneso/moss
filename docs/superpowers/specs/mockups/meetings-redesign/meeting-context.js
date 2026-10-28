/* global document, Option */
// Per-screen fictional fixtures only. Sensitive source text lives on the unlocked screen.
(() => {
  const one = (selector, root = document) => root.querySelector(selector);
  const all = (selector, root = document) => [...root.querySelectorAll(selector)];
  const chips = one(".attendee-chips");
  if (!chips) return;
  const people = new Map(
    all("[data-attendee]").map((chip) => [
      chip.dataset.attendee,
      {
        name: chip.dataset.name,
        person: chip.dataset.person,
        self: chip.hasAttribute("data-self")
      }
    ])
  );
  const voices = new Map(
    all("[data-voice-map]").map((select) => [select.dataset.voiceMap, select.value])
  );
  let nextPerson = 1;
  let nextVoice = 4;
  const attendeeDialog = one("#attendee-dialog");
  const lineDialog = one("#line-dialog");
  const sourceDialog = one("#source-dialog");
  let editingId;
  let correctingEntry;
  let attendeeOpener;
  let lineOpener;
  let sourceOpener;
  const personName = (id) => {
    const person = people.get(id);
    return person ? person.name + (person.self ? " (You)" : "") : "";
  };
  const voiceName = (id) => (id === "you" ? "Speaker 3" : `Speaker ${id.replace("voice", "")}`);
  function attendeeOptions(select, selected) {
    select.replaceChildren(new Option("Unassigned", ""));
    for (const [id] of people) select.add(new Option(personName(id), id));
    select.value = selected || "";
  }
  function relabel() {
    all(".transcript-entry").forEach((entry) => {
      const attendee = entry.hasAttribute("data-line-attendee")
        ? entry.dataset.lineAttendee
        : voices.get(entry.dataset.voice);
      one(".speaker-copy strong", entry).textContent =
        personName(attendee) || voiceName(entry.dataset.voice);
    });
  }
  function renderPeople() {
    chips.replaceChildren();
    for (const [id, person] of people) {
      const chip = document.createElement("button");
      chip.className = "jds-btn jds-btn--secondary attendee-chip";
      chip.dataset.attendee = id;
      chip.textContent = personName(id);
      chip.setAttribute("aria-label", `Edit attendee ${person.name}`);
      chips.append(chip);
    }
    all("[data-voice-map]").forEach((select) =>
      attendeeOptions(select, voices.get(select.dataset.voiceMap))
    );
    relabel();
  }
  function openAttendee(id, opener) {
    editingId = id;
    attendeeOpener = opener;
    const person = people.get(id);
    one("#attendee-title").textContent = person ? "Edit attendee" : "Add attendee";
    one("#attendee-person").value = person?.person || "custom";
    one("#attendee-name").value = person?.name || "";
    one("#attendee-name").setCustomValidity("");
    one("[data-remove-attendee]").hidden = !person;
    attendeeDialog.returnValue = "";
    attendeeDialog.showModal();
    one("#attendee-name").focus();
  }
  chips.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-attendee]");
    if (chip) openAttendee(chip.dataset.attendee, chip);
  });
  one("[data-add-attendee]").addEventListener("click", (event) =>
    openAttendee(null, event.currentTarget)
  );
  one("#attendee-person").addEventListener("change", (event) => {
    const select = event.currentTarget;
    one("#attendee-name").value =
      select.value === "custom" ? "" : select.selectedOptions[0].textContent;
    one("#attendee-name").setCustomValidity("");
    one("#attendee-name").focus();
  });
  one("#attendee-name").addEventListener("input", (event) => {
    event.currentTarget.setCustomValidity(event.currentTarget.value.trim() ? "" : "Enter a name.");
  });
  attendeeDialog.addEventListener("close", () => {
    const action = attendeeDialog.returnValue;
    let focusId = editingId;
    if (action === "save") {
      const old = people.get(editingId);
      focusId = editingId || `added-${nextPerson++}`;
      const person = one("#attendee-person").value;
      people.set(focusId, {
        name: one("#attendee-name").value.trim(),
        person,
        self: person === "you" && (!old || old.self || person !== old.person)
      });
    } else if (action === "remove") {
      people.delete(editingId);
      for (const [voice, attendee] of voices) if (attendee === editingId) voices.set(voice, "");
      all("[data-line-attendee]").forEach((entry) => {
        if (entry.dataset.lineAttendee === editingId) entry.dataset.lineAttendee = "";
      });
    }
    if (action === "save" || action === "remove") renderPeople();
    (
      one(`[data-attendee="${focusId}"]`) ||
      (attendeeOpener?.isConnected && attendeeOpener) ||
      one("[data-add-attendee]")
    ).focus();
  });
  one(".voice-list").addEventListener("change", (event) => {
    const select = event.target.closest("[data-voice-map]");
    if (!select) return;
    voices.set(select.dataset.voiceMap, select.value);
    const suggestion = one(`[data-voice-suggestion="${select.dataset.voiceMap}"]`);
    if (suggestion && select.value) suggestion.hidden = true;
    relabel();
  });
  all("[data-accept-suggestion]").forEach((button) =>
    button.addEventListener("click", () => {
      const suggestedPerson = button.dataset.suggestedAttendee;
      let attendee = [...people].find(([, person]) => person.person === suggestedPerson)?.[0];
      if (!attendee) {
        attendee = `added-${nextPerson++}`;
        const option = one(`#attendee-person option[value="${suggestedPerson}"]`);
        people.set(attendee, { name: option.textContent, person: suggestedPerson, self: false });
        renderPeople();
      }
      voices.set(button.dataset.acceptSuggestion, attendee);
      one(`[data-voice-map="${button.dataset.acceptSuggestion}"]`).value = attendee;
      const suggestion = button.closest("[data-suggestion]");
      suggestion.hidden = true;
      one(`[data-voice-map="${button.dataset.acceptSuggestion}"]`).focus();
      relabel();
    })
  );
  all("[data-dismiss-suggestion]").forEach((button) =>
    button.addEventListener("click", () => {
      const suggestion = button.closest("[data-suggestion]");
      suggestion.hidden = true;
      one(`[data-voice-map="${suggestion.dataset.voiceSuggestion}"]`).focus();
    })
  );
  one(".transcript-lines").addEventListener("click", (event) => {
    const button = event.target.closest("[data-correct-line]");
    if (!button) return;
    lineOpener = button;
    correctingEntry = button.closest(".transcript-entry");
    const text = one(".speaker-copy > span", correctingEntry)
      .textContent.trim()
      .replace(/\s+/g, " ");
    one("[data-line-preview]").textContent = text;
    one("#line-action").value = "reassign";
    one(".split-fields").hidden = true;
    one('label[for="line-attendee"]').textContent = "Speaker";
    const current = correctingEntry.hasAttribute("data-line-attendee")
      ? correctingEntry.dataset.lineAttendee
      : voices.get(correctingEntry.dataset.voice);
    attendeeOptions(one("#line-attendee"), current);
    const split = one("#split-at");
    split.replaceChildren();
    for (const match of text.matchAll(/\s+(?=\S)/g)) {
      const position = match.index + match[0].length;
      split.add(new Option(text.slice(position), String(position)));
    }
    const sentence = text.search(/[.!?]\s/);
    if (sentence >= 0) split.value = String(sentence + 2);
    one('#line-action option[value="split"]').disabled = !split.options.length;
    lineDialog.returnValue = "";
    lineDialog.showModal();
    one("#line-action").focus();
  });
  one("#line-action").addEventListener("change", (event) => {
    const split = event.currentTarget.value === "split";
    one(".split-fields").hidden = !split;
    one('label[for="line-attendee"]').textContent = split ? "Second speaker" : "Speaker";
  });
  function assignLine(entry, attendee) {
    entry.dataset.lineAttendee = attendee;
    // A corrected unassigned segment gets its own voice, independent of the original.
    if (!attendee) {
      const id = `voice${nextVoice++}`;
      entry.dataset.voice = id;
      voices.set(id, "");
      const row = document.createElement("div");
      row.className = "voice-row";
      const label = document.createElement("label");
      label.htmlFor = `map-${id}`;
      label.textContent = voiceName(id);
      const select = document.createElement("select");
      select.className = "jds-select";
      select.id = label.htmlFor;
      select.dataset.voiceMap = id;
      attendeeOptions(select, "");
      row.append(label, select);
      one(".voice-list").append(row);
      // Future voice assignments must also relabel this segment.
      delete entry.dataset.lineAttendee;
    }
  }
  lineDialog.addEventListener("close", () => {
    if (lineDialog.returnValue === "apply") {
      const attendee = one("#line-attendee").value;
      if (one("#line-action").value === "split") {
        const text = one("[data-line-preview]").textContent;
        const boundary = Number(one("#split-at").value);
        const second = correctingEntry.cloneNode(true);
        one(".speaker-copy > span", correctingEntry).textContent = text.slice(0, boundary).trim();
        one(".speaker-copy > span", second).textContent = text.slice(boundary).trim();
        assignLine(second, attendee);
        correctingEntry.after(second);
      } else assignLine(correctingEntry, attendee);
      relabel();
    }
    lineOpener.focus();
  });
  document.addEventListener("click", (event) => {
    const link = event.target.closest("[data-source]");
    if (!link) return;
    const source = document.getElementById(link.dataset.source);
    if (!source) return;
    event.preventDefault();
    sourceOpener = link;
    one("[data-source-content]").replaceChildren(source.content.cloneNode(true));
    sourceDialog.setAttribute("aria-label", one("h2", source.content).textContent);
    sourceDialog.returnValue = "";
    sourceDialog.showModal();
  });
  sourceDialog.addEventListener("close", () => sourceOpener?.focus());
  renderPeople();
  if (one('[data-attendee-state="editing"]')) openAttendee("alex", one('[data-attendee="alex"]'));
})();

// Evening conversation study. Fixed sample choices, no model, network, or persisted writes.
const planningDialog = document.createElement("dialog");
planningDialog.id = "evening-planning";
planningDialog.setAttribute("aria-labelledby", "planning-title");
document.body.append(planningDialog);
const phaseLabels = ["Reflect", "Open commitments", "Shape tomorrow", "Review"];
let eveningDraft = null;
let savedEveningPlan = null;
let planningPhase = 0;
let planningScenario = "ready";
let planningError = false;

function safeText(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}
function minuteLabel(minutes) {
  const hour = Math.floor(minutes / 60);
  return `${hour % 12 || 12}:${String(minutes % 60).padStart(2, "0")}${hour >= 12 ? "pm" : "am"}`;
}
function initialBikeChoice() {
  return loopDecision === "Moved to tomorrow."
    ? "tomorrow"
    : loopDecision
      ? "existing"
      : "undecided";
}
function openEveningPlan() {
  if (!eveningDraft) {
    eveningDraft = {
      correction: false,
      reflection: "",
      bike: initialBikeChoice(),
      bikeDate: "2026-09-11",
      originalBike: loopDecision,
      pace: "steady",
      focus: "timeline",
      start: "13:00",
      include: { timeline: true, followup: true, bike: true },
      notes: [],
      composer: "",
      placement: scheduling
    };
  } else if (eveningDraft.originalBike !== loopDecision && !savedEveningPlan) {
    eveningDraft.bike = initialBikeChoice();
    eveningDraft.originalBike = loopDecision;
  }
  eveningDraft.placement = scheduling;
  if (savedEveningPlan && planningPhase >= 4) planningPhase = 4;
  drawEveningPlan();
  planningDialog.showModal();
}
function possibleBlocks(plan) {
  const tasks = [
    {
      id: "timeline",
      title: "Send the revised timeline",
      duration: 45,
      why: "From your commitment in the review"
    }
  ];
  if (plan.correction)
    tasks.push({
      id: "followup",
      title: "Send the review follow-up",
      duration: 30,
      why: "You clarified it is still open"
    });
  if (plan.bike === "tomorrow")
    tasks.push({
      id: "bike",
      title: "Book the bike service",
      duration: 15,
      why: "Carried forward from today"
    });
  return tasks.sort((a, b) => Number(b.id === plan.focus) - Number(a.id === plan.focus));
}
function plannedBlocks(plan) {
  let cursor = Number(plan.start.slice(0, 2)) * 60 + Number(plan.start.slice(3));
  return possibleBlocks(plan)
    .filter((task) => plan.include[task.id])
    .map((task) => {
      const block = { ...task, start: cursor, end: cursor + task.duration };
      cursor = block.end + 15;
      return block;
    });
}
function existingCalendarBlocks(plan) {
  return !plan
    ? []
    : plan.placement === "automatic"
      ? plannedBlocks(plan)
      : plan.existingBlocks || [];
}
function changesFromSavedPlan() {
  if (!savedEveningPlan) return "";
  const before = existingCalendarBlocks(savedEveningPlan);
  const after = plannedBlocks(eveningDraft);
  const changes = before.flatMap((block) => {
    const next = after.find((item) => item.id === block.id);
    if (!next)
      return [`Remove the ${minuteLabel(block.start)} block for “${block.title}”. Keep the task.`];
    return next.start !== block.start
      ? [`Move “${block.title}” from ${minuteLabel(block.start)} to ${minuteLabel(next.start)}.`]
      : [];
  });
  for (const block of after)
    if (!before.some((item) => item.id === block.id))
      changes.push(`Add “${block.title}” at ${minuteLabel(block.start)}.`);
  return `<div class="review-notes"><h4>${eveningDraft.placement === "automatic" ? "Changes to existing Moss blocks" : "Proposed calendar changes"}</h4>${changes.length ? changes.map((change) => `<p>${safeText(change)}</p>`).join("") : "<p>No task-block times change.</p>"}${eveningDraft.placement === "proposed" && before.length ? "<p>Existing blocks stay on the calendar until changes are accepted.</p>" : ""}</div>`;
}
function fixedAppointment() {
  return planningScenario === "calendar" ? { start: 780, end: 825 } : { start: 600, end: 645 };
}
function planConflicts() {
  const appointment = fixedAppointment();
  return plannedBlocks(eveningDraft).some(
    (block) => block.start < appointment.end + 30 && block.end > appointment.start - 30
  );
}
function snapshot(plan, saved = false) {
  const appointment = saved && plan.appointment ? plan.appointment : fixedAppointment();
  const blocks = plannedBlocks(plan);
  const existing =
    plan.placement === "proposed" ? existingCalendarBlocks(saved ? plan : savedEveningPlan) : [];
  const state = saved
    ? plan.placement === "automatic"
      ? "Scheduled by Moss"
      : "Proposed · not on calendar"
    : "Proposed";
  return `<div class="planning-snapshot"><div class="snapshot-heading"><span class="eyebrow">THURSDAY, SEPTEMBER 10</span><h3>Tomorrow, taking shape.</h3></div>
    <p class="snapshot-intent">${plan.pace === "light" ? "A lighter day, with space to recover." : "A clear morning and a focused afternoon."}</p>
    <div class="snapshot-entry fixed-entry"><span>${minuteLabel(appointment.start - 30)}</span><div>Travel to your appointment<small>30 minutes · Calendar buffer</small></div></div>
    <div class="snapshot-entry fixed-entry"><span>${minuteLabel(appointment.start)}</span><div>Dental appointment<small>45 minutes · Confirmed</small></div></div>
    <p class="snapshot-gap">Room to get home and have lunch.</p>
    ${blocks.map((block) => `<div class="snapshot-entry draft-entry"><span>${minuteLabel(block.start)}</span><div>${block.title}<small>${block.duration} minutes · ${state}</small></div></div>`).join("")}
    ${blocks.length ? '<p class="snapshot-gap">15 minutes between task blocks.</p>' : `<p class="snapshot-gap">No task blocks selected.${existing.length ? " Existing calendar blocks remain." : " The afternoon stays open."}</p>`}
    <div class="snapshot-bottom"><strong>${blocks.reduce((sum, block) => sum + block.duration, 0)} minutes of ${plan.placement === "proposed" ? "proposed " : ""}task time</strong><span>${existing.length ? "The proposed shape. Existing blocks remain until accepted." : "The rest stays open."}</span></div>${existing.length ? `<details class="existing-plan"><summary>Existing calendar task blocks</summary>${existing.map((block) => `<p>${minuteLabel(block.start)} · ${block.title}</p>`).join("")}</details>` : ""}</div>`;
}
function choice(value, title, description, selected, group) {
  return `<button class="planning-choice" data-${group}="${value}" aria-pressed="${selected}"><strong>${title}</strong><span>${description}</span></button>`;
}
function reflectionPanel() {
  return `<div class="moss-speaker"><span class="moss-initial">M</span><span>Moss <small>Looking back with you</small></span></div>
    <h3>You made room for the important work.</h3>
    <p>${planningScenario === "no-review" ? "Your evening briefing isn’t available. We can still work from your calendar and open tasks, with your account of how today went." : "The proposal is sent and the team agreed a direction in the review. You left space for the trip into town, too. The bike service is still open."}</p>
    <p class="planning-question">What should I understand about today before we plan tomorrow?</p>
    <div class="planning-choices">${choice("clear", "That captures it", "I’m ready to look ahead.", eveningDraft.reflection === "clear", "reflection")}${choice("correction", "The follow-up isn’t sent", "I still need to send the message.", eveningDraft.correction, "reflection")}${choice("tired", "It took more out of me than expected", "Make some room in tomorrow’s plan.", eveningDraft.reflection === "tired", "reflection")}</div>
    ${eveningDraft.correction ? '<div class="planning-response"><strong>Thanks for the correction.</strong> The review happened; its follow-up is still open. I’ll carry that distinction into tomorrow’s plan.</div>' : eveningDraft.reflection === "tired" ? '<div class="planning-response">Then tomorrow should ask less of you. I’ve suggested a lighter day; you can adjust that next.</div>' : eveningDraft.reflection === "clear" ? '<div class="planning-response">Let’s leave today accounted for and look at the one open commitment.</div>' : ""}`;
}
function commitmentsPanel() {
  return `<div class="moss-speaker"><span class="moss-initial">M</span><span>Moss <small>Only the loose ends that matter</small></span></div>
    <h3>Give this a place, or leave it open.</h3><p>The bike service has no deadline. It can fit tomorrow afternoon, but it doesn’t have to.</p>
    <article class="planning-task"><span class="eyebrow">PERSONAL / OPEN TASK</span><h4>Book the bike service</h4><p>It was on today’s list without a time block.</p></article>
    ${eveningDraft.originalBike ? `<p class="already-decided">From your evening review: ${safeText(eveningDraft.originalBike)} No need to decide it again.</p>` : ""}
    <div class="planning-choices two-up">${choice("tomorrow", "Tomorrow", "Suggest a 15-minute block.", eveningDraft.bike === "tomorrow", "bike")}${choice("date", "Another day", "Choose a day that fits better.", eveningDraft.bike === "date", "bike")}${choice("list", "Keep it on my list", "Leave it unscheduled. Nothing deleted.", eveningDraft.bike === "list", "bike")}${choice("undecided", "Leave this for now", "Keep today’s task exactly as it is.", eveningDraft.bike === "undecided", "bike")}</div>
    ${eveningDraft.bike === "date" ? `<label class="planning-field">Day for the bike service<input id="planning-bike-date" type="date" min="2026-09-10" value="${safeText(eveningDraft.bikeDate)}" required></label>` : ""}
    ${eveningDraft.correction ? '<div class="planning-response"><strong>Also carrying forward</strong>The review follow-up is still open. It’s available as a priority for tomorrow.</div>' : ""}
    <p class="planning-muted">Alex’s response to the proposal is still with Alex. No task for you tonight.</p>`;
}
function tomorrowPanel() {
  return `<div class="moss-speaker"><span class="moss-initial">M</span><span>Moss <small>A realistic starting point</small></span></div>
    <h3>How much room do you want tomorrow?</h3><p>The appointment takes the middle of the morning. I’d keep the time around it open and put your main task after lunch.</p>
    <div class="planning-choices two-up">${choice("steady", "A steady day", "The main task, with room for follow-through.", eveningDraft.pace === "steady", "pace")}${choice("light", "A lighter day", "One work block. Leave the rest available.", eveningDraft.pace === "light", "pace")}</div>
    <label class="planning-field">The one thing that matters<select id="planning-focus"><option value="timeline" ${eveningDraft.focus === "timeline" ? "selected" : ""}>Send the revised timeline</option>${eveningDraft.correction ? `<option value="followup" ${eveningDraft.focus === "followup" ? "selected" : ""}>Send the review follow-up</option>` : ""}</select></label>
    <label class="planning-field">Start task time at<select id="planning-start">${["09:45", "13:00", "14:00", "14:30", "15:00"].map((value) => `<option value="${value}" ${eveningDraft.start === value ? "selected" : ""}>${minuteLabel(Number(value.slice(0, 2)) * 60 + Number(value.slice(3)))}</option>`).join("")}</select></label>
    <div class="planning-response">${eveningDraft.pace === "light" ? "The plan now keeps only your chosen priority in a block. Other tasks stay open; they aren’t deleted or marked complete." : "I’ve left a short buffer between task blocks. Existing appointments and travel stay protected."}</div>`;
}
function reviewPanel() {
  const blocks = plannedBlocks(eveningDraft);
  return `<div class="moss-speaker"><span class="moss-initial">M</span><span>Moss <small>Here’s what will change</small></span></div>
    <h3>A plan you can leave with.</h3><p>${eveningDraft.placement === "automatic" ? "Your settings allow Moss to place its task blocks. Saving this plan schedules the selected blocks." : "Your settings keep task blocks as proposals. Saving carries these suggestions into the morning without adding them to your calendar."}</p>
    <div class="review-record"><span>Keep as they are</span><strong>The appointment and its travel buffers</strong></div>
    ${eveningDraft.correction ? '<div class="review-record"><span>Your correction</span><strong>The review follow-up is still open</strong></div>' : ""}
    <fieldset class="review-actions"><legend>${eveningDraft.placement === "automatic" ? "Task blocks to schedule" : "Task blocks to propose"}</legend>${possibleBlocks(
      eveningDraft
    )
      .map(
        (task) =>
          `<label><input type="checkbox" data-include="${task.id}" ${eveningDraft.include[task.id] ? "checked" : ""}><span><strong>${task.title}</strong><small>${task.duration} minutes · ${task.why}</small></span></label>`
      )
      .join("")}</fieldset>
    ${eveningDraft.bike === "date" ? `<div class="review-record"><span>Move to another day</span><strong>Bike service · ${safeText(eveningDraft.bikeDate)}</strong></div>` : eveningDraft.bike === "list" ? '<div class="review-record"><span>Leave unscheduled</span><strong>Bike service stays on your task list</strong></div>' : eveningDraft.bike === "undecided" ? '<div class="review-record"><span>No change</span><strong>Bike service is still undecided</strong></div>' : ""}
    ${changesFromSavedPlan()}
    ${eveningDraft.notes.length ? `<div class="review-notes saved-notes"><h4>What you want Moss to remember</h4>${eveningDraft.notes.map((note) => `<p>${safeText(note)}</p>`).join("")}</div>` : ""}
    ${eveningDraft.pace === "light" && blocks.length > 1 ? '<div class="planning-warning">You chose a lighter day, but selected more than one task block. You can keep them or remove the extras.</div>' : ""}
    <p class="planning-muted">Only selected blocks are included. Unselected tasks remain on your list.</p>`;
}
function finishedPanel() {
  const plan = savedEveningPlan;
  return `<div class="finish-mark" aria-hidden="true">✓</div><h3>Tomorrow is ready to meet you.</h3>
    <p>${plan.pace === "light" ? "A lighter day is the plan." : "You have a clear priority and space around it."} ${plan.placement === "automatic" ? "Your selected task blocks are scheduled." : "Your task blocks are saved as proposals. Your calendar is unchanged."}</p>
    <div class="planning-response"><strong>Morning starts from here.</strong>Moss will check overnight changes against tonight’s intentions and explain anything that needs adjusting. It won’t ask you to plan the day from scratch.</div>
    <button class="planning-link" data-planning-action="handoff">Preview the morning handoff ↗</button><button class="planning-link" data-planning-action="edit">Adjust this plan</button>`;
}
function handoffPanel() {
  const plan = savedEveningPlan;
  const first = plannedBlocks(plan)[0];
  const existing = plan.placement === "proposed" && existingCalendarBlocks(plan).length;
  return `<span class="eyebrow">THURSDAY, SEPTEMBER 10 / MORNING</span><h3>You already gave today a direction.</h3><p>${first ? `You chose ${safeText(first.title.toLowerCase())} as the place to start. ${plan.pace === "light" ? "You asked to keep the rest of the day deliberately light." : "You allowed room to follow through in the afternoon."}` : existing ? "You proposed leaving task time open. Existing calendar task blocks remain until you accept their removal." : "You left the task list unscheduled. Your appointment is the only fixed commitment."}</p>
    <div class="review-record"><span>Carried from last night</span><strong>${plan.pace === "light" ? "Keep the day light" : "Protect time for the main priority"}</strong><small>${existing ? "Proposed changes await acceptance. Existing calendar blocks remain." : first ? (plan.placement === "automatic" ? "Task blocks are scheduled." : "Task blocks still await your acceptance.") : "No task blocks were added."}</small></div>
    <div class="morning-development"><span class="eyebrow">NEW THIS MORNING / SAMPLE UPDATE</span><h4>Alex sent the missing figures.</h4><p>They arrived at 6:25 and are ready with the timeline task. They don’t change your appointment or require more time in the plan.</p></div>
    `;
}
function drawEveningPlan(focusHeading = false) {
  const active = document.activeElement;
  const focusKey = ["data-reflection", "data-bike", "data-pace", "data-planning-action"].find(
    (key) => active?.hasAttribute(key)
  );
  const focusValue = focusKey ? active.getAttribute(focusKey) : "";
  const mobileOpen = planningDialog.querySelector(".planning-mobile-plan")?.open;
  const finished = planningPhase >= 4;
  const conflict = !finished && planConflicts();
  const body = [
    reflectionPanel,
    commitmentsPanel,
    tomorrowPanel,
    reviewPanel,
    finishedPanel,
    handoffPanel
  ][planningPhase]();
  planningDialog.innerHTML = `<header class="planning-header"><div><span class="eyebrow">MOSS / EVENING PLANNING</span><h2 id="planning-title">A good place to leave the day.</h2></div><button data-planning-action="close" aria-label="Close evening planning">✕</button></header>
    ${finished ? '<div class="planning-progress completed-progress">Evening plan saved <span>Thursday, September 10</span></div>' : `<nav class="planning-progress" aria-label="Planning agenda">${phaseLabels.map((label, i) => `<button data-phase="${i}" aria-current="${i === planningPhase ? "step" : "false"}"><span>0${i + 1}</span>${label}</button>`).join("")}</nav>`}
    <div class="planning-scroll"><details class="planning-mobile-plan" ${mobileOpen ? "open" : ""}><summary>Tomorrow’s plan · ${plannedBlocks(finished ? savedEveningPlan : eveningDraft).length} ${plannedBlocks(finished ? savedEveningPlan : eveningDraft).length === 1 ? "task block" : "task blocks"}</summary>${snapshot(finished ? savedEveningPlan : eveningDraft, finished)}</details><div class="planning-layout"><section class="planning-conversation" tabindex="-1">${body}
    ${!finished ? `<div class="planning-note-composer"><form id="planning-note-form"><label for="planning-note">Or tell Moss in your own words</label><div><textarea id="planning-note" name="note" rows="2" maxlength="500" placeholder="A correction, a constraint, or something to remember…" required>${safeText(eveningDraft.composer)}</textarea><button type="submit" class="solid">Add note</button></div></form>${eveningDraft.notes.length ? `<p role="status">${eveningDraft.notes.length} ${eveningDraft.notes.length === 1 ? "note" : "notes"} will travel with the plan.</p>` : ""}</div>` : ""}
    </section><aside class="planning-side" aria-label="Tomorrow’s plan preview">${snapshot(finished ? savedEveningPlan : eveningDraft, finished)}${!finished ? `<div class="placement-note"><strong>${eveningDraft.placement === "automatic" ? "Automatic scheduling is on" : "Propose before scheduling"}</strong><p>${eveningDraft.placement === "automatic" ? "Selected task blocks will be placed when you save." : "Selected blocks stay as suggestions until accepted."}</p></div>` : ""}</aside></div></div>
    ${conflict ? '<div class="planning-warning conflict-warning" role="alert"><strong>The task plan overlaps your appointment or travel.</strong><span>The appointment stays put. Move task time to 2:30pm to make room.</span><button data-planning-action="resolve-conflict">Move task time to 2:30pm</button></div>' : ""}
    ${planningError ? '<div class="planning-warning save-warning" role="alert"><strong>The plan couldn’t be saved.</strong><span>No changes were made. Your choices are ready to retry.</span><button data-planning-action="retry">Retry save</button></div>' : ""}
    <footer class="planning-footer"><button class="planning-leave" data-planning-action="close">${finished ? "Back to Today" : "Leave for now"}</button>${!finished ? `<button class="solid" data-planning-action="${planningPhase === 3 ? "save" : "next"}" ${planningPhase === 3 && conflict ? "disabled" : ""}>${planningPhase === 3 ? (eveningDraft.placement === "automatic" ? "Save tomorrow’s plan" : "Save proposed plan") : ["Open commitments →", "Shape tomorrow →", "Review the plan →"][planningPhase]}</button>` : ""}</footer>
    <div class="planning-demo"><span>Interaction study · Suggested replies change the sample plan; free text is kept as notes.</span><label>Preview state<select id="planning-scenario"><option value="ready">Ready</option><option value="no-review">Briefing unavailable</option><option value="calendar">Appointment moved</option><option value="save-error">Save fails</option></select></label></div>`;
  planningDialog.querySelector("#planning-scenario").value = planningScenario;
  if (focusHeading) {
    planningDialog.querySelector(".planning-conversation").focus({ preventScroll: true });
    planningDialog.querySelector(".planning-scroll").scrollTop = 0;
  } else if (focusKey) {
    planningDialog
      .querySelector(`[${focusKey}="${CSS.escape(focusValue)}"]`)
      ?.focus({ preventScroll: true });
  }
}
function setPace(pace) {
  eveningDraft.pace = pace;
  eveningDraft.include.timeline = pace === "steady" || eveningDraft.focus === "timeline";
  eveningDraft.include.followup = pace === "steady" || eveningDraft.focus === "followup";
  eveningDraft.include.bike = pace === "steady";
}
function saveEveningPlan() {
  if (eveningDraft.placement !== scheduling) {
    eveningDraft.placement = scheduling;
    planningPhase = 3;
    drawEveningPlan(true);
    return;
  }
  if (planConflicts()) return;
  if (
    eveningDraft.bike === "date" &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(eveningDraft.bikeDate) || eveningDraft.bikeDate < "2026-09-10")
  ) {
    planningPhase = 1;
    drawEveningPlan(true);
    planningDialog.querySelector("#planning-bike-date").reportValidity();
    return;
  }
  if (planningScenario === "save-error") {
    planningError = true;
    drawEveningPlan();
    return;
  }
  if (eveningDraft.composer.trim()) {
    eveningDraft.notes.push(eveningDraft.composer.trim());
    eveningDraft.composer = "";
  }
  const existingBlocks = existingCalendarBlocks(savedEveningPlan);
  savedEveningPlan = structuredClone(eveningDraft);
  savedEveningPlan.existingBlocks = existingBlocks;
  savedEveningPlan.appointment = fixedAppointment();
  tomorrowSaved = true;
  if (eveningDraft.bike === "tomorrow" && eveningDraft.include.bike)
    loopDecision = "Moved to tomorrow.";
  if (eveningDraft.bike === "date") loopDecision = `Moved to ${eveningDraft.bikeDate}.`;
  if (eveningDraft.bike === "list") loopDecision = "Kept on your list, without a time block.";
  eveningDraft.originalBike = loopDecision;
  planningError = false;
  planningPhase = 4;
  render();
  drawEveningPlan(true);
}
function refreshEveningSummary() {
  const entry = document.querySelector('[data-action="prepare"]');
  if (!entry) return;
  if (!savedEveningPlan) {
    if (eveningDraft) entry.textContent = "Continue preparing tomorrow ↗";
    return;
  }
  const side = document.querySelector(".evening-support .support-section");
  side.innerHTML =
    snapshot(savedEveningPlan, true) +
    '<button class="solid" data-action="prepare">Review tomorrow’s plan ↗</button>';
  if (savedEveningPlan.correction) {
    const recap = document.querySelectorAll(".done-item p")[1];
    if (recap)
      recap.textContent = "The scope is agreed. You clarified that the follow-up is still open.";
    const summary = document.querySelector(".masthead-summary");
    if (summary)
      summary.textContent =
        "The proposal is sent and the review gave the team a direction. You clarified that the follow-up still needs to go out; it is accounted for in tomorrow’s plan.";
  }
}
function closeEveningPlan() {
  planningDialog.close();
  refreshEveningSummary();
  document.querySelector('[data-action="prepare"]')?.focus({ preventScroll: true });
}
planningDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeEveningPlan();
});
planningDialog.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.phase !== undefined) {
    planningPhase = Number(button.dataset.phase);
    drawEveningPlan(true);
    return;
  }
  if (button.dataset.reflection) {
    eveningDraft.reflection = button.dataset.reflection;
    if (button.dataset.reflection === "correction")
      eveningDraft.correction = !eveningDraft.correction;
    if (button.dataset.reflection === "tired") setPace("light");
    if (!eveningDraft.correction && eveningDraft.focus === "followup")
      eveningDraft.focus = "timeline";
    drawEveningPlan();
    return;
  }
  if (button.dataset.bike) {
    eveningDraft.bike = button.dataset.bike;
    drawEveningPlan();
    return;
  }
  if (button.dataset.pace) {
    setPace(button.dataset.pace);
    drawEveningPlan();
    return;
  }
  switch (button.dataset.planningAction) {
    case "next":
      planningPhase = Math.min(planningPhase + 1, 3);
      drawEveningPlan(true);
      break;
    case "close":
      closeEveningPlan();
      break;
    case "save":
      saveEveningPlan();
      break;
    case "retry":
      planningScenario = "ready";
      planningError = false;
      saveEveningPlan();
      break;
    case "resolve-conflict":
      eveningDraft.start = "14:30";
      drawEveningPlan();
      break;
    case "handoff":
      planningPhase = 5;
      drawEveningPlan(true);
      break;
    case "edit":
      eveningDraft = structuredClone(savedEveningPlan);
      eveningDraft.placement = scheduling;
      planningPhase = 2;
      drawEveningPlan(true);
      break;
  }
});
planningDialog.addEventListener("change", (event) => {
  const input = event.target;
  if (
    !["planning-bike-date", "planning-focus", "planning-start", "planning-scenario"].includes(
      input.id
    ) &&
    !input.dataset.include
  )
    return;
  if (input.id === "planning-bike-date") {
    eveningDraft.bikeDate = input.value;
    return;
  }
  if (input.id === "planning-focus") {
    eveningDraft.focus = input.value;
    setPace(eveningDraft.pace);
  }
  if (input.id === "planning-start") eveningDraft.start = input.value;
  if (input.id === "planning-scenario") {
    planningScenario = input.value;
    planningError = false;
    if (planningPhase >= 4) planningPhase = 3;
  }
  if (input.dataset.include && Object.hasOwn(eveningDraft.include, input.dataset.include))
    eveningDraft.include[input.dataset.include] = input.checked;
  const id = input.id;
  const include = input.dataset.include;
  drawEveningPlan();
  (id
    ? planningDialog.querySelector(`#${id}`)
    : planningDialog.querySelector(`[data-include="${include}"]`)
  )?.focus({ preventScroll: true });
});
planningDialog.addEventListener("submit", (event) => {
  if (event.target.id !== "planning-note-form") return;
  event.preventDefault();
  const value = new FormData(event.target).get("note").trim();
  if (value) {
    eveningDraft.notes.push(value);
    eveningDraft.composer = "";
    drawEveningPlan();
    planningDialog.querySelector("#planning-note").focus();
  }
});
planningDialog.addEventListener("input", (event) => {
  if (event.target.id === "planning-note") eveningDraft.composer = event.target.value;
});
document.addEventListener("moss:render", refreshEveningSummary);
if (query.get("plan") === "open") {
  mode = "evening";
  render();
  openEveningPlan();
}

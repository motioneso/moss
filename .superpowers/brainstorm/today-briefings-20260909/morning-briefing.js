// Standalone morning study. Sample data; no account, model, or calendar writes.
const morningDialog = document.createElement('dialog');
morningDialog.id = 'morning-briefing';
morningDialog.setAttribute('aria-labelledby', 'morning-title');
document.body.append(morningDialog);
let morningSaved = null;
let morningDraft = null;
let morningPage = 'read';
let morningScenario = 'ready';
let morningError = false;
let morningReturn = 'briefing';
let morningPreference = scheduling;
const morningCoverage = { news:query.get('news') !== 'off', sports:query.get('sports') !== 'off' };
const morningTaskIds = [0, 2, 6];
const minutesOf = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const clockValue = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
const morningLabel = status => ({ scheduled:'On calendar', proposed:'Proposed', list:'On your task list' })[status];
function initialMorningTasks() {
  return morningTaskIds.map(id => ({ id, time:schedule[id].time, end:schedule[id].end,
    status:scheduling === 'automatic' || accepted ? 'scheduled' : 'proposed' }));
}
function morningTasks() { return morningSaved || initialMorningTasks(); }
function morningFixed() {
  return schedule.flatMap((slot, id) => slot.type === 'event' ? [{ ...slot, id, status:'fixed' }] : []);
}
function morningRows(tasks) {
  return [...morningFixed(), ...tasks.filter(task => task.status !== 'list').map(task => ({ ...schedule[task.id], ...task }))]
    .sort((a, b) => minutesOf(a.time) - minutesOf(b.time));
}
function morningConflicts() {
  const rows = morningRows(morningDraft || morningTasks());
  return rows.filter((row, i) => rows.some((other, j) => j !== i && minutesOf(row.time) < minutesOf(other.end) && minutesOf(row.end) > minutesOf(other.time)));
}
function morningChanges() {
  const before = morningTasks();
  return morningDraft.flatMap(task => {
    const old = before.find(item => item.id === task.id);
    const title = schedule[task.id].title;
    if (old.status === task.status && (task.status === 'list' || old.time === task.time)) return [];
    if (task.status === 'list') return [`${old.status === 'scheduled' ? 'Remove the calendar block' : 'Remove the proposed block'} for “${title}”. Keep the task.`];
    if (task.status === 'scheduled' && old.status !== 'scheduled') return [`Schedule “${title}” at ${minuteLabel(minutesOf(task.time))}.`];
    if (task.status === 'proposed') return [`Keep “${title}” proposed at ${minuteLabel(minutesOf(task.time))}.`];
    return [`Move “${title}” from ${minuteLabel(minutesOf(old.time))} to ${minuteLabel(minutesOf(task.time))}.`];
  });
}
function openMorningBriefing(page = 'read', origin = 'briefing') {
  morningReturn = origin;
  if (!morningDraft) morningDraft = structuredClone(morningTasks());
  morningPage = page;
  morningError = false;
  drawMorning();
  morningDialog.showModal();
}
function closeMorning() {
  morningDialog.close();
  document.querySelector(`[data-action="${morningReturn}"]`)?.focus({ preventScroll:true });
}
function morningSnapshot(tasks) {
  const reviewing = morningPage === 'review';
  const statusText = row => {
    if (!reviewing || row.type !== 'task') return morningLabel(row.status);
    const original = morningTasks().find(task => task.id === row.id);
    if (row.status === 'scheduled' && original.status !== 'scheduled') return 'To schedule';
    if (row.status === 'scheduled' && row.time !== original.time) return 'Time change to save';
    return morningLabel(row.status);
  };
  return `<div class="snapshot-heading"><span class="eyebrow">WEDNESDAY, SEPTEMBER 9</span><h3>Your day, in order.</h3></div><div class="morning-schedule">${morningRows(tasks).map(row => `<div class="snapshot-entry ${row.type === 'task' ? 'draft-entry' : 'fixed-entry'}"><span>${minuteLabel(minutesOf(row.time))}</span><div>${row.title}<small>${minuteLabel(minutesOf(row.end))} · ${row.type === 'task' ? statusText(row) : 'Calendar'}</small></div></div>`).join('')}</div>${tasks.some(task => task.status === 'list') ? `<div class="morning-unscheduled"><strong>Without a time block</strong>${tasks.filter(task => task.status === 'list').map(task => `<p>${schedule[task.id].title}</p>`).join('')}</div>` : ''}`;
}
function morningWorld() {
  return `${morningCoverage.news ? `<section class="morning-world" id="briefing-news"><span class="eyebrow">NEWS / THE BIG STORIES</span><h3>A different way to move a city.</h3><img src="assets/transit.png" alt="Illustrative city bus on a tree-lined street" width="1536" height="1024"><p>Cities are putting bus reliability ahead of road expansion. New priority lanes and more frequent services aim to make the everyday commute predictable; the test will be whether people start leaving their cars at home.</p><p>Also worth knowing: the next generation of batteries is moving from the lab into pilot projects. The question now is whether the gains in storage hold up at the scale of a working factory.</p><button class="text-button" data-morning-world="news">Read the stories ↗</button></section>` : ''}
    ${morningCoverage.sports ? `<section class="morning-world" id="briefing-sports"><span class="eyebrow">SPORTS / YOUR TEAMS FIRST</span><h3>Seattle found a way late.</h3><img src="assets/baseball.png" alt="Illustrative batter making contact at a baseball game" width="1536" height="1024"><p>The Mariners turned a tight game with three runs in the seventh, beating Houston <strong>5–3</strong>. The Storm finished strongly at home too, closing out Las Vegas <strong>84–79</strong>. Two wins for your followed teams, both decided by how they finished.</p><p>Elsewhere, the Yankees beat Boston <strong>11–10</strong> with a walk-off in the tenth, while the Dodgers edged San Diego <strong>2–1</strong> in a one-run division game.</p><div class="morning-tonight"><h4>Tonight</h4><p>${quietNight ? 'No games for your followed teams or other featured matchups tonight.' : 'The Mariners host Houston at <strong>6:40pm</strong>, and the Sounders visit Portland at <strong>7:30pm</strong>. Also worth watching: Mets–Dodgers at <strong>7:10pm</strong>. All times Pacific.'}</p></div><button class="text-button" data-morning-world="sports">See scores & tonight’s games ↗</button></section>` : ''}`;
}
function morningRead() {
  if (morningScenario === 'unavailable') return '<h3>Your morning briefing isn’t ready.</h3><p>Your calendar and tasks are available. You can review the day while the briefing is prepared.</p><button class="text-button" data-morning="retry-briefing">Try again</button>';
  const tasks = morningTasks();
  const proposal = tasks.find(task => task.id === 0);
  const prep = tasks.find(task => task.id === 2);
  const followup = tasks.find(task => task.id === 6);
  const pending = tasks.filter(task => task.status === 'proposed').length;
  return `<span class="eyebrow morning-dateline">PREPARED AT 6:45AM</span><h3>The proposal comes first.</h3>
    <p class="morning-lead">${morningScenario === 'no-evening' ? 'The proposal is due today. It takes priority over the rest of the task list.' : 'Last night, you wanted the proposal finished before the afternoon meetings. That is still the priority.'}</p>
    <div class="morning-change"><span class="eyebrow">CHANGED OVERNIGHT</span><h4>The review is an hour earlier.</h4><p>Alex moved it from 2pm to 1pm. Lunch stays at noon. ${prep.status === 'list' ? 'Preparation still needs time before the meeting.' : `Preparation ${prep.status === 'proposed' ? 'is proposed' : 'is set'} for ${minuteLabel(minutesOf(prep.time))}.`}</p><details><summary>See the calendar change</summary><p>Project review · Alex + 3<br><s>2:00–3:00pm</s> → 1:00–2:00pm<br>Calendar updated at 6:12am.</p></details></div>
    <div class="morning-reading"><h4>Start with the recommendation.</h4><p>${proposal.status === 'list' ? 'The proposal is still due today, with no time reserved. Find a block before you start the rest of the day.' : `${proposal.status === 'proposed' ? 'The proposed' : 'Your'} ${minuteLabel(minutesOf(proposal.time))} block gives you 90 minutes to finish and send it to Alex.`} The outline and pricing comparison are ready.</p><button class="text-button" data-morning-doc="proposal">Open the proposal materials ↗</button>
    <h4>Two decisions for the review.</h4><p>Agree the phase-one scope and who owns the revised timeline. ${followup.status === 'list' ? 'The follow-up stays on your task list without a time block.' : `There is ${followup.status === 'proposed' ? 'a proposed' : 'a'} follow-up block at ${minuteLabel(minutesOf(followup.time))} to capture the decisions.`}</p>
    <h4>Leave for town at 3:40.</h4><p>The team check-in ends at 3:30. Travel and the repair pickup are already in your calendar. The shop closes at five.</p></div>
    ${morningScenario === 'email-delayed' ? '<div class="planning-warning"><strong>Email hasn’t updated since yesterday at 8pm.</strong><p>There may be overnight replies I haven’t seen. Your calendar and task times are current.</p><button data-morning="refresh-email">Refresh email</button></div>' : ''}
    <details class="morning-sources"><summary>What informed this briefing?</summary><dl><dt>Calendar · 6:40am</dt><dd>Meetings, lunch, travel, and pickup.</dd><dt>Tasks · 6:42am</dt><dd>Proposal due today; preparation and follow-up.</dd><dt>${morningScenario === 'no-evening' ? 'No evening plan' : 'Last night · 7:20pm'}</dt><dd>${morningScenario === 'no-evening' ? 'Priority comes from the task deadline and existing calendar.' : 'Finish the proposal before the afternoon meetings.'}</dd><dt>Email · ${morningScenario === 'email-delayed' ? 'yesterday, 8pm' : '6:38am'}</dt><dd>${morningScenario === 'email-delayed' ? 'Overnight replies are not included.' : 'No new reply changes the proposal deadline.'}</dd>${morningCoverage.news ? '<dt>News · 6:30am</dt><dd>Lead stories and reporting selected for your briefing.</dd>' : ''}${morningCoverage.sports ? '<dt>Sports · 6:35am</dt><dd>Final scores, followed teams, and tonight’s schedule.</dd>' : ''}</dl></details>
    ${pending ? `<p class="morning-placement">${pending} task ${pending === 1 ? 'block awaits' : 'blocks await'} your acceptance.</p>` : ''}${morningWorld()}`;
}
function morningReview() {
  const changes = morningChanges();
  return `<h3>Make the plan fit.</h3><p>Meetings, lunch, and travel stay in place. Adjust the task blocks around them.</p>
    ${morningDraft.some(task => task.status === 'proposed') ? `<button class="solid morning-accept-all" data-morning="accept-all" ${morningConflicts().length ? 'disabled' : ''}>Accept all time blocks</button>` : ''}<div class="morning-task-controls">${morningDraft.map(task => {
      const original = morningTasks().find(item => item.id === task.id);
      const options = task.id === 0 ? ['08:30','09:00','10:30'] : task.id === 2 ? ['10:15','10:45','11:00','12:30'] : ['14:00','14:30','15:00'];
      return `<fieldset class="morning-task" data-morning-task="${task.id}"><legend>${schedule[task.id].title}</legend><p>${task.id === 0 ? '90 minutes · Due today' : task.id === 2 ? '45 minutes · Before the 1pm review' : '30 minutes · After the review'}</p><div class="morning-task-fields"><label>Time<select data-morning-time="${task.id}" ${task.status === 'list' ? 'disabled' : ''}>${options.map(value => `<option value="${value}" ${task.time === value ? 'selected' : ''}>${minuteLabel(minutesOf(value))}</option>`).join('')}</select></label><label>Placement<select data-morning-status="${task.id}"><option value="scheduled" ${task.status === 'scheduled' ? 'selected' : ''}>${original.status === 'scheduled' ? 'Keep on calendar' : 'Add to calendar'}</option>${original.status !== 'scheduled' ? `<option value="proposed" ${task.status === 'proposed' ? 'selected' : ''}>Keep proposed</option>` : ''}<option value="list" ${task.status === 'list' ? 'selected' : ''}>Leave unscheduled</option></select></label></div></fieldset>`;
    }).join('')}</div>
    ${morningDraft.some(task => task.status === 'list') ? '<p class="morning-placement">Unscheduled tasks stay on your list. Their deadlines do not change.</p>' : ''}
    <div class="morning-diff"><h4>What will change</h4>${changes.length ? changes.map(change => `<p>${safeText(change)}</p>`).join('') : '<p>No changes selected.</p>'}</div>`;
}
function drawMorning(focus = false) {
  const mobileOpen = morningDialog.querySelector('.planning-mobile-plan')?.open;
  const tasks = morningPage === 'review' ? morningDraft : morningTasks();
  const conflicts = morningPage === 'review' ? morningConflicts() : [];
  const changes = morningDraft ? morningChanges() : [];
  const pending = morningTasks().some(task => task.status === 'proposed');
  const review = morningPage === 'review';
  const canAcceptAll = pending && !changes.length && !review;
  morningDialog.innerHTML = `<header class="planning-header"><div><span class="eyebrow">MOSS / MORNING BRIEFING</span><h2 id="morning-title">Your day, prepared.</h2></div><button data-morning="close" aria-label="Close morning briefing">✕</button></header>
    <nav class="planning-progress morning-nav" aria-label="Morning briefing sections"><button data-morning="read" aria-current="${!review ? 'page' : 'false'}">The briefing</button><button data-morning="review" aria-current="${review ? 'page' : 'false'}">Review task blocks</button>${!review && morningScenario !== 'unavailable' ? `<div class="morning-world-jumps">${morningCoverage.news ? '<button data-morning-jump="news">News ↓</button>' : ''}${morningCoverage.sports ? '<button data-morning-jump="sports">Sports ↓</button>' : ''}</div>` : ''}</nav>
    <div class="planning-scroll"><details class="planning-mobile-plan" ${mobileOpen ? 'open' : ''}><summary>Today’s schedule</summary>${morningSnapshot(tasks)}</details><div class="planning-layout"><section class="planning-conversation" tabindex="-1">${review ? morningReview() : morningRead()}</section><aside class="planning-side" aria-label="Today’s schedule">${morningSnapshot(tasks)}</aside></div></div>
    ${conflicts.length ? `<div class="planning-warning conflict-warning" role="alert"><strong>These times overlap.</strong><span>${[...new Set(conflicts.map(row => row.title))].map(safeText).join(' · ')}. Keep the calendar commitments and choose another task time.</span><button data-morning="resolve">Use the prepared times</button></div>` : ''}
    ${morningError ? '<div class="planning-warning save-warning" role="alert"><strong>The changes couldn’t be saved.</strong><span>No changes were made. Your choices are ready to retry.</span><button data-morning="retry">Retry save</button></div>' : ''}
    <footer class="planning-footer morning-footer"><button class="planning-leave" data-morning="close">Back to Today</button>${review ? `<button class="solid" data-morning="save" ${conflicts.length || !changes.length ? 'disabled' : ''}>${changes.some(change => change.startsWith('Schedule')) ? 'Apply selected blocks' : 'Save changes'}</button>` : `<div class="morning-footer-actions"><button class="${canAcceptAll ? 'text-button' : 'solid'}" data-morning="review">${changes.length ? 'Review changes' : pending ? 'Review proposed blocks' : 'Adjust task blocks'}</button>${canAcceptAll ? '<button class="solid" data-morning="accept-all">Accept all time blocks</button>' : ''}</div>`}</footer>
    <div class="planning-demo"><span>Design study · Fictional day</span><div class="morning-coverage" role="group" aria-label="Include in morning briefing"><label><input type="checkbox" data-morning-coverage="news" ${morningCoverage.news ? 'checked' : ''}>News</label><label><input type="checkbox" data-morning-coverage="sports" ${morningCoverage.sports ? 'checked' : ''}>Sports</label></div><label>Preview state<select id="morning-scenario"><option value="ready">Prepared day</option><option value="no-evening">No evening plan</option><option value="unavailable">Briefing unavailable</option><option value="email-delayed">Email delayed</option><option value="save-error">Save fails</option></select></label></div>`;
  morningDialog.querySelector('#morning-scenario').value = morningScenario;
  if (focus) {
    morningDialog.querySelector('.planning-conversation').focus({ preventScroll:true });
    morningDialog.querySelector('.planning-scroll').scrollTop = 0;
  }
}
function saveMorning(stayInBriefing = false) {
  const scrollTop = morningDialog.querySelector('.planning-scroll').scrollTop;
  if (morningConflicts().length || !morningChanges().length) return;
  if (morningScenario === 'save-error') { morningPage = 'review'; morningError = true; drawMorning(); return; }
  morningSaved = structuredClone(morningDraft);
  accepted = morningSaved.every(task => task.status === 'scheduled');
  render();
  if (stayInBriefing) { morningPage = 'read'; drawMorning(); morningDialog.querySelector('.planning-scroll').scrollTop = scrollTop; } else closeMorning();
  announce('Your day plan is updated.');
}
function morningSlot(id) {
  const task = morningTasks().find(item => item.id === id);
  return task ? { ...schedule[id], ...task } : schedule[id];
}
function morningAgenda() {
  const tasks = morningTasks();
  const pending = tasks.filter(task => task.status === 'proposed').length;
  const scheduled = tasks.filter(task => task.status === 'scheduled').length;
  const rows = morningRows(tasks);
  return `<section id="day-plan">${heading('01','Your day, laid out','Wednesday, September 9')}<div class="plan-note"><p>${scheduled ? `<strong>${scheduled} task ${scheduled === 1 ? 'block is' : 'blocks are'} on your calendar.</strong> ` : ''}${pending ? `${pending} ${pending === 1 ? 'block awaits' : 'blocks await'} acceptance.` : scheduled ? '' : 'Tasks remain on your list without time blocks.'}</p><button class="solid" data-action="morning-review">${pending ? 'Review task blocks' : 'Adjust task blocks'}</button></div><div class="legend"><span><i></i> Task block</span><span><i class="fixed"></i> Calendar commitment</span><span><i class="open"></i> Open time</span></div><div class="timeline">${rows.map((row, i) => {
    const previous = rows[i - 1];
    const gap = previous && previous.end < row.time ? `<div class="slot gap"><div class="slot-time">${previous.end}<small>${row.time}</small></div><div class="slot-content">Open time</div></div>` : '';
    return gap + `<div class="slot ${row.type} ${row.status === 'proposed' ? 'proposal' : ''}"><div class="slot-time">${row.time}<small>${row.end}</small></div><div class="slot-content"><button data-slot="${row.id}"><span class="slot-title">${row.title}</span><span class="slot-meta">${row.type === 'task' ? `${minutesOf(row.end)-minutesOf(row.time)} min · ${morningLabel(row.status)}` : row.meta}</span></button></div></div>`;
  }).join('')}</div>${tasks.some(task => task.status === 'list') ? `<div class="morning-unscheduled"><strong>Still on your task list</strong>${tasks.filter(task => task.status === 'list').map(task => `<p>${schedule[task.id].title}${task.id === 0 ? ' · Due today' : ''}</p>`).join('')}</div>` : ''}<p class="schedule-end"><strong>The evening is open.</strong> No more commitments after 4:30.</p></section>`;
}
morningDialog.addEventListener('cancel', event => { event.preventDefault(); closeMorning(); });
morningDialog.addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.morningJump) {
    if (!morningDialog.querySelector(`#briefing-${button.dataset.morningJump}`)) drawMorning();
    morningDialog.querySelector(`#briefing-${button.dataset.morningJump}`)?.scrollIntoView({ block:'start', behavior:'instant' }); return;
  }
  if (button.dataset.morningWorld) {
    const target = button.dataset.morningWorld;
    closeMorning();
    const section = document.getElementById(target);
    section.scrollIntoView({ block:'start', behavior:'instant' });
    section.querySelector('button')?.focus({ preventScroll:true }); return;
  }
  if (button.dataset.morningDoc) {
    const section = morningDialog.querySelector('.planning-conversation');
    section.innerHTML = '<button class="text-button" data-morning="read">← Back to briefing</button><h3 class="morning-material-title">Proposal materials</h3><div class="review-record"><span>Proposal outline · Updated yesterday, 4:15pm</span><strong>Recommendation: a focused first phase</strong><p>Lead with the scope, compare the two pricing options, and name the next decision for Alex.</p></div><div class="review-record"><span>Pricing comparison · Attached to the task</span><strong>Two options ready to compare</strong><p>Use the comparison in the recommendation. The proposal is due today.</p></div>';
    section.focus(); return;
  }
  switch (button.dataset.morning) {
    case 'close': closeMorning(); break;
    case 'accept-all': {
      if (morningConflicts().length) return;
      const reading = morningPage === 'read';
      morningDraft.forEach(task => { if(task.status === 'proposed') task.status = 'scheduled'; });
      saveMorning(reading); break;
    }
    case 'read': morningPage = 'read'; drawMorning(true); break;
    case 'review': morningPage = 'review'; drawMorning(true); break;
    case 'resolve': morningDraft.forEach(task => { task.time = schedule[task.id].time; task.end = schedule[task.id].end; }); drawMorning(true); break;
    case 'save': saveMorning(); break;
    case 'retry': morningScenario = 'ready'; morningError = false; saveMorning(); break;
    case 'retry-briefing':
    case 'refresh-email': morningScenario = 'ready'; drawMorning(true); break;
  }
});
morningDialog.addEventListener('change', event => {
  const input = event.target;
  if (input.dataset.morningCoverage) {
    const key = input.dataset.morningCoverage;
    morningCoverage[key] = input.checked;
    const url = new URL(location);
    url.searchParams.set(key, input.checked ? 'on' : 'off');
    history.replaceState(null, '', url);
    drawMorning();
    morningDialog.querySelector(`[data-morning-coverage="${key}"]`).focus(); return;
  }
  if (input.id === 'morning-scenario') { morningScenario = input.value; morningError = false; drawMorning(); morningDialog.querySelector('#morning-scenario').focus(); return; }
  const time = input.dataset.morningTime;
  const status = input.dataset.morningStatus;
  if (time === undefined && status === undefined) return;
  const task = morningDraft.find(item => item.id === Number(time ?? status));
  if (!task) return;
  if (time !== undefined) {
    const duration = minutesOf(schedule[task.id].end) - minutesOf(schedule[task.id].time);
    task.time = input.value; task.end = clockValue(minutesOf(input.value) + duration);
  } else task.status = input.value;
  morningError = false; drawMorning();
  morningDialog.querySelector(`[${time !== undefined ? 'data-morning-time' : 'data-morning-status'}="${task.id}"]`).focus({ preventScroll:true });
});
document.querySelector('#scheduling').addEventListener('change', () => {
  if (morningDraft && !morningSaved) {
    const before = morningPreference === 'automatic' ? 'scheduled' : 'proposed';
    const after = scheduling === 'automatic' ? 'scheduled' : 'proposed';
    morningDraft.forEach(task => { if (task.status === before) task.status = after; });
  }
  morningPreference = scheduling;
});
// Keep the approved Today composition; update only facts affected by saved morning decisions.
document.addEventListener('moss:render', () => {
  if (mode !== 'morning' || !morningSaved) return;
  const proposal = morningSaved.find(task => task.id === 0);
  const prep = morningSaved.find(task => task.id === 2);
  const summary = document.querySelector('.masthead-summary');
  summary.textContent = proposal.status === 'list' ? 'The proposal is still the priority and is due today. It is on your task list without a time block. Your meetings, lunch, and trip into town are in place.' : `The proposal comes first, ${proposal.status === 'proposed' ? 'proposed' : 'scheduled'} at ${minuteLabel(minutesOf(proposal.time))}. The review is at one; lunch and the trip into town stay protected.`;
  document.querySelector('.support-section>p').textContent = prep.status === 'list' ? 'Preparation is still on your task list without a time block. Bring two decisions into the room.' : `Preparation ${prep.status === 'proposed' ? 'is proposed' : 'starts'} at ${minuteLabel(minutesOf(prep.time))}. Two decisions to bring into the room.`;
  document.querySelector('[data-doc="Proposal outline"] span').textContent = proposal.status === 'list' ? 'For the proposal · Due today' : `For your ${minuteLabel(minutesOf(proposal.time))} block`;
  document.querySelector('.support-section:nth-child(3)>p').textContent = 'Alex moved it from 2pm to 1pm. Lunch stays at noon; the calendar commitments remain in place.';
});
render();
if (query.get('brief') === 'open' && !planningDialog.open) { mode = 'morning'; render(); openMorningBriefing(); }

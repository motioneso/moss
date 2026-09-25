// Standalone interaction study. All content is fictional and all changes are in memory.
const modes = ['morning', 'day', 'evening'];
const query = new URLSearchParams(location.search);
let mode = modes.includes(query.get('mode')) ? query.get('mode') : 'morning';
let scheduling = query.get('blocks') === 'proposed' ? 'proposed' : 'automatic';
let accepted = false;
let loopDecision = '';
let tomorrowSaved = false;
let toastTimer;
let quietNight = query.get('night') === 'quiet';
const medicationLog = [false, false];
let lastCheckin = '';
const sampleMedications = ['Morning medication', 'Daily supplement'];
const main = document.querySelector('main');
const detail = document.querySelector('#detail');
const conversation = document.querySelector('#conversation');
const schedule = [
  {time:'08:30',end:'10:00',title:'Finish the partnership proposal',type:'task',meta:'90 min · Work · Due today',note:'The outline is finished. Use this block to write the recommendation and send the proposal to Alex.',prep:'Proposal outline, pricing comparison'},
  {time:'10:00',end:'10:15',title:'A break before the next block',type:'gap'},
  {time:'10:15',end:'11:00',title:'Prepare for the project review',type:'task',meta:'45 min · Work · For your 1pm meeting',note:'Review the latest numbers and note the two decisions you need from the group.',prep:'Review agenda, project numbers'},
  {time:'11:00',end:'12:00',title:'Open time',type:'gap'},
  {time:'12:00',end:'13:00',title:'Lunch',type:'event',meta:'1 hour · Personal',note:'An existing personal calendar block. Moss leaves it in place.'},
  {time:'13:00',end:'14:00',title:'Project review',type:'event',meta:'1 hour · Video call · Alex + 3',note:'Review the revised proposal and decide the scope for the next phase.',prep:'Review agenda, project numbers'},
  {time:'14:00',end:'14:30',title:'Capture notes & follow up',type:'task',meta:'30 min · Work · After the review',note:'Turn the review decisions into clear next steps while the conversation is fresh.'},
  {time:'14:30',end:'15:00',title:'Room between commitments',type:'gap'},
  {time:'15:00',end:'15:30',title:'Team check-in',type:'event',meta:'30 min · Video call · Your team',note:'A short afternoon check-in. Moss plans around this accepted invitation.'},
  {time:'15:40',end:'16:00',title:'Travel into town',type:'event',meta:'20 min · Travel buffer · For the repair pickup',note:'Time to get to the shop before collection. This buffer keeps the journey visible in the plan.'},
  {time:'16:00',end:'16:30',title:'Pick up the repair',type:'event',meta:'30 min · In town · Leave at 3:40',note:'Allow 20 minutes to get there. Collection closes at 5pm.'}
];

function sun(){return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M20 4l-2 2M6 18l-2 2"/></svg>';}
function heading(number,title,meta=''){return `<div class="section-head"><span class="number">${number}</span><h2>${title}</h2><span class="meta">${meta}</span></div>`;}
function hero(){
  const copy={
    morning:{kicker:'Good morning, Sam / Morning briefing',title:'A clear morning.',accent:'A full afternoon.',summary:'The proposal is the important piece today. Start there while the morning is quiet; your review materials are ready for the afternoon. There’s room for a break, lunch, and the trip into town.',time:'Prepared at 6:45am',temperature:'64°',conditions:'Clear until evening',forecast:'High 74° · Low 55°'},
    day:{kicker:'Good afternoon, Sam / Your day, updated',title:'The big piece is done.',accent:'A little room before what’s next.',summary:'The proposal is sent and the review is wrapped up. Capture the decisions while they’re fresh, then join your team at 3. Leave at 3:40 for the repair pickup.',time:'Updated at 2:10pm',temperature:'72°',conditions:'Clear through the afternoon',forecast:'High 74° · Low 55°'},
    evening:{kicker:'Good evening, Sam / Evening briefing',title:'The proposal is out.',accent:'Tomorrow has room.',summary:'The work you made room for this morning is finished. The review gave the team a direction, and the follow-up is sent. One personal task needs a new place; tomorrow has space for it.',time:'Prepared at 7:00pm',temperature:'61°',conditions:'Clear tonight',forecast:'Overnight low 55°'}
  }[mode];
  return `<header class="masthead"><div class="masthead-top"><span class="eyebrow">${copy.kicker}</span></div><h1>${copy.title}<span>${copy.accent}</span></h1><p class="masthead-summary">${copy.summary}</p><section class="weather" aria-label="Weather"><div class="weather-now">${sun()}<strong>${copy.temperature}<small>F</small></strong></div><div class="weather-outlook"><strong>${copy.conditions}</strong><span>${copy.forecast}</span></div></section><div class="masthead-foot"><button data-action="briefing">Read the full ${mode==='evening'?'evening':'morning'} briefing</button><button data-action="context">What informed this?</button><span>${copy.time}</span></div></header>`;
}

function agenda(){
  if(mode==='morning' && typeof morningAgenda==='function' && morningSaved) return morningAgenda();
  const proposed=scheduling==='proposed'&&!accepted;
  const status=proposed?'<p><strong>Your proposed plan.</strong> Three task blocks fit around your commitments.</p><button class="solid" data-action="accept">Accept task blocks</button>':'<p><strong>Your task blocks are on the calendar.</strong> Moss can adjust its blocks when the day changes.</p>';
  return `<section id="day-plan">${heading('01','Your day, laid out','Wednesday, September 9')}<div class="plan-note">${mode==='morning'?status.replace('data-action="accept">Accept task blocks','data-action="morning-review">Review task blocks'):status}${mode==='morning'&&!proposed?'<button class="solid" data-action="morning-review">Adjust task blocks</button>':''}</div><div class="legend"><span><i></i> ${proposed?'Proposed task':'Moss-planned task'}</span><span><i class="fixed"></i> Calendar commitment</span><span><i class="open"></i> Open time</span></div><div class="timeline">${schedule.map((s,i)=>{
    const past=mode==='day'&&i<6;
    const tag=s.type==='task'?(proposed?'Proposed':past?'Completed':'Flexible'):'';
    return `<div class="slot ${s.type} ${s.type==='task'&&proposed?'proposal':''} ${past?'past':''} ${mode==='day'&&i===6?'current':''}"><div class="slot-time">${s.time}<small>${s.end}</small></div><div class="slot-content">${s.type==='gap'?s.title:`<button data-slot="${i}"><span class="slot-title">${s.title}</span><span class="slot-meta">${s.meta}${tag?`<span class="divider">·</span><span class="tag">${tag}</span>`:''}${mode==='day'&&i===6?'<span class="tag">Now</span>':''}</span></button>`}</div></div>`;
  }).join('')}</div><p class="schedule-end"><strong>The evening is open.</strong> No more commitments after 4:30.</p></section>`;
}

function preparation(){return `<aside class="support" aria-label="Preparation and context"><section class="support-section"><span class="eyebrow">${mode==='day'?'Next on your calendar':'First meeting'}</span><div class="time-lead">${mode==='day'?'3:00':'1:00'} <small>pm</small></div><h3>${mode==='day'?'Team check-in':'Project review'}</h3><p>${mode==='day'?'Your follow-up block ends at 2:30. There’s a little room before the team joins.':'You have a 45-minute preparation block this morning. Two decisions to bring into the room.'}</p><button class="text-button" data-slot="${mode==='day'?'8':'5'}">${mode==='day'?'Open meeting':'See meeting & decisions'} ↗</button></section><section class="support-section"><span class="eyebrow">Ready when you are</span><h3>Your preparation</h3><button class="document-link" data-doc="Proposal outline"><div>Proposal outline<span>For your 8:30 block</span></div>↗</button><button class="document-link" data-doc="Review agenda"><div>Review agenda<span>Two decisions to make</span></div>↗</button><button class="document-link" data-doc="Project numbers"><div>Project numbers<span>Updated yesterday</span></div>↗</button></section><section class="support-section"><span class="eyebrow">Since last night</span><h3>The review moved.</h3><p>Alex moved it from 2pm to 1pm. ${scheduling==='proposed'&&!accepted?'The proposed plan keeps':'Your plan keeps'} preparation in the morning and lunch clear.</p></section><div class="support-note"><p><strong>A little practical context</strong>Leave at 3:40 for the repair pickup. The shop closes at 5; your evening stays free.</p></div></aside>`;}

function evening(){return `<section id="day-plan">${heading('01','What happened today','Wednesday, September 9')}<p class="recap-intro">You protected the morning for the proposal, and it paid off. The afternoon was about getting everyone aligned. Both are now in a good place.</p><div class="done-item"><span class="done-check" aria-label="Completed">✓</span><div><h3>Partnership proposal sent to Alex</h3><p>The recommendation and pricing comparison are in their hands.</p></div></div><div class="done-item"><span class="done-check" aria-label="Completed">✓</span><div><h3>Project scope agreed in the review</h3><p>You captured the decisions and sent the follow-up.</p></div></div><div class="done-item"><span class="done-check" aria-label="Completed">✓</span><div><h3>Repair collected</h3><p>One less thing to keep in your head.</p></div></div><section class="subsection"><h2>Close the open loops</h2><p>One decision for you. One thing Moss is watching.</p><div class="open-loop" id="bike-loop"><span class="story-topic">Needs a new time</span><h3>Book the bike service</h3><p>It was on today’s list, but never had a block. There’s a small opening tomorrow afternoon.</p>${loopDecision?`<div class="resolved">${loopDecision} <button class="text-button" data-action="undo-loop">Undo</button></div>`:'<div class="loop-actions"><button data-disposition="tomorrow">Tomorrow</button><button data-disposition="date">Choose a day</button><button data-disposition="drop">Let it go</button></div>'}</div><div class="open-loop"><span class="story-topic">Waiting on someone else</span><h3>Alex’s feedback on the proposal</h3><p>No action tonight. Moss will bring it back if a reply changes tomorrow’s plan.</p></div></section><details class="moss-created"><summary>1 task Moss captured today</summary><p><strong>Send the revised timeline to the team.</strong> From your explicit commitment in the project review. Proposed for tomorrow afternoon.</p></details></section><aside class="support evening-support" aria-label="Tomorrow and evening planning"><section class="support-section"><span class="eyebrow">Thursday, September 10</span><h3>Tomorrow starts gently.</h3><p>One morning appointment. The rest of the day has room to work with.</p><div class="tomorrow-item"><strong>9:30am / Travel</strong>Leave for your appointment</div><div class="tomorrow-item"><strong>10:00am / Confirmed</strong>Dental appointment<small>45 minutes · In town</small></div><div class="tomorrow-item"><strong>1:00pm / Proposed</strong>Send the revised timeline<small>45 minutes · From today’s review</small></div>${loopDecision==='Moved to tomorrow.'?'<div class="tomorrow-item"><strong>2:30pm / Proposed</strong>Book the bike service<small>15 minutes · Carried forward</small></div>':''}<p class="tomorrow-note">${tomorrowSaved?'Your preferences are saved in this preview. Tomorrow’s morning briefing will start from this plan.':'These are starting points. Nothing new is committed until your planning settings allow it.'}</p><button class="solid" data-action="prepare">${tomorrowSaved?'Review tomorrow’s plan':'Prepare tomorrow with Moss'} ↗</button></section><section class="support-section"><span class="eyebrow">A thought to take forward</span><h3>Keep some room.</h3><p>You have space tomorrow. Before filling it, decide whether you want another focused workday or a lighter one.</p></section><div class="support-note"><p><strong>Nothing needs a decision tonight.</strong>The bike service can wait. Preparing tomorrow is here when it’s useful.</p></div></aside>`;}

function moduleWidgets(){
  const count=medicationLog.filter(Boolean).length;
  return `<section class="module-dock" id="quick-actions" aria-label="Quick actions from your modules"><div class="widget-heading"><span class="eyebrow">QUICK ACTIONS</span><span class="widget-owner">Wellness</span></div><div class="wellness-widget"><details class="medication-details"><summary><span>Medications</span><span class="med-count">${count} of 2 logged</span></summary><div class="medication-list">${sampleMedications.map((name,i)=>`<label class="medication-row"><input type="checkbox" data-medication="${i}" ${medicationLog[i]?'checked':''}><span>${name}<small>Today · Sample medication</small></span></label>`).join('')}<p>Mark only what you’ve taken. Uncheck to correct a log.</p></div></details><div class="checkin-widget"><div><strong>Check in with yourself</strong><span id="checkin-status">${lastCheckin?'Check-in recorded today.':'A moment to notice how you are.'}</span></div><button class="solid" data-action="checkin">${lastCheckin?'Check in again':'Check in'}</button></div></div></section>`;
}

function news(){return `<section class="world" id="news">${heading('02',mode==='evening'?'The day’s developments':'The wider world','News · Illustrative stories')}<div class="news-layout"><article class="lead-story"><button class="story-photo" data-story="Cities rethink the commute, one bus lane at a time" aria-label="Read Cities rethink the commute"><img src="assets/transit.png" alt="Illustrative photo of a city bus on a tree-lined street" width="1536" height="1024" loading="lazy"></button><span class="story-topic">Transport / The lead story</span><button class="read-story" data-story="Cities rethink the commute, one bus lane at a time"><h3>Cities rethink the commute, one bus lane at a time.</h3></button><p>A new wave of transport projects puts reliability ahead of expansion. The question is whether shorter, more predictable journeys can bring people back to public transit.</p><button class="text-button" data-story="Cities rethink the commute, one bus lane at a time">Read the story ↗</button></article><div class="story-list"><button class="story-row" data-story="The next generation of batteries moves beyond the lab"><span class="story-topic">Science & technology</span><h3>The next generation of batteries moves beyond the lab.</h3><p>What the latest pilot projects might mean for everyday use.</p></button><button class="story-row" data-story="An unusually good season for independent bookstores"><span class="story-topic">Culture</span><h3>An unusually good season for independent bookstores.</h3><p>Smaller shops are finding a new role in their neighborhoods.</p></button><div class="news-note"><span class="eyebrow">YOUR NEWS, IN CONTEXT</span><p>A few stories worth knowing, with the reporting a click away.</p></div></div></div></section>`;}

function scoreGame(home,away,homeScore,awayScore,reason,followed=false,final='Final'){
  return `<button class="score-game ${followed?'followed-game':''}" data-story="${home} vs. ${away}"><span class="game-teams"><span>${home}<b>${homeScore}</b></span><span>${away}<b>${awayScore}</b></span></span><span class="game-context"><strong>${final}</strong><span>${reason}</span></span></button>`;
}

function sports(){return `<section class="world" id="sports">${heading('03','From the sidelines','Sports · Sample games & teams')}<div class="sports-digest"><section class="results-desk" aria-label="Last night’s scores"><div class="results-heading"><h3>Last night</h3><span>Tuesday, September 8</span></div><h4 class="score-group">★ Your followed teams</h4>${scoreGame('Seattle Mariners','Houston Astros',5,3,'A seventh-inning comeback',true)}${scoreGame('Seattle Storm','Las Vegas Aces',84,79,'A strong finish at home',true)}<h4 class="score-group other-games">Elsewhere worth a look</h4>${scoreGame('New York Yankees','Boston Red Sox',11,10,'A walk-off in extra innings',false,'Final / 10')}${scoreGame('Los Angeles Dodgers','San Diego Padres',2,1,'A one-run division battle')}</section><article class="sports-feature"><button class="story-photo" data-story="Seattle leaves it late, then makes it count" aria-label="Read Seattle’s comeback story"><img src="assets/baseball.png" alt="Illustrative action photo of a batter making contact at a baseball game" width="1536" height="1024" loading="lazy"></button><span class="story-topic">★ Following / Mariners</span><button class="read-story" data-story="Seattle leaves it late, then makes it count"><h3>Seattle leaves it late, then makes it count.</h3></button><p>Three runs in the seventh turned the game. A quick look at the rally, the final innings, and what comes next in the series.</p><button class="text-button" data-story="Seattle leaves it late, then makes it count">The story behind the score ↗</button></article></div><section class="tonight" aria-label="Tonight’s games"><div class="tonight-heading"><h3>Tonight</h3><span>Wednesday, September 9 · Pacific time</span></div>${quietNight?'<p class="quiet-night"><strong>A quiet night.</strong> No games for your followed teams or other featured matchups tonight.</p>':`<div class="tonight-games"><button data-story="Tonight: Mariners vs. Astros"><span class="fixture-kicker">★ Following / MLB</span><strong>Mariners vs. Astros</strong><span class="fixture-time">${mode==='evening'?'Live · Top of the 3rd':'6:40pm'} <span>Home</span></span></button><button data-story="Tonight: Sounders vs. Timbers"><span class="fixture-kicker">★ Following / MLS</span><strong>Sounders vs. Timbers</strong><span class="fixture-time">7:30pm <span>Away</span></span></button><button data-story="Tonight: Mets vs. Dodgers"><span class="fixture-kicker">Worth watching / MLB</span><strong>Mets vs. Dodgers</strong><span class="fixture-time">7:10pm <span>Series opener</span></span></button></div>`}</section></section>`;}

function render(){
  document.body.dataset.mode=mode;
  document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===mode)));
  document.querySelector('#scheduling').value=scheduling;
  document.querySelector('#sports-night').value=quietNight?'quiet':'games';
  const url=new URL(location);url.searchParams.set('mode',mode);url.searchParams.set('blocks',scheduling);url.searchParams.set('night',quietNight?'quiet':'games');history.replaceState(null,'',url);
  main.innerHTML=hero()+`<nav class="section-index" aria-label="Briefing sections"><span class="index-label">IN THIS BRIEFING</span><a href="#day-plan">${mode==='evening'?'Your day & tomorrow':'Your day & preparation'}</a><a href="#quick-actions">Quick actions</a><a href="#news">News</a><a href="#sports">Sports</a></nav>`+(mode==='day'?'<div class="updated"><strong>2:10pm / One thing changed.</strong>The review finished on time. Your follow-up block is ready, and the rest of the plan still fits.</div>':'')+`<div class="briefing-grid">${moduleWidgets()}${mode==='evening'?evening():agenda()+preparation()}</div>`+news()+sports()+'<footer class="page-end"><strong>A little more prepared. A little less to carry.</strong><span>Design study · Fictional content · September 9, 2026</span></footer>';
  document.dispatchEvent(new Event('moss:render'));
}

function openDetail(title,body){
  document.querySelector('#detail-content').innerHTML='<div class="detail-body"><h2 id="detail-title"></h2>'+body+'<p class="sample-note">Fictional sample content. This preview does not connect to your account.</p></div>';
  document.querySelector('#detail-title').textContent=title;
  detail.showModal();
}

function announce(message){
  const toast=document.querySelector('.toast');clearTimeout(toastTimer);toast.textContent=message;toast.hidden=false;
  toastTimer=setTimeout(()=>{toast.hidden=true;},4200);
}

function startConversation(){
  document.querySelector('#conversation-title').textContent='What needs to change?';
  document.querySelector('#conversation-intro').textContent='Your plan is a starting point. Tell Moss about a new constraint or a different priority.';
  document.querySelector('#moss-question').textContent='I have your schedule and briefing here. What should we adjust?';
  document.querySelector('#replies').replaceChildren();document.querySelector('#reply').value='';
  conversation.showModal();
}

function reply(text){
  const replies=document.querySelector('#replies');
  const user=document.createElement('p');user.className='message user-message';user.textContent=text;replies.append(user);
  const moss=document.createElement('p');moss.className='message moss-message';
  moss.textContent='This is where Moss would reconcile your request with the day. This visual study uses sample responses and makes no calendar changes.';
  replies.append(moss);document.querySelector('#reply').value='';
}

document.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button)return;
  if(button.hasAttribute('data-close')){button.closest('dialog').close();return;}
  if(button.dataset.mode){mode=button.dataset.mode;render();window.scrollTo({top:0,behavior:'instant'});return;}
  if(button.dataset.slot){
    const s=mode==='morning' ? morningSlot(Number(button.dataset.slot)) : schedule[Number(button.dataset.slot)];
    openDetail(s.title,`<dl><dt>When</dt><dd>${s.time}–${s.end}, today</dd><dt>Kind</dt><dd>${s.type==='task'?'Flexible task block':'Calendar commitment'}</dd>${s.prep?`<dt>Ready</dt><dd>${s.prep}</dd>`:''}</dl><p>${s.note}</p>${s.type==='task'?'<button class="solid" data-action="adjust">Adjust with Moss ↗</button>':''}`);return;
  }
  if(button.dataset.doc){openDetail(button.dataset.doc,'<p>Your preparation opens here, with its source and the relevant meeting or task attached.</p><p><strong>For the review:</strong> agree the phase-one scope and confirm who owns the revised timeline. The latest figures and your notes would be available together.</p>');return;}
  if(button.dataset.story){openDetail(button.dataset.story,'<p>This is a representative story for reviewing the news and sports layout. The headline, score, and summary are illustrative.</p><p>In the finished briefing, this opens the reporting or game detail, with the source, publication time, and a link to the original coverage.</p>');return;}
  if(button.dataset.disposition){
    if(button.dataset.disposition==='date'){openDetail('Choose a day','<form id="reschedule"><label for="new-date">Move “Book the bike service” to</label><p><input id="new-date" name="date" type="date" min="2026-09-10" value="2026-09-11" required></p><button class="solid" type="submit">Move task</button></form>');return;}
    loopDecision=button.dataset.disposition==='drop'?'Removed from your plans.':'Moved to tomorrow.';render();announce(loopDecision+' Preview only.');return;
  }
  switch(button.dataset.action){
    case 'checkin':openDetail('How are you feeling?', '<form id="checkin-form"><label for="feeling">Choose a feeling</label><select id="feeling" name="feeling" required><option value="">Select a feeling</option><option>Calm</option><option>Hopeful</option><option>Tired</option><option>Overwhelmed</option></select><label for="checkin-note">Anything you want to note? <span class="muted">Optional</span></label><textarea id="checkin-note" name="note" rows="3" maxlength="500" placeholder="A little context, if it helps"></textarea><button class="solid" type="submit">Save check-in</button></form>');break;
    case 'accept':accepted=true;render();document.querySelector('#day-plan h2').setAttribute('tabindex','-1');document.querySelector('#day-plan h2').focus({preventScroll:true});announce('Three task blocks accepted in this preview.');break;
    case 'undo-loop':loopDecision='';render();announce('Task returned to the evening review.');break;
    case 'ask':startConversation('ask');break;
    case 'adjust':detail.close();if(mode==='morning')openMorningBriefing('review','morning-review');else startConversation('ask');break;
    case 'morning-review':openMorningBriefing('review','morning-review');break;
    case 'prepare':openEveningPlan();break;
    case 'context':openDetail('What informed this briefing?','<p>Moss should make its reasoning inspectable without crowding the briefing.</p><dl><dt>Calendar</dt><dd>Accepted meetings, lunch, the repair pickup, and travel time.</dd><dt>Tasks</dt><dd>The proposal deadline, preparation work, and your follow-up.</dd><dt>Last night</dt><dd>Your intention to finish the proposal before the afternoon meetings.</dd><dt>Changed</dt><dd>The review moved from 2pm to 1pm.</dd></dl>');break;
    case 'briefing':if(mode==='morning'){openMorningBriefing();break;}openDetail(mode==='evening'?'Your evening briefing':'Your morning briefing',mode==='evening'?'<p>The proposal you set out to finish is sent. Alex has the recommendation and pricing comparison, and the review ended with agreement on the next phase. Your follow-up is out too.</p><p>The bike service is the only loose task from today. It had no time reserved, and the afternoon filled up. There’s space tomorrow if you still want to do it; nothing depends on deciding tonight.</p><p>Tomorrow’s appointment is at ten. I’d leave the morning around it clear, put the revised timeline after lunch, and preserve some open time. We can shape that together when you’re ready.</p>':'<p>Your main job today is the partnership proposal. You wanted it finished before the afternoon meetings; the plan gives it the first uninterrupted block at 8:30. The outline and pricing comparison are ready.</p><p>The project review moved from two to one. The preparation block at 10:15 still fits, and lunch stays protected. Bring two decisions into the meeting: the first-phase scope and who owns the revised timeline.</p><p>There’s a follow-up block directly after the review, then the team check-in at three. Leave at 3:40 for the repair pickup. The evening is open.</p><p>The plan leaves an open hour before lunch. I’d keep it free for whatever the proposal turns up rather than fill it now.</p>');break;
  }
});

document.querySelector('#scheduling').addEventListener('change',event=>{scheduling=event.target.value;accepted=false;render();});
document.querySelector('#reply-form').addEventListener('submit',event=>{event.preventDefault();const text=document.querySelector('#reply').value.trim();if(text)reply(text);});
document.addEventListener('submit',event=>{if(event.target.id==='reschedule'){event.preventDefault();const date=document.querySelector('#new-date').value;loopDecision='Moved to '+new Intl.DateTimeFormat('en-US',{month:'long',day:'numeric',timeZone:'UTC'}).format(new Date(date+'T12:00:00Z'))+'.';detail.close();render();announce(loopDecision+' Preview only.');}});
render();

document.querySelector('#sports-night').addEventListener('change',event=>{quietNight=event.target.value==='quiet';render();});
document.addEventListener('change',event=>{
  if(!event.target.matches('[data-medication]'))return;
  const index=Number(event.target.dataset.medication);
  if(!Number.isInteger(index)||index<0||index>=medicationLog.length)return;
  medicationLog[index]=event.target.checked;
  document.querySelector('.med-count').textContent=medicationLog.filter(Boolean).length+' of 2 logged';
  announce((event.target.checked?'Logged as taken.':'Medication log corrected.')+' Preview only.');
});
document.addEventListener('submit',event=>{
  if(event.target.id!=='checkin-form')return;
  event.preventDefault();lastCheckin=document.querySelector('#feeling').value;
  detail.close();document.querySelector('#checkin-status').textContent='Check-in recorded today.';
  const button=document.querySelector('[data-action=checkin]');button.textContent='Check in again';button.focus({preventScroll:true});
  announce('Check-in recorded in this preview.');
});

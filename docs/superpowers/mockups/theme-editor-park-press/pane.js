/* The proposed Appearance pane, shared by the desktop and phone pages. */

function thumb(theme, custom) {
  var scope = custom
    ? ' style="--paper:#eef1f4;--bg:#eef1f4;--surface:#f8fafb;--ink:#1d2733;--ink-3:#6b7684;--line:#c9d1da;--forest:#2c5d8a;--gold:#d39b3c;--text-on-accent:#ffffff;--sage-light:#dfe6ee;--nv-override:var(--harbor-nav, #dfe6ee)"'
    : theme
      ? ' data-builtin data-theme="' + theme + '"'
      : " data-builtin data-forest";
  return (
    '<span class="mini"' +
    scope +
    '><span class="mini__nav"><i></i><i class="on"></i><i></i><i></i><i></i></span>' +
    '<span class="mini__body"><span class="mini__hero"><i></i></span><span class="mini__rows"><i></i><i></i><i></i></span></span></span>'
  );
}

function tcard(name, theme, opts) {
  opts = opts || {};
  var actions = '<button class="jds-btn jds-btn--secondary jds-btn--sm tcard__apply">Apply</button>';
  if (opts.custom) actions += '<button class="jds-btn jds-btn--quiet jds-btn--sm">Edit</button>';
  actions += '<button class="jds-btn jds-btn--quiet jds-btn--sm">Duplicate</button>';
  if (opts.custom) actions += '<button class="jds-btn jds-btn--quiet jds-btn--sm">Delete</button>';
  return (
    '<article class="tcard" data-theme-card="' +
    opts.id +
    '"><button class="tcard__thumb" aria-label="Apply ' +
    name +
    '">' +
    thumb(theme, opts.custom) +
    '</button><div class="tcard__row"><span class="tcard__name">' +
    name +
    "</span>" +
    '<span class="tcard__state">Current</span>' +
    '</div><div class="tcard__actions">' +
    actions +
    "</div></article>"
  );
}

function slot(name, desc, value, opts) {
  opts = opts || {};
  var chip = opts.line
    ? '<span class="linechip" style="--lc:' + value + ";--lw:" + (opts.lw || "1px") + '"><i></i></span>'
    : '<input type="color" value="' + value + '" aria-label="' + name + ' color" style="width:36px;height:36px;padding:2px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--surface)">';
  return (
    '<div class="slot' +
    (opts.selected ? " is-selected" : "") +
    '"><div><div class="slot__name">' +
    name +
    '</div><div class="slot__desc">' +
    desc +
    '</div></div><div class="slot__ctl">' +
    chip +
    '<input class="jds-input jds-input--sm" value="' +
    value +
    '" aria-label="' +
    name +
    ' value"></div></div>'
  );
}

function group(title, hint, slots) {
  return (
    '<section><h4 class="slotgroup__title">' +
    title +
    '</h4><p class="slotgroup__hint">' +
    hint +
    "</p>" +
    slots.join("") +
    "</section>"
  );
}

function previewMarkup() {
  return (
    '<div class="pv"><div class="pv__nav"><div class="pv__brand">Moss</div>' +
    '<span class="pv__link is-active">Today</span><span class="pv__link">The Workshop</span><span class="pv__link">Tasks</span><span class="pv__link">Calendar</span><span class="pv__link">News</span></div>' +
    '<div class="pv__main"><div class="pv__hero"><div class="pv__eyebrow">Good morning, Ben</div><p class="pv__headline">A clear run<br>to lunch</p><p class="pv__summary">Two meetings, one errand, nothing overdue.</p></div>' +
    '<div class="pv__head"><span class="pv__num">01</span><span class="pv__title">Your day, laid out</span></div>' +
    '<div><div class="pv__row"><span class="pv__time">9:00</span><span>Morning review<br><span class="pv__meta">30 minutes</span></span></div>' +
    '<div class="pv__row"><span class="pv__time">2:30 pm</span><span>Call the vet<br><span class="pv__meta">Task, due today</span></span></div></div>' +
    '<div class="pv__note">The evening is open after 3:30.</div>' +
    '<div class="pv__card"><span>Medications <span class="pv__meta">0 of 1 logged</span></span><span class="jds-btn jds-btn--primary jds-btn--sm">Check in</span></div>' +
    '<div class="pv__actions"><span class="jds-btn jds-btn--secondary jds-btn--sm">Secondary</span><a class="jds-btn jds-btn--link jds-btn--sm" href="#">See meeting</a></div>' +
    "</div></div>"
  );
}

function paneMarkup() {
  return (
    '<div class="pane__head"><h2 class="pane__title">Appearance</h2><p class="pane__desc">Pick a color theme for this account, or build your own. Warning and error colors stay fixed so they always read correctly.</p></div>' +
    /* Theme */
    '<section class="pane__card"><header class="pane__cardhead"><div class="pane__cardheadmain"><div class="pane__cardtitle">Theme</div><div class="pane__carddesc">Built-in themes follow light or dark. Your own themes keep the colors you saved, nav bar included.</div></div><div class="pane__cardaction"><button class="jds-btn jds-btn--secondary jds-btn--sm">+ New theme</button></div></header>' +
    '<div class="pane__cardbody"><div class="set-row"><div class="set-row__main"><div class="set-row__name">Color mode</div><div class="set-row__desc" data-mode-desc>Applies to every built-in theme.</div></div><div class="set-row__control"><div class="jds-segmented" role="group"><button class="jds-segmented__opt" data-pick="mode:light">Light</button><button class="jds-segmented__opt" data-pick="mode:dark">Dark</button></div></div></div>' +
    '<div class="jds-eyebrow jds-eyebrow--muted gal-label">Built in</div><div class="gal">' +
    tcard("Forest", "", { id: "" }) +
    tcard("Sage", "sage", { id: "sage" }) +
    tcard("Canyon", "canyon", { id: "canyon" }) +
    tcard("Teal", "teal", { id: "teal" }) +
    tcard("Dusk", "dusk", { id: "dusk" }) +
    '</div><div class="jds-eyebrow jds-eyebrow--muted gal-label">Your themes</div><div class="gal">' +
    tcard("Harbor", null, { custom: true, id: "harbor" }) +
    "</div></div></section>" +
    /* Editor */
    '<section class="pane__card" id="editor"><header class="pane__cardhead"><div class="pane__cardheadmain"><div class="pane__cardtitle">Edit Harbor</div><div class="pane__carddesc">The preview changes as you type. Nothing is applied until you save.</div></div></header>' +
    '<div class="editor"><div class="slots"><div class="jds-field slots__name"><label class="jds-label">Name</label><input class="jds-input" value="Harbor"></div>' +
    group("Page and cards", "The page behind everything, then the cards and wells that sit on it.", [
      slot("Page", "The paper behind every screen", "#eef1f4"),
      slot("Card", "Cards, menus and dialogs", "#f8fafb"),
      slot("Soft card", "Quiet wells and inset blocks", "#e9eef3"),
      slot("Track", "Switch tracks and progress bars", "#c9d3dd")
    ]) +
    group("Text", "Headline text first, then quieter body, hint and placeholder text.", [
      slot("Text", "Headlines and body", "#1d2733"),
      slot("Soft text", "Descriptions and secondary lines", "#4d5a69"),
      slot("Faint text", "Times, counts and meta", "#6b7684"),
      slot("Quiet text", "Placeholders and disabled labels", "#8a94a0")
    ]) +
    group("Lines", "Rules between rows and around cards, from barely there to firm.", [
      slot("Hairline", "Between rows", "#dde3ea", { line: true }),
      slot("Line", "Around cards and fields", "#c9d1da", { line: true }),
      slot("Firm line", "Under the top bar, heavy rules", "#9aa6b3", { line: true, lw: "2px" })
    ]) +
    group("Accent and gold", "The accent fills the Today band, buttons and the selected nav item. Gold draws the rules under it, never text.", [
      slot("Accent", "Buttons, links, the Today band", "#2c5d8a", { selected: true }),
      slot("Gold", "Rules and markers only", "#d39b3c")
    ]) +
    '<section class="navgroup" id="navgroup"><h4 class="slotgroup__title">Nav bar</h4><p class="slotgroup__hint">The column of links down the left side. On a phone it also colors the top bar and the menu. Text and icons pick dark or light by themselves.</p>' +
    '<div class="navpick" role="radiogroup" aria-label="Nav bar color">' +
    swatchesMarkup() +
    '<span class="colorfield"><input type="color" data-nav-color aria-label="Custom nav color"><input class="jds-input jds-input--sm" data-nav-hex aria-label="Nav color value"></span></div>' +
    '<div class="navstrip" data-nav-scope aria-hidden="true">' +
    navStripMarkup() +
    '</div><div class="navrow-foot"><p class="readout" data-readout></p><button class="jds-btn jds-btn--quiet jds-btn--sm" data-reset>Reset to Harbor default</button></div></section>' +
    '<section class="palette"><h4 class="slotgroup__title">Paste a palette</h4><p class="slotgroup__hint">Paste colors from a palette tool, then click one to put it in the slot you last touched (Accent).</p><textarea class="jds-textarea" aria-label="Paste palette">#2c5d8a #d39b3c #eef1f4 #1d2733 #b8664a</textarea>' +
    '<div class="staged"><button style="--sw:#2c5d8a" aria-label="Use #2c5d8a"></button><button style="--sw:#d39b3c" aria-label="Use #d39b3c"></button><button style="--sw:#eef1f4" aria-label="Use #eef1f4"></button><button style="--sw:#1d2733" aria-label="Use #1d2733"></button><button style="--sw:#b8664a" aria-label="Use #b8664a"></button></div></section>' +
    "</div>" +
    '<aside class="side"><div><h4 class="side__title">Preview</h4><div class="harbor" data-nav-scope style="--paper:#eef1f4;--bg:#eef1f4;--surface:#f8fafb;--text:#1d2733;--ink:#1d2733;--text-muted:#4d5a69;--border:#c9d1da;--border-subtle:#dde3ea;--forest:#2c5d8a;--accent:#2c5d8a;--accent-fg:#2c5d8a;--gold:#d39b3c;--hero-fg:#ffffff;--sage-light:#e3eaf2;--btn-primary-bg:#2c5d8a">' +
    previewMarkup() +
    "</div></div>" +
    '<div><h4 class="side__title">Can people read it?</h4><ul class="checks">' +
    '<li><span>Text on the page</span><span class="ok">Reads well, 13.9 to 1</span></li>' +
    '<li><span>Faint text on the page</span><span class="ok">Reads well, 4.6 to 1</span></li>' +
    '<li><span>Accent links on the page</span><span class="ok">Reads well, 6.2 to 1</span></li>' +
    '<li><span>Text on the Today band and buttons</span><span class="ok">Reads well, 6.9 to 1</span></li>' +
    '<li><span>Gold rules on the page</span><span class="low">Faint, 2.1 to 1. Aim for 3 to 1</span></li>' +
    "</ul></div></aside></div>" +
    '<div class="editor-foot"><span></span><div class="editor-foot__buttons"><button class="jds-btn jds-btn--quiet jds-btn--sm">Cancel</button><button class="jds-btn jds-btn--primary jds-btn--sm">Save changes</button></div></div></section>'
  );
}

function navStripMarkup() {
  return (
    '<span class="nav__brand"><svg class="nav__mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round">' +
    ICON.mark +
    "</svg>Moss</span>" +
    '<a class="nav__link is-active" href="#">' +
    svg("home") +
    "<span>Today</span></a>" +
    '<a class="nav__link" href="#">' +
    svg("tasks") +
    "<span>Tasks</span></a>" +
    '<a class="nav__link" href="#">' +
    svg("cal") +
    "<span>Calendar</span></a>" +
    ""
  );
}

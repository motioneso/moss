/* Shared mockup logic: the readable-nav rule, the nav markup, and the review bar. */

var ICON = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0 5 5L22 14l-8 8-2.3-2.3a4 4 0 0 0-5-5L2 10l8-8z"/>',
  tasks: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m8 12 3 3 5-6"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  news: '<path d="M4 5h13v14H6a2 2 0 0 1-2-2z"/><path d="M17 9h3v8a2 2 0 0 1-2 2"/><path d="M8 9h5M8 13h5"/>',
  trophy: '<path d="M8 4h8v6a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 14v4M8 20h8"/>',
  heart: '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  mark: '<path d="M3 7h10M3 12h16M3 17h7"/>'
};

function svg(name) {
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    ICON[name] +
    "</svg>"
  );
}

function navMarkup(opts) {
  opts = opts || {};
  var links = [
    ["home", "Today", true],
    ["wrench", "The Workshop"],
    ["label", "Plan"],
    ["tasks", "Tasks"],
    ["cal", "Calendar"],
    ["label", "Your world"],
    ["news", "News"],
    ["trophy", "Sports"],
    ["heart", "Wellness"]
  ];
  var html =
    '<div class="nav__brand"><svg class="nav__mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round">' +
    ICON.mark +
    "</svg>Moss</div><div class=\"nav__list\">";
  links.forEach(function (l) {
    if (l[0] === "label") html += '<p class="nav__label">' + l[1] + "</p>";
    else
      html +=
        '<a class="nav__link' + (l[2] ? " is-active" : "") + '" href="#">' + svg(l[0]) + "<span>" + l[1] + "</span></a>";
  });
  html += '</div><div class="nav__foot"><span class="nav__avatar">B</span>Ben</div>';
  return html;
}

/* ---- Colour maths (same rule the build will use) ---- */

function hexToRgb(hex) {
  var m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  var n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHex(c) {
  return (
    "#" +
    [c.r, c.g, c.b]
      .map(function (v) {
        return Math.round(v).toString(16).padStart(2, "0");
      })
      .join("")
  );
}
function mix(a, b, t) {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}
function lum(c) {
  var f = function (v) {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
function ratio(a, b) {
  var l1 = lum(a),
    l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

var DARK_TEXT = hexToRgb("#282c25"); /* light theme ink */
var LIGHT_TEXT = hexToRgb("#ede5d2"); /* bone, the text on every dark band */
var BLACK = hexToRgb("#000000");
var WHITE = hexToRgb("#ffffff");

/* Readable nav: pick dark or light text, whichever reads better on the ground. Quiet links
   mix toward the ground only as far as 4.5:1 allows. The selected item uses the accent pill
   when the accent stands out from the ground (3:1); otherwise a text-tinted wash. */
function deriveNav(groundHex, accentHex, accentLabelHex) {
  var bg = hexToRgb(groundHex);
  var fg = ratio(DARK_TEXT, bg) >= ratio(LIGHT_TEXT, bg) ? DARK_TEXT : LIGHT_TEXT;

  /* Mid-tones defeat both house text colors. Black or white always clears 4.5:1, so fall back. */
  var strong = false;
  if (ratio(fg, bg) < 4.5) {
    fg = ratio(BLACK, bg) >= ratio(WHITE, bg) ? BLACK : WHITE;
    strong = true;
  }
  var muted = fg;
  for (var t = 0.4; t >= 0; t -= 0.02) {
    var m = mix(fg, bg, t);
    if (ratio(m, bg) >= 4.5) {
      muted = m;
      break;
    }
  }
  var accent = hexToRgb(accentHex);
  var accentStands = ratio(accent, bg) >= 3;
  var out = {
    "--nv-bg": groundHex,
    "--nv-fg": rgbToHex(fg),
    "--nv-muted": rgbToHex(muted),
    "--nv-line": rgbToHex(mix(bg, fg, 0.2)),
    "--nv-hover": rgbToHex(mix(bg, fg, 0.08)),
    "--nv-active-bg": accentStands ? accentHex : rgbToHex(mix(bg, fg, 0.16)),
    "--nv-active-fg": accentStands ? accentLabelHex : rgbToHex(fg),
    "--nv-brand": ratio(accent, bg) >= 4.5 ? accentHex : rgbToHex(fg)
  };
  out.textRatio = ratio(fg, bg);
  out.mutedRatio = ratio(muted, bg);
  out.textKind = fg === DARK_TEXT || fg === BLACK ? "dark" : "light";
  out.strong = strong;
  out.activeKind = accentStands ? "accent" : "wash";
  return out;
}

function applyNav(scope, nav) {
  Object.keys(nav).forEach(function (k) {
    if (k.indexOf("--") === 0) scope.style.setProperty(k, nav[k]);
  });
}
function clearNav(scope) {
  ["--nv-bg", "--nv-fg", "--nv-muted", "--nv-line", "--nv-hover", "--nv-active-bg", "--nv-active-fg", "--nv-brand"].forEach(
    function (k) {
      scope.style.removeProperty(k);
    }
  );
}

/* The theme's own accent, read from the live tokens so park themes and dark mode count. */
function themeAccent() {
  var cs = getComputedStyle(document.documentElement);
  return { accent: cs.getPropertyValue("--forest").trim(), label: cs.getPropertyValue("--accent-label").trim() };
}

/* ---- Harbor, the custom theme being edited ---- */

/* A custom theme saves one set of colors and the app runs it in light mode, so its nav
   color is one value that belongs to the theme. */
var HARBOR = {
  "--paper": "#eef1f4", "--bg": "#eef1f4", "--surface": "#f8fafb", "--surface-2": "#e9eef3",
  "--ink": "#1d2733", "--text": "#1d2733", "--ink-2": "#4d5a69", "--text-muted": "#4d5a69",
  "--muted": "#4d5a69", "--ink-3": "#6b7684", "--text-faint": "#6b7684",
  "--line": "#c9d1da", "--border": "#c9d1da", "--border-subtle": "#dde3ea", "--border-strong": "#9aa6b3",
  "--forest": "#2c5d8a", "--accent": "#2c5d8a", "--accent-fg": "#2c5d8a", "--btn-primary-bg": "#2c5d8a",
  "--accent-label": "#ffffff", "--text-on-accent": "#ffffff", "--hero-fg": "#ffffff",
  "--gold": "#d39b3c", "--sage-light": "#dfe6ee", "--hover-tint": "rgb(44 93 138 / 0.08)"
};

/* Harbor's own nav when no nav color is chosen: its pale ground, ink text, accent pill. */
var HARBOR_DEFAULT_NAV = {
  "--nv-bg": "#dfe6ee", "--nv-fg": "#1d2733", "--nv-muted": "#4d5a69", "--nv-line": "#c9d1da",
  "--nv-hover": "#d0d9e3", "--nv-active-bg": "#2c5d8a", "--nv-active-fg": "#ffffff", "--nv-brand": "#2c5d8a"
};

function setVars(el, vars, on) {
  Object.keys(vars).forEach(function (k) {
    if (on) el.style.setProperty(k, vars[k]);
    else el.style.removeProperty(k);
  });
}

/* ---- Review bar ---- */

var NAV_CHOICES = [
  ["default", "Harbor default", null],
  ["accent", "Accent", "accent"],
  ["charcoal", "Charcoal", "#24221d"],
  ["butter", "Butter", "#f1e4b8"],
  ["navy", "Navy", "#1f2c44"],
  ["clay", "Clay", "#b8664a"]
];

var state = { mode: "light", theme: "harbor", nav: "navy" };

function readHash() {
  location.hash
    .replace(/^#/, "")
    .split("&")
    .forEach(function (kv) {
      var p = kv.split("=");
      if (p[0] in state && p[1] !== undefined) state[p[0]] = decodeURIComponent(p[1]);
    });
}

function navGround(choice) {
  var c = NAV_CHOICES.filter(function (x) {
    return x[0] === choice;
  })[0];
  if (!c || !c[2]) return null;
  if (c[2] === "accent") return HARBOR["--forest"];
  return c[2];
}

function render() {
  var root = document.documentElement;
  var harbor = state.theme === "harbor";
  root.setAttribute("data-color-mode", harbor ? "light" : state.mode);
  if (state.theme && !harbor) root.setAttribute("data-theme", state.theme);
  else root.removeAttribute("data-theme");
  root.classList.toggle("is-harbor", harbor);
  setVars(root, HARBOR, harbor);
  history.replaceState(null, "", "#mode=" + state.mode + "&theme=" + state.theme + "&nav=" + state.nav);

  /* The nav color belongs to Harbor: the editor always shows it, the app only while Harbor is applied. */
  var ground = navGround(state.nav);
  var nav = ground ? deriveNav(ground, HARBOR["--forest"], HARBOR["--accent-label"]) : HARBOR_DEFAULT_NAV;
  var scopes = Array.prototype.slice.call(document.querySelectorAll("[data-nav-scope]"));
  clearNav(root);
  if (harbor) scopes.push(root);
  scopes.forEach(function (el) {
    applyNav(el, nav);
  });
  root.style.setProperty("--harbor-nav", nav["--nv-bg"]);

  document.querySelectorAll("[data-theme-card]").forEach(function (c) {
    c.classList.toggle("is-current", c.dataset.themeCard === state.theme);
  });
  document.querySelectorAll("[data-pick]").forEach(function (b) {
    var p = b.dataset.pick.split(":");
    b.setAttribute("aria-pressed", String(state[p[0]] === p[1] && !(harbor && p[0] === "mode")));
    if (p[0] === "mode" && b.closest(".pane__card")) b.disabled = harbor;
  });
  document.querySelectorAll("[data-mode-desc]").forEach(function (el) {
    el.textContent = harbor
      ? "Built-in themes only. Your own themes keep their saved colors in light mode."
      : "Applies to every built-in theme.";
  });
  document.querySelectorAll("[data-navswatch]").forEach(function (b) {
    b.setAttribute("aria-checked", String(b.dataset.navswatch === state.nav));
  });
  document.querySelectorAll("[data-nav-hex]").forEach(function (el) {
    el.value = ground || "";
    el.placeholder = "Harbor default";
  });
  document.querySelectorAll("[data-nav-color]").forEach(function (el) {
    el.value = ground || HARBOR_DEFAULT_NAV["--nv-bg"];
  });
  document.querySelectorAll("[data-reset]").forEach(function (el) {
    el.disabled = state.nav === "default";
  });
  document.querySelectorAll("[data-readout]").forEach(function (el) {
    el.innerHTML = ground
      ? "Text and icons switch to <b>" +
        nav.textKind +
        "</b> on this color. Labels read at <b>" +
        nav.textRatio.toFixed(1) +
        " to 1</b>, quieter links at <b>" +
        nav.mutedRatio.toFixed(1) +
        " to 1</b>. Both clear the 4.5 to 1 floor." +
        (nav.strong
          ? " This is a middle tone, so Moss uses full " + (nav.textKind === "dark" ? "black" : "white") + " text."
          : "")
      : "Using Harbor's own pale nav, drawn from its page and accent colors.";
  });
  if (window.onRender) window.onRender(ground ? nav : null);
}

function bar(title, links) {
  var el = document.createElement("div");
  el.className = "mk-bar";
  var html = "<b>" + title + "</b>";
  html += '<span class="mk-group">Mode <button data-pick="mode:light">Light</button><button data-pick="mode:dark">Dark</button></span>';
  html +=
    '<span class="mk-group">Theme <button data-pick="theme:">Forest</button><button data-pick="theme:sage">Sage</button><button data-pick="theme:canyon">Canyon</button><button data-pick="theme:teal">Teal</button><button data-pick="theme:dusk">Dusk</button><button data-pick="theme:harbor">Harbor (yours)</button></span>';
  html += '<span class="mk-group">Harbor nav ';
  NAV_CHOICES.forEach(function (c) {
    html += '<button data-pick="nav:' + c[0] + '">' + c[1] + "</button>";
  });
  html += "</span>";
  html += '<span class="mk-group">' + links + "</span>";
  el.innerHTML = html;
  document.body.prepend(el);
  el.addEventListener("click", function (e) {
    var b = e.target.closest("[data-pick]");
    if (!b) return;
    var p = b.dataset.pick.split(":");
    state[p[0]] = p[1];
    render();
  });
  document.addEventListener("click", function (e) {
    var s = e.target.closest("[data-navswatch]");
    if (s) {
      state.nav = s.dataset.navswatch;
      render();
    }
    var r = e.target.closest("[data-reset]");
    if (r) {
      state.nav = "default";
      render();
    }
  });
}

function swatchesMarkup() {
  return NAV_CHOICES.map(function (c) {
    var bg = c[2] === "accent" ? HARBOR["--forest"] : c[2] || HARBOR_DEFAULT_NAV["--nv-bg"];
    return (
      '<button class="swatch" role="radio" data-navswatch="' +
      c[0] +
      '" style="--sw:' +
      bg +
      '"><span class="swatch__dot"></span>' +
      c[1] +
      "</button>"
    );
  }).join("");
}

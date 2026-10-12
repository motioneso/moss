const { JSDOM } = require(process.env.JSDOM_MODULE || "jsdom");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs
  .readFileSync(path.join(root, "app.js"), "utf8")
  .replace(
    /\}\)\(\);\s*$/,
    `globalThis.reviewTest={scenario,dispatch,render,go,set:v=>Object.assign(state,v),state:()=>JSON.parse(JSON.stringify(state)),fault:v=>{fault=v;}};})();`
  );
const results = [];
function setup(hash = "") {
  const dom = new JSDOM(html, {
    url: "https://review.example.test/" + hash,
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  const w = dom.window,
    d = w.document,
    calls = [];
  w.scrollTo = () => {};
  w.requestAnimationFrame = (fn) => fn();
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  for (const name of [
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "EventSource",
    "showDirectoryPicker",
    "showOpenFilePicker",
    "open"
  ])
    w[name] = () => {
      calls.push(name);
      throw new Error("External action forbidden");
    };
  for (const name of ["localStorage", "sessionStorage", "indexedDB"])
    Object.defineProperty(w, name, {
      get() {
        calls.push(name);
        throw new Error("Persistent storage forbidden");
      }
    });
  const errors = [];
  w.addEventListener("error", (e) => errors.push(e.error));
  w.eval(script);
  return {
    dom,
    w,
    d,
    t: w.reviewTest,
    calls,
    errors,
    text: () => d.querySelector("#app").textContent,
    click(selector) {
      const el = d.querySelector(selector);
      assert.ok(el, "Missing " + selector);
      assert.equal(el.disabled, false, "Disabled " + selector);
      el.click();
    },
    action(name) {
      this.click('[data-action="' + name + '"]');
    },
    field(id, value) {
      const el = d.getElementById(id);
      assert.ok(el, "Missing " + id);
      el.value = value;
      el.dispatchEvent(new w.Event("input", { bubbles: true }));
    },
    state() {
      return this.t.state();
    }
  };
}
function test(name, fn) {
  const s = setup();
  try {
    fn(s);
    assert.deepEqual(s.calls, []);
    assert.deepEqual(s.errors, []);
    results.push({ name, passed: true });
    console.log("PASS " + name);
  } catch (e) {
    results.push({ name, passed: false, error: e.message });
    console.error("FAIL " + name + ": " + e.message);
  } finally {
    s.dom.window.close();
  }
}
function prepare(s, route = "local", platform = "macos") {
  s.click('[data-install-route="' + route + '"]');
  s.action("next");
  if (route === "local") s.click('[data-host-platform="' + platform + '"]');
  s.action("install-check");
  s.action("install-notes");
  s.action("host-pick");
  s.action("host-picked");
  s.action("host-notes-next");
  assert.equal(s.state().account, false);
  s.action("install-start");
  assert.equal(s.state().protectedContinuation, false);
  s.action("install-health");
  assert.equal(s.state().account, false);
  s.action("install-continue");
}
for (const [route, platform] of [
  ["local", "macos"],
  ["local", "windows"],
  ["local", "linux"],
  ["remote", "linux"],
  ["manual", "linux"]
])
  test(route + " " + platform + ": notes before startup, health then browser account", (s) => {
    prepare(s, route, platform);
    assert.equal(s.state().step, 1);
    assert.equal(s.state().account, false);
    assert.equal(s.state().protectedContinuation, true);
    assert.equal(s.state().hostFolder, route === "local" ? "Documents / Notes" : "Notes");
    assert.equal(s.d.querySelectorAll(".setup-progress .step-link").length, 6);
    s.action("account");
    assert.equal(s.state().notes, "ready");
  });
test("Happy path, skipped optional setup, Today and returning to AI", (s) => {
  prepare(s);
  s.action("account");
  s.field("assistant-name", "Fern");
  s.action("personal-location");
  s.click('[data-city="london"]');
  s.action("personal");
  s.action("ai-connect");
  s.action("ai-approved");
  s.action("next");
  s.action("email-connect");
  s.action("email-approved");
  s.action("next");
  s.click('[data-topic="Technology"]');
  s.action("next");
  s.click('[data-team="Arsenal"]');
  s.action("next");
  assert.match(s.text(), /Your Fern/);
  assert.equal(s.state().accessMode, "local");
  s.action("finish");
  assert.equal(s.state().step, 9);
  assert.equal(s.state().accessMode, "local");
  s.t.scenario("skip-all");
  s.action("finish");
  s.action("today-start");
  assert.equal(s.state().step, 3);
});
test("All prototype menu fixtures render, with no credentials or external links", (s) => {
  s.click("#review-open");
  const ids = [...s.d.querySelectorAll("[data-scenario]")].map((x) => x.dataset.scenario);
  assert.equal(ids.length, 42);
  for (const id of ids) {
    s.t.scenario("fresh");
    s.t.scenario(id);
    assert.equal(s.d.querySelectorAll("#app h1").length, 1, id);
    assert.equal(
      s.d.querySelectorAll("input[type=password],input[type=email],input[type=file]").length,
      0,
      id
    );
    for (const a of s.d.querySelectorAll("a[href]"))
      assert.doesNotMatch(a.getAttribute("href"), /^https?:/);
  }
});
test("Fresh bootstrap gates cannot be skipped; existing LAN session remains allowed", (s) => {
  s.t.go(1);
  assert.equal(s.state().step, 0);
  for (const id of ["http", "unknown", "certificate"]) {
    s.t.scenario(id);
    s.t.go(1);
    assert.doesNotMatch(s.text(), /Create demo owner account/);
  }
  s.t.scenario("legacy-lan");
  assert.match(s.text(), /HTTP browser connection \(unencrypted\)/);
  s.action("finish");
  assert.equal(s.state().step, 9);
  assert.equal(s.state().accessMode, "lan-http");
});
test("Access is an optional subpanel with local default and no seventh stage", (s) => {
  s.t.scenario("happy");
  s.action("access-open");
  assert.equal(s.state().step, 8);
  assert.equal(s.d.querySelectorAll(".setup-progress .step-link").length, 6);
  assert.doesNotMatch(s.text(), /Revision proposal/);
  assert.equal(s.state().accessDraft, "local");
  s.action("access-review");
  assert.equal(s.state().accessPanel, "");
  assert.equal(s.state().accessMode, "local");
});
for (const mode of ["lan-http", "https"])
  test(mode + ": review → pending → failure → verified, same owner and instance", (s) => {
    s.t.scenario("happy");
    const identity = s.state().installIdentity;
    s.action("access-open");
    s.click('[data-access-mode="' + mode + '"]');
    if (mode === "lan-http") assert.match(s.text(), /read or change your passwords and content/);
    else assert.match(s.text(), /Recommended for other devices/);
    assert.equal(s.state().accessMode, "local");
    s.action("access-review");
    assert.equal(s.state().accessPanel, "plan");
    assert.match(s.text(), /interface|Bind/);
    assert.equal(s.state().account, true);
    s.action("access-apply");
    assert.equal(s.state().accessMode, "local");
    assert.equal(s.state().accessStatus, "pending");
    s.t.dispatch("access-fail");
    assert.equal(s.state().accessMode, "local");
    s.action("back");
    assert.equal(s.state().accessPanel, "");
    assert.equal(s.state().accessStatus, "failed");
    s.action("access-open");
    assert.equal(s.state().accessPanel, "verify");
    assert.equal(s.state().accessDraft, mode);
    s.action("access-verify");
    assert.equal(s.state().accessMode, mode);
    assert.equal(s.state().installIdentity, identity);
    assert.equal(s.state().account, true);
    assert.equal(s.state().accessPanel, "");
    assert.match(s.text(), new RegExp(mode === "https" ? "HTTPS" : "HTTP browser connection"));
  });
test("Cancel an unapplied plan and Get started never widen saved access", (s) => {
  s.t.scenario("legacy-lan");
  s.action("access-open");
  s.click('[data-access-mode="https"]');
  s.action("access-review");
  s.action("access-cancel");
  assert.equal(s.state().accessMode, "lan-http");
  s.action("finish");
  assert.equal(s.state().accessMode, "lan-http");
});
test("Access save failure and stale actions cannot fabricate readiness", (s) => {
  s.t.scenario("access-http");
  s.t.dispatch("access-verify");
  assert.equal(s.state().accessMode, "local");
  s.t.dispatch("access-apply");
  assert.equal(s.state().accessStatus, "idle");
  s.t.fault("save");
  s.action("access-review");
  assert.equal(s.state().accessPanel, "choose");
  s.t.fault("");
  s.action("access-review");
  s.t.fault("save");
  s.action("access-apply");
  assert.equal(s.state().accessPanel, "plan");
  s.t.fault("");
  s.action("access-apply");
  s.t.fault("save");
  s.action("access-verify");
  assert.equal(s.state().accessMode, "local");
  assert.equal(s.state().accessStatus, "pending");
});
test("HTTP browser and remote companion constraints stay distinct", (s) => {
  s.t.scenario("access-http");
  assert.match(
    s.text(),
    /Other devices on your home network can connect\. This connection isn’t encrypted\./
  );
  assert.match(
    s.text(),
    /Recommended for other devices\. Required for connecting the Mac companion\./
  );
  s.action("access-review");
  assert.match(s.text(), /The Mac companion requires HTTPS/);
});
test("Access copy is concise for fresh setup and retains the legacy reminder", (s) => {
  s.t.scenario("access-http");
  assert.equal(
    s.d.querySelector('[data-access-mode="lan-http"] small').textContent,
    "Other devices on your home network can connect. This connection isn’t encrypted."
  );
  assert.equal(
    s.d.querySelector('[data-access-mode="https"] small').textContent,
    "Recommended for other devices. Required for connecting the Mac companion."
  );
  assert.equal(
    s.d.querySelector(".status-note.warn p").textContent,
    "Other people or software on this network may be able to read or change your passwords and content. Some device features need HTTPS."
  );
  const currentAccess = () =>
    [...s.d.querySelectorAll("p.hint")].find((p) => p.textContent.startsWith("Current access:"))
      .textContent;
  assert.equal(currentAccess(), "Current access: This computer only.");
  assert.doesNotMatch(
    s.text(),
    /Existing deployments keep|A remote companion requires HTTPS; an ordinary browser/
  );
  assert.doesNotMatch(s.text(), /Revision proposal · visual review pending/);
  for (const [scenario, mode] of [
    ["legacy-lan", "Home network (HTTP, unencrypted)"],
    ["legacy-https", "HTTPS"]
  ]) {
    s.t.scenario(scenario);
    s.action("access-open");
    assert.equal(
      currentAccess(),
      `Current access: ${mode}. Your existing access stays as it is until you choose a change.`
    );
  }
});
test("Browser history, Close and same-tab restart preserve expected mock state", (s) => {
  s.t.scenario("access");
  s.w.dispatchEvent(
    new s.w.PopStateEvent("popstate", { state: { step: 8, accessPanel: "choose" } })
  );
  assert.match(s.text(), /Use Moss from other devices/);
  s.action("back");
  assert.equal(s.state().accessPanel, "");
  s.t.scenario("resume");
  const before = s.state();
  s.action("restart");
  assert.equal(s.state().notes, before.notes);
  s.t.scenario("fresh");
  s.action("sign-in");
  s.action("detail-close");
  assert.equal(s.d.querySelector("#detail-dialog").open, false);
  assert.equal(s.state().account, false);
});
test("Saved AI and notes survive replacement and provider catalogs are inert", (s) => {
  s.t.scenario("happy");
  s.click('[data-step="3"]');
  s.click('[data-provider="codex"]');
  assert.match(s.text(), /saved Claude connection remains ready/);
  s.action("registry-open");
  assert.equal(s.d.querySelectorAll("[data-registry-id]").length, 41);
  s.click('[data-registry-id="gemini"]');
  assert.match(s.text(), /Moss integration needed/);
  s.t.scenario("notes-readonly");
  s.action("notes-browse");
  s.click('[data-root="Personal vault"]');
  s.action("notes-use");
  assert.equal(s.state().notes, "ready");
});
test("Custom topics, save failure rollback, escaping and six-stage navigation", (s) => {
  s.t.scenario("news-ready");
  s.action("topic-open");
  s.field("topic-label", "Urban gardening");
  s.field("topic-guidance", "<script>example</script>");
  s.t.fault("save");
  s.action("topic-add");
  assert.equal(s.state().newsCustom.length, 0);
  s.t.fault("");
  s.action("topic-add");
  assert.equal(s.state().newsCustom.length, 1);
  assert.equal(s.d.querySelectorAll("#app script").length, 0);
});
test("Themes and reset are tab-local, not storage changes", (s) => {
  s.click("#review-open");
  for (const [id, value, key] of [
    ["review-theme", "teal", "theme"],
    ["review-mode", "dark", "colorMode"]
  ]) {
    const el = s.d.getElementById(id);
    el.value = value;
    el.dispatchEvent(new s.w.Event("change", { bubbles: true }));
    assert.equal(s.d.documentElement.dataset[key], value);
  }
  s.action("reset");
  s.action("confirm-reset");
  assert.equal(s.state().step, 0);
  assert.equal(s.state().theme, "forest");
});
test("Normal journey copy is product-facing across every review fixture", (s) => {
  const forbidden =
    /\b(?:prototype|demo|simulat(?:e|ed|ion)|revision proposal|illustrative|real installer|real product|real flow|this preview|this review|in the product)\b/i;
  const inspect = (name) => {
    const nodes = [
      s.d.querySelector(".site-header"),
      s.d.querySelector("#app"),
      s.d.querySelector(".site-footer")
    ].filter(Boolean);
    const text = [s.d.title, ...nodes.map((node) => node.textContent)].join(" ");
    assert.doesNotMatch(text, forbidden, name);
    assert.equal(s.d.querySelectorAll("#app .revision-note").length, 0, name);
  };
  s.click("#review-open");
  const fixtures = [...s.d.querySelectorAll("[data-scenario]")].map(
    (node) => node.dataset.scenario
  );
  s.click("#review-close");
  for (const id of fixtures) {
    s.t.scenario("fresh");
    s.t.scenario(id);
    inspect(id);
  }
  s.t.scenario("fresh");
  inspect("fresh route");
  for (const action of [
    "next",
    "install-check",
    "install-notes",
    "host-notes-skip",
    "install-start",
    "install-health",
    "install-continue",
    "account",
    "personal-location"
  ]) {
    s.action(action);
    inspect(action);
  }
  s.click('[data-city="london"]');
  for (const action of [
    "personal",
    "ai-connect",
    "ai-approved",
    "next",
    "email-connect",
    "email-approved",
    "next",
    "next",
    "next",
    "finish"
  ]) {
    s.action(action);
    inspect(action);
  }
  s.t.scenario("access-http");
  for (const action of ["access-review", "access-apply", "access-verify"]) {
    s.action(action);
    inspect(action);
  }
});
test("Normal detail dialogs omit design-review chatter and keep inert inputs", (s) => {
  const forbidden =
    /\b(?:prototype|demo|simulat(?:e|ed|ion)|revision proposal|illustrative|real installer|real product|real flow|this preview|this review|in the product)\b/i;
  for (const [fixture, action] of [
    ["fresh", "sign-in"],
    ["http", "host-local"],
    ["http", "remote-help"],
    ["install-missing", "docker-help"],
    ["manual-docker", "manual-template"],
    ["fresh", "host-pick"]
  ]) {
    s.t.scenario("fresh");
    s.t.scenario(fixture);
    s.t.dispatch(action);
    assert.doesNotMatch(s.d.querySelector("#detail-dialog").textContent, forbidden, action);
    assert.equal(
      s.d.querySelectorAll('input[type="password"],input[type="email"],input[type="file"]').length,
      0
    );
    s.t.dispatch("detail-close");
  }
  s.t.scenario("happy");
  s.t.go(2);
  s.action("personal-location");
  s.action("skip");
  assert.doesNotMatch(s.d.querySelector("#detail-dialog").textContent, forbidden, "location skip");
  assert.match(s.d.querySelector("#detail-dialog").textContent, /You can choose a city later\./);
});
test("Review context stays in discreet controls and genuine warnings remain", (s) => {
  assert.equal(s.d.querySelector("#review-open").getAttribute("aria-label"), "Review tools");
  assert.doesNotMatch(s.d.querySelector("#review-open").textContent, /prototype|review|demo/i);
  s.click("#review-open");
  assert.match(s.d.querySelector("#review-dialog").textContent, /inert|simulat|mock|demo/i);
  s.click("#review-close");
  s.t.scenario("access-http");
  assert.match(
    s.text(),
    /Other people or software on this network may be able to read or change your passwords and content\. Some device features need HTTPS\./
  );
  s.t.scenario("certificate");
  assert.match(s.text(), /Don’t bypass|Never bypass/);
  s.t.scenario("email-failed");
  assert.match(s.text(), /Gmail modify and Calendar/);
  assert.match(s.text(), /Sending email is a separate action/);
  s.t.scenario("access-http");
  s.action("access-review");
  s.action("access-apply");
  assert.equal(s.d.querySelector('#app [data-action="access-fail"]'), null);
  s.click("#review-open");
  s.action("review-access-fail");
  assert.equal(s.state().accessStatus, "failed");
  assert.equal(s.d.querySelector("#review-dialog").open, false);
});

for (const id of ["fresh", "access", "access-http", "access-https", "legacy-lan", "legacy-https"]) {
  const s = setup("#review=" + id);
  try {
    assert.equal(s.d.querySelectorAll("#app h1").length, 1);
    if (id.startsWith("access")) assert.match(s.text(), /Use Moss from other devices/);
    if (id === "legacy-lan") assert.equal(s.state().accessMode, "lan-http");
    assert.deepEqual(s.calls, []);
    assert.deepEqual(s.errors, []);
    results.push({ name: "Deep link " + id, passed: true });
    console.log("PASS deep link " + id);
  } catch (e) {
    results.push({ name: "Deep link " + id, passed: false, error: e.message });
    console.error("FAIL deep link " + id + ": " + e.message);
  } finally {
    s.dom.window.close();
  }
}
const failed = results.filter((x) => !x.passed);
console.log(
  JSON.stringify(
    {
      type: "Source/DOM interaction checks only; no browser rendering",
      passed: results.length - failed.length,
      total: results.length,
      failed
    },
    null,
    2
  )
);
if (failed.length) process.exitCode = 1;

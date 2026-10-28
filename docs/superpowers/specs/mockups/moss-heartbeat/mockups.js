/* global document, window, URLSearchParams */
// Local fixture interactions only. No API calls or persistent changes.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const params = new URLSearchParams(window.location.search);

function status(message) {
  const node = $(".mock-status");
  if (!node) return;
  node.textContent = message;
  clearTimeout(status.timer);
  status.timer = setTimeout(() => (node.textContent = ""), 3500);
}

const mode = params.get("mode");
if (mode) document.documentElement.dataset.colorMode = mode;
const park = params.get("park");
if (park) document.documentElement.dataset.theme = park;

$("[data-theme-toggle]")?.addEventListener("click", (event) => {
  const dark = document.documentElement.dataset.colorMode !== "dark";
  document.documentElement.dataset.colorMode = dark ? "dark" : "light";
  event.currentTarget.textContent = dark ? "Light" : "Dark";
});
$("[data-park-toggle]")?.addEventListener("click", (event) => {
  const canyon = document.documentElement.dataset.theme !== "canyon";
  document.documentElement.dataset.theme = canyon ? "canyon" : "forest";
  event.currentTarget.textContent = canyon ? "Canyon" : "Forest";
});
if (mode === "dark" && $("[data-theme-toggle]")) $("[data-theme-toggle]").textContent = "Light";

const defaults = JSON.parse(document.body.dataset.defaults || "{}");
const current = { ...defaults };
function apply() {
  for (const [key, value] of Object.entries(current)) {
    $$(`[data-${key}]`).forEach((node) => {
      node.hidden = !node.dataset[key].split(/\s+/).includes(value);
    });
    const select = $(`select[data-group="${key}"]`);
    if (select) select.value = value;
  }
  const phone = $("[data-phone-link]");
  if (phone) {
    const p = new URLSearchParams(current);
    phone.href = `phone.html?page=${encodeURIComponent(location.pathname.split("/").pop())}&${p}`;
  }
  const textarea = $("#main-input");
  if (textarea) {
    const concurrent = current.scene === "concurrent";
    textarea.value = concurrent ? "Also add lunch with Sam on Thursday" : "";
    if (concurrent && window.self === window.top) textarea.focus({ preventScroll: true });
  }
}
for (const key of Object.keys(defaults)) if (params.has(key)) current[key] = params.get(key);
$$("select[data-group]").forEach((select) =>
  select.addEventListener("change", () => {
    current[select.dataset.group] = select.value;
    apply();
  })
);
apply();

document.addEventListener("click", (event) => {
  const seg = event.target.closest(".jds-segmented__opt");
  if (seg && !seg.disabled) {
    $$(".jds-segmented__opt", seg.parentElement).forEach((b) =>
      b.setAttribute("aria-pressed", String(b === seg))
    );
  }
  const rate = event.target.closest("[data-rate]");
  if (rate && !rate.disabled) {
    const on = rate.getAttribute("aria-pressed") !== "true";
    $$("[data-rate]", rate.closest(".rate")).forEach((b) =>
      b.setAttribute("aria-pressed", "false")
    );
    rate.setAttribute("aria-pressed", String(on));
  }
  const remove = event.target.closest("[data-remove]");
  if (remove) {
    remove.closest(".set-row")?.remove();
    status("Preview: removed");
  }
});

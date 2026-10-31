// Pantry: items with optional amounts, Staples, and the phase 3 expiry, storage, restock, photo and history tools.
/* global window, document */

(function () {
  const A = window.MEALS_APP;
  const { F, S, h, btn, iconBtn, badge, eyebrow, caption, segmented } = A;
  const { empty, loading, recovery, field, input, select, check, toggle, dialog, typing } = A;

  S.pantryGroup = "section";
  S.pantryUndo = null;
  S.pantryHistory = structuredClone(F.later.history);
  S.restock = structuredClone(F.later.restock);
  S.staplesWhenLow = true;
  S.photoReading = false;
  S.photoItems = [
    { id: "fp1", name: "Baby spinach", qty: "1", unit: "bag", include: true },
    { id: "fp2", name: "Cheddar", qty: "8", unit: "oz", include: true },
    { id: "fp3", name: "Butter", qty: "1", unit: "lb", include: true },
    { id: "fp4", name: "Ketchup", qty: "", unit: "", include: true },
    { id: "fp5", name: "Turkey chilli", qty: "2", unit: "portions", include: true },
    { id: "fp6", name: "Sparkling water", qty: "6", unit: "can", include: false }
  ];

  const aiOff = () => A.reviewState() === "ai-off";
  const later = () => A.phase() >= 3;

  const SECTION_ORDER = ["Leftovers", "Produce", "Meat and fish", "Dairy and eggs", "Bakery", "Pantry", "Frozen", "Other"];
  const STORAGE_ORDER = ["Fridge", "Freezer", "Cupboard", "Counter"];
  const RESTOCK_EVERY = ["Weekly", "Every 2 weeks", "Every 4 weeks"];

  // ---------- Amounts and dates ----------

  const FRACTIONS = { 0.25: "¼", 0.33: "⅓", 0.5: "½", 0.67: "⅔", 0.75: "¾" };
  const PLURALS = { can: "cans", bag: "bags", head: "heads", bunch: "bunches", jar: "jars", loaf: "loaves", tub: "tubs", portion: "portions" };

  const fmtQty = (n) => {
    const whole = Math.floor(n);
    const frac = FRACTIONS[Math.round((n - whole) * 100) / 100];
    if (frac) return whole ? `${whole}${frac}` : frac;
    return String(Math.round(n * 100) / 100);
  };

  const amountText = (item) => {
    if (item.qty == null) return "";
    const unit = item.qty !== 1 && PLURALS[item.unit] ? PLURALS[item.unit] : item.unit;
    return `${fmtQty(item.qty)}${unit ? ` ${unit}` : ""}`;
  };

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const daysUntil = (label) => {
    const [mon, day] = label.split(" ");
    const target = Date.UTC(2026, MONTHS.indexOf(mon), Number(day));
    const [y, m, d] = F.TODAY.split("-").map(Number);
    return Math.round((target - Date.UTC(y, m - 1, d)) / 86400000);
  };

  const expiry = (item) => (later() ? item.useBy || F.later.expiry[item.id] || "" : "");
  const storage = (item) => item.storage || F.later.storage[item.id] || (item.section === "Frozen" ? "Freezer" : "Cupboard");

  const SOURCE = { bought: "Bought", receipt: "From a receipt", manual: "Added", leftover: "Cooked", photo: "From a fridge photo" };
  const sourceText = (item) => `${SOURCE[item.source] || "Added"} ${item.updated}`;

  const useByBadge = (item) => {
    const label = expiry(item);
    if (!label) return "";
    const days = daysUntil(label);
    if (days < 0) return badge(`Past ${label}`, "red", { icon: "circle-alert" });
    if (days <= 2) return badge(days === 0 ? "Use today" : days === 1 ? "Use by tomorrow" : `Use by ${label}`, "amber", { icon: "clock" });
    return caption(`Use by ${label}`);
  };

  const soonItems = () =>
    S.data.pantry
      .filter((p) => expiry(p) && daysUntil(expiry(p)) <= 3)
      .sort((a, b) => daysUntil(expiry(a)) - daysUntil(expiry(b)));

  // ---------- Item rows ----------

  const itemView = (item) => {
    const amount = amountText(item);
    const tags = [];
    if (later() && S.pantryGroup === "section") tags.push(badge(storage(item), "neutral", { icon: storage(item) === "Freezer" ? "snowflake" : undefined }));
    const useBy = useByBadge(item);
    if (useBy) tags.push(useBy);
    return h`
      <li class="mls-line mls-line--plain" data-pantry-name="${item.name.toLowerCase()}">
        <span class="mls-line__body">
          <span class="mls-line__name">${item.name}</span>
          ${caption(sourceText(item))}
          ${tags.length ? h`<span class="mls-row">${tags}</span>` : ""}
        </span>
        <span class="mls-line__amount">${amount ? h`<span class="mls-num">${amount}</span>` : caption("Some")}</span>
        <span class="mls-line__tools">
          ${iconBtn("pencil", `Edit ${item.name}`, { href: A.hrefFor(`pantry/edit/${item.id}`) })}
          ${iconBtn("trash-2", `Remove ${item.name}`, { action: "pantry-remove", data: { item: item.id } })}
        </span>
      </li>`;
  };

  const groupView = (name, items) => {
    if (!items.length) return "";
    return h`
      <section class="mls-section" aria-label="${name}" data-pantry-group>
        <div class="mls-block-head">
          <h3 class="jds-card-title">${name}</h3>
          ${caption(String(items.length))}
        </div>
        <ul class="mls-list" role="list">${items.map(itemView)}</ul>
      </section>`;
  };

  const groups = () => {
    const items = S.data.pantry;
    if (later() && S.pantryGroup === "storage") {
      const leftovers = items.filter((p) => p.section === "Leftovers");
      return [
        ["Leftovers", leftovers],
        ...STORAGE_ORDER.map((place) => [place, items.filter((p) => p.section !== "Leftovers" && storage(p) === place)])
      ];
    }
    return SECTION_ORDER.map((name) => [name, items.filter((p) => p.section === name)]);
  };

  // ---------- Page ----------

  const pantryBar = () => {
    const count = S.data.pantry.length;
    return h`
      <div class="mls-planbar">
        <div class="mls-find">
          ${input({ id: "pp-find", sm: true, placeholder: "Find an item", ariaLabel: "Find an item", data: { find: "pantry" } })}
          <span class="jds-caption"><strong class="mls-num">${count}</strong> ${count === 1 ? "item" : "items"}</span>
        </div>
        <div class="mls-row">
          ${
            later()
              ? segmented(
                  [
                    { value: "section", label: "Sections" },
                    { value: "storage", label: "Where it's kept" }
                  ],
                  S.pantryGroup,
                  { label: "Group the Pantry", action: "pantry-group" }
                )
              : ""
          }
          ${later() ? btn("History", { icon: "history", href: A.hrefFor("pantry/history"), size: "sm" }) : ""}
          ${later() ? btn("Photograph the fridge", { icon: "camera", href: A.hrefFor("pantry/photo"), disabled: aiOff(), size: "sm" }) : ""}
          <span class="mls-hide-phone">${btn("Add item", { variant: "primary", icon: "plus", href: A.hrefFor("pantry/add") })}</span>
        </div>
      </div>`;
  };

  const rail = () => {
    const staples = S.data.staples;
    const soon = soonItems();
    return h`
      <aside class="mls-rail">
        ${
          later()
            ? h`<section class="mls-stack mls-stack--tight">
                ${eyebrow("Use soon")}
                ${
                  soon.length
                    ? h`<ul class="mls-list mls-stack mls-stack--tiny" role="list">
                        ${soon.map((p) => h`<li class="mls-row mls-row--between"><span>${p.name}</span>${caption(daysUntil(expiry(p)) <= 0 ? "Today" : expiry(p))}</li>`)}
                      </ul>`
                    : caption("Nothing runs out this week.")
                }
              </section>`
            : ""
        }
        <section class="mls-stack mls-stack--tight">
          ${eyebrow("Staples")}
          <ul class="mls-list mls-stack mls-stack--tiny" role="list">
            ${staples.map(
              (s) => h`<li class="mls-row mls-row--between"><span>${s.name}</span>${s.onHand ? caption("In the Pantry") : badge("On the list", "neutral", { icon: "shopping-basket" })}</li>`
            )}
          </ul>
          ${btn("Edit Staples", { variant: "link", size: "sm", href: A.hrefFor("pantry/staples") })}
        </section>
        ${
          later()
            ? h`<section class="mls-stack mls-stack--tight">
                ${eyebrow("Restock")}
                ${
                  S.restock.length
                    ? h`<ul class="mls-list mls-stack mls-stack--tiny" role="list">
                        ${S.restock.map((r) => h`<li class="mls-row mls-row--between"><span>${r.name}</span>${caption(r.every)}</li>`)}
                      </ul>`
                    : caption("No restock items.")
                }
                ${btn("Edit restock items", { variant: "link", size: "sm", href: A.hrefFor("pantry/restock") })}
              </section>`
            : ""
        }
      </aside>`;
  };

  const renderPantry = () => {
    const state = A.reviewState();
    if (state === "loading") return A.page("pantry", loading("Loading the Pantry"));
    if (state === "error")
      return A.page(
        "pantry",
        recovery({
          title: "Couldn't load the Pantry",
          msg: "Check the connection, then try again.",
          actions: btn("Try again", { size: "sm", icon: "refresh-cw", href: A.hrefFor("pantry", { state: "ready" }) })
        })
      );
    if (state === "empty" || !S.data.pantry.length)
      return A.page(
        "pantry",
        empty({
          icon: "package",
          title: "The Pantry is empty",
          action: h`
            ${btn("Add item", { variant: "primary", icon: "plus", href: A.hrefFor("pantry/add") })}
            ${later() ? btn("Photograph the fridge", { icon: "camera", href: A.hrefFor("pantry/photo"), disabled: aiOff() }) : ""}
            ${btn("Paste a receipt", { icon: "receipt", href: A.hrefFor("list/receipt"), disabled: aiOff() })}`
        })
      );

    return A.page(
      "pantry",
      h`
      ${pantryBar()}
      <div class="mls-grid">
        <div class="mls-stack">
          ${groups().map(([name, items]) => groupView(name, items))}
          <div class="jds-empty" data-pantry-nomatch hidden>
            <div class="jds-empty__title">No item matches</div>
          </div>
        </div>
        ${rail()}
      </div>
      <div class="mls-sticky">
        ${btn("Add item", { variant: "primary", icon: "plus", href: A.hrefFor("pantry/add") })}
      </div>`
    );
  };

  // ---------- Item dialog ----------

  const sectionOptions = () => SECTION_ORDER.map((s) => ({ value: s, label: s }));
  const storageOptions = () => STORAGE_ORDER.map((s) => ({ value: s, label: s }));

  const itemForm = (item) => h`
    <div class="mls-form">
      ${field("Item", input({ id: "pf-name", value: item?.name, placeholder: "Basmati rice" }), { id: "pf-name" })}
      <div class="mls-form-grid">
        ${field("Amount", input({ id: "pf-qty", value: item?.qty ?? "", placeholder: "Optional", num: true, inputmode: "decimal" }), { id: "pf-qty" })}
        ${field("Unit", input({ id: "pf-unit", value: item?.unit, placeholder: "lb, can, bag" }), { id: "pf-unit" })}
      </div>
      ${field("Section", select(sectionOptions(), item?.section || "Pantry", { id: "pf-section" }), { id: "pf-section" })}
      ${
        later()
          ? h`<div class="mls-form-grid">
              ${field("Kept in", select(storageOptions(), item ? storage(item) : "Cupboard", { id: "pf-storage" }), { id: "pf-storage" })}
              ${field("Use by", input({ id: "pf-useby", value: item ? expiry(item) : "", placeholder: "Nov 12" }), { id: "pf-useby" })}
            </div>`
          : ""
      }
    </div>`;

  const addDialog = () =>
    dialog({
      title: "Add to the Pantry",
      body: itemForm(null),
      foot: h`${btn("Cancel", { action: "close-dialog" })}${btn("Add", { variant: "primary", icon: "plus", action: "pantry-add" })}`
    });

  const editDialog = ({ itemId }) => {
    const item = S.data.pantry.find((p) => p.id === itemId);
    if (!item)
      return dialog({
        title: "Item not found",
        body: caption("It may have been used up or removed."),
        foot: btn("Close", { action: "close-dialog" })
      });
    return dialog({
      title: `Edit ${item.name}`,
      body: itemForm(item),
      foot: h`
        <span class="mls-foot-start">${btn("Remove", { variant: "quiet", icon: "trash-2", action: "pantry-remove", data: { item: item.id } })}</span>
        ${btn("Cancel", { action: "close-dialog" })}
        ${btn("Save", { variant: "primary", action: "pantry-save", data: { item: item.id } })}`
    });
  };

  // ---------- Staples and restock ----------

  const staplesDialog = () =>
    dialog({
      title: "Staples",
      wide: true,
      body: h`
        <div class="mls-stack">
          ${
            S.data.staples.length
              ? h`<ul class="mls-list" role="list">
                  ${S.data.staples.map(
                    (s) => h`
                      <li class="mls-line mls-line--plain">
                        <span class="mls-line__body">
                          <span class="mls-line__name">${s.name}</span>
                          <span class="mls-row">${s.onHand ? caption("In the Pantry") : badge("On the list", "neutral", { icon: "shopping-basket" })}</span>
                        </span>
                        <span class="mls-line__amount">${input({ value: s.target || "", sm: true, placeholder: "Buy amount", ariaLabel: `Buy amount for ${s.name}`, data: { staple: s.id, action: "staple-target" } })}</span>
                        <span class="mls-line__tools">${iconBtn("x", `Stop keeping ${s.name}`, { action: "staple-remove", data: { staple: s.id } })}</span>
                      </li>`
                  )}
                </ul>`
              : caption("No Staples yet.")
          }
          <div class="mls-inline-add">
            ${input({ id: "ps-new", placeholder: "Add a Staple", ariaLabel: "New Staple" })}
            ${btn("Add", { icon: "plus", action: "staple-add" })}
          </div>
          ${later() ? toggle("Add to the list when running low", S.staplesWhenLow, { action: "staples-when-low" }) : ""}
        </div>`,
      foot: btn("Done", { variant: "primary", action: "close-dialog" })
    });

  const restockDialog = () =>
    dialog({
      title: "Restock items",
      wide: true,
      body: h`
        <div class="mls-stack">
          ${
            S.restock.length
              ? h`<ul class="mls-list" role="list">
                  ${S.restock.map(
                    (r, i) => h`
                      <li class="mls-line mls-line--plain">
                        <span class="mls-line__body"><span class="mls-line__name">${r.name}</span></span>
                        <span class="mls-line__amount">${select(RESTOCK_EVERY, r.every, { ariaLabel: `How often to buy ${r.name}`, action: "restock-every", data: { index: i } })}</span>
                        <span class="mls-line__tools">${iconBtn("x", `Stop restocking ${r.name}`, { action: "restock-remove", data: { index: i } })}</span>
                      </li>`
                  )}
                </ul>`
              : caption("No restock items yet.")
          }
          <div class="mls-inline-add">
            ${input({ id: "pr-new", placeholder: "Coffee beans", ariaLabel: "New restock item" })}
            ${btn("Add", { icon: "plus", action: "restock-add" })}
          </div>
        </div>`,
      foot: btn("Done", { variant: "primary", action: "close-dialog" })
    });

  // ---------- Fridge photo ----------

  const photoDialog = () =>
    dialog({
      title: "Photograph the fridge",
      wide: true,
      body: h`
        <div class="mls-stack">
          ${aiOff() ? recovery({ title: "Moss can't read photos right now", msg: "The AI provider is not answering.", role: "status" }) : ""}
          ${
            S.photoReading
              ? h`<div class="mls-dropzone" role="status">${typing()}${caption("Finding food in the photo")}</div>`
              : h`<div class="mls-dropzone">
                  ${A.icon("refrigerator", 28)}
                  ${btn("Choose a photo", { variant: "primary", icon: "camera", action: "pantry-photo-read", disabled: aiOff() })}
                  ${caption("One shelf at a time reads best.")}
                </div>`
          }
        </div>`,
      foot: btn("Cancel", { action: "close-dialog" })
    });

  const photoReviewDialog = () => {
    const take = S.photoItems.filter((i) => i.include).length;
    return dialog({
      title: "Check before the Pantry changes",
      desc: `${S.photoItems.length} things found, kept in the fridge`,
      wide: true,
      body: h`
        <div class="mls-table-scroll">
          <div class="mls-receipt">
            <span></span>${eyebrow("Item")}${eyebrow("Amount")}${eyebrow("Unit")}
            ${S.photoItems.map(
              (it) => h`
                ${check("", it.include, { action: "pantry-photo-take", data: { item: it.id }, ariaLabel: `Add ${it.name}` })}
                ${input({ value: it.name, sm: true, ariaLabel: "Item", disabled: !it.include })}
                ${input({ value: it.qty, sm: true, num: true, placeholder: "Some", ariaLabel: `Amount of ${it.name}`, disabled: !it.include })}
                ${input({ value: it.unit, sm: true, ariaLabel: `Unit of ${it.name}`, disabled: !it.include })}`
            )}
          </div>
        </div>`,
      foot: h`${btn("Back", { variant: "quiet", icon: "chevron-left", href: A.hrefFor("pantry/photo") })}${btn(take ? `Add ${take} to the Pantry` : "Add to the Pantry", { variant: "primary", icon: "package", action: "pantry-photo-save", disabled: !take })}`
    });
  };

  // ---------- History ----------

  const historyDialog = () =>
    dialog({
      title: "Pantry history",
      wide: true,
      body: S.pantryHistory.length
        ? h`<ul class="mls-list" role="list">
            ${S.pantryHistory.map(
              (e, i) => h`
                <li class="mls-line mls-line--plain">
                  <span class="mls-line__body">
                    <span class="mls-line__name">${e.what}</span>
                    ${caption(e.change)}
                  </span>
                  <span class="mls-line__amount">${caption(e.when)}</span>
                  <span class="mls-line__tools">
                    ${e.undone ? badge("Undone", "neutral") : btn("Undo", { size: "sm", variant: "quiet", icon: "undo-2", action: "pantry-history-undo", data: { index: i } })}
                  </span>
                </li>`
            )}
          </ul>`
        : caption("No changes yet."),
      foot: btn("Done", { variant: "primary", action: "close-dialog" })
    });

  // ---------- Routes ----------

  const base = () => "pantry";

  A.route("pantry", { render: renderPantry, sample: "pantry", label: "Pantry" });
  A.route("pantry/add", { page: base, dialog: addDialog, sample: "pantry/add", label: "Pantry: add item" });
  A.route("pantry/edit/:itemId", { page: base, dialog: editDialog, sample: "pantry/edit/pi1", label: "Pantry: edit an item" });
  A.route("pantry/staples", { page: base, dialog: staplesDialog, sample: "pantry/staples", label: "Pantry: Staples" });
  A.route("pantry/restock", { page: base, dialog: restockDialog, sample: "pantry/restock", label: "Pantry: restock items", phase: 3 });
  A.route("pantry/history", { page: base, dialog: historyDialog, sample: "pantry/history", label: "Pantry: history and undo", phase: 3 });
  A.route("pantry/photo", {
    page: base,
    dialog: photoDialog,
    sample: "pantry/photo",
    label: "Pantry: photograph the fridge",
    phase: 3,
    enter: () => {
      S.photoReading = false;
    }
  });
  A.route("pantry/photo/review", { page: base, dialog: photoReviewDialog, sample: "pantry/photo/review", label: "Pantry: check a fridge photo", phase: 3 });

  // ---------- Find ----------

  // Filters rows in place so the field keeps focus while typing.
  document.addEventListener("input", (event) => {
    if (event.target.dataset.find !== "pantry") return;
    const q = event.target.value.trim().toLowerCase();
    let shown = 0;
    document.querySelectorAll("[data-pantry-group]").forEach((group) => {
      let groupShown = 0;
      group.querySelectorAll("[data-pantry-name]").forEach((row) => {
        const hit = !q || row.dataset.pantryName.includes(q);
        row.hidden = !hit;
        if (hit) groupShown += 1;
      });
      group.hidden = groupShown === 0;
      shown += groupShown;
    });
    const none = document.querySelector("[data-pantry-nomatch]");
    if (none) none.hidden = shown > 0;
  });

  // ---------- Actions ----------

  const value = (id) => document.getElementById(id)?.value.trim() || "";

  const record = (what, change) => {
    S.pantryHistory.unshift({ when: "Just now", what, change, snapshot: structuredClone(S.data.pantry) });
  };

  const readForm = () => {
    const qtyText = value("pf-qty");
    const qty = qtyText === "" ? null : Number(qtyText);
    const fields = { name: value("pf-name"), qty: Number.isFinite(qty) ? qty : null, unit: value("pf-unit"), section: value("pf-section") || "Pantry" };
    if (later()) Object.assign(fields, { storage: value("pf-storage"), useBy: value("pf-useby") });
    return fields;
  };

  Object.assign(A.actions, {
    "pantry-group": (el) => {
      S.pantryGroup = el.dataset.value;
      A.render();
    },
    "pantry-add": () => {
      const fields = readForm();
      if (!fields.name) {
        document.getElementById("pf-name").focus();
        return;
      }
      const before = structuredClone(S.data.pantry);
      S.data.pantry.push({ id: `pi-${Date.now()}`, ...fields, source: "manual", updated: "just now" });
      S.pantryHistory.unshift({ when: "Just now", what: `Added ${fields.name}`, change: amountText(fields) || "No amount", snapshot: before });
      A.toast(`${fields.name} added.`, { icon: "plus" });
      A.go("pantry");
    },
    "pantry-save": (el) => {
      const item = S.data.pantry.find((p) => p.id === el.dataset.item);
      const fields = readForm();
      record(`Edited ${item.name}`, amountText(fields) || "No amount");
      Object.assign(item, fields, { name: fields.name || item.name, updated: "just now" });
      A.go("pantry");
    },
    "pantry-remove": (el) => {
      const item = S.data.pantry.find((p) => p.id === el.dataset.item);
      S.pantryUndo = structuredClone(S.data.pantry);
      record(`Removed ${item.name}`, amountText(item) || "No amount");
      S.data.pantry = S.data.pantry.filter((p) => p.id !== item.id);
      A.toast(`${item.name} removed.`, { icon: "trash-2", tone: "drift", undo: "pantry-undo", ms: 7000 });
      A.go("pantry");
    },
    "pantry-undo": () => {
      if (!S.pantryUndo) return;
      S.data.pantry = S.pantryUndo;
      S.pantryUndo = null;
      S.pantryHistory.shift();
      A.toast("Put back.", { icon: "undo-2", tone: "drift" });
      A.render();
    },
    "pantry-history-undo": (el) => {
      const entry = S.pantryHistory[Number(el.dataset.index)];
      if (entry.snapshot) S.data.pantry = structuredClone(entry.snapshot);
      entry.undone = true;
      A.toast(`Undid "${entry.what}".`, { icon: "undo-2", tone: "drift" });
      A.render();
    },
    "staple-target": (el) => {
      S.data.staples.find((s) => s.id === el.dataset.staple).target = el.value.trim() || null;
    },
    "staple-remove": (el) => {
      S.data.staples = S.data.staples.filter((s) => s.id !== el.dataset.staple);
      A.render();
    },
    "staple-add": () => {
      const name = value("ps-new");
      if (!name) {
        document.getElementById("ps-new").focus();
        return;
      }
      S.data.staples.push({ id: `s-${Date.now()}`, name, target: null, onHand: Boolean(A.onHand(name)) });
      A.render();
      document.getElementById("ps-new")?.focus();
    },
    "staples-when-low": (el) => {
      S.staplesWhenLow = el.checked;
    },
    "restock-every": (el) => {
      S.restock[Number(el.dataset.index)].every = el.value;
    },
    "restock-remove": (el) => {
      S.restock.splice(Number(el.dataset.index), 1);
      A.render();
    },
    "restock-add": () => {
      const name = value("pr-new");
      if (!name) {
        document.getElementById("pr-new").focus();
        return;
      }
      S.restock.push({ name, every: "Weekly" });
      A.render();
      document.getElementById("pr-new")?.focus();
    },
    "pantry-photo-read": () => {
      S.photoReading = true;
      A.render();
      setTimeout(() => {
        S.photoReading = false;
        if (A.current().path === "pantry/photo") A.go("pantry/photo/review");
      }, 1400);
    },
    "pantry-photo-take": (el) => {
      S.photoItems.find((i) => i.id === el.dataset.item).include = el.checked;
      A.render();
    },
    "pantry-photo-save": () => {
      const rows = [...document.querySelectorAll(".mls-receipt .jds-input")];
      S.photoItems.forEach((it, i) => {
        const [name, qty, unit] = rows.slice(i * 3, i * 3 + 3).map((r) => r.value.trim());
        Object.assign(it, { name, qty, unit });
      });
      const take = S.photoItems.filter((i) => i.include);
      const before = structuredClone(S.data.pantry);
      take.forEach((it) => {
        const leftover = it.unit === "portions";
        S.data.pantry.push({
          id: `pi-${Date.now()}-${it.id}`,
          name: it.name,
          qty: it.qty === "" ? null : Number(it.qty),
          unit: it.unit,
          section: leftover ? "Leftovers" : "Other",
          storage: "Fridge",
          source: "photo",
          updated: "just now"
        });
      });
      S.pantryHistory.unshift({ when: "Just now", what: "Fridge photo", change: `${take.length} items added`, snapshot: before });
      A.toast(`${take.length} items added to the Pantry.`, { title: "Photo read", icon: "camera" });
      A.go("pantry");
    }
  });
})();

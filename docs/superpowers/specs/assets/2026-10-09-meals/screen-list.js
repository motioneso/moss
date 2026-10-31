// Shopping list: sections, merged lines with their meals, Staples, ticking, Bought and receipts.
/* global window, document */

(function () {
  const A = window.MEALS_APP;
  const { F, S, h, btn, iconBtn, badge, eyebrow, caption, segmented } = A;
  const { empty, loading, recovery, field, input, textarea, select, check, dialog, typing } = A;

  S.listOrder = "sections";
  S.bought = null;
  S.boughtUndo = null;
  S.receiptText = F.receiptText;
  S.receiptReading = false;
  S.receiptItems = structuredClone(F.receiptItems);

  const aiOff = () => A.reviewState() === "ai-off";

  // Phase 4: aisle order learned from the order lines get ticked.
  const STORE_ORDER = ["Produce", "Bakery", "Meat and fish", "Dairy and eggs", "Frozen", "Pantry", "Other"];

  // Phase 3 lines: weight to count, a low Staple and a restock item.
  const laterLines = () =>
    A.phase() >= 3
      ? [
          {
            id: "l-onion",
            name: "Yellow onions",
            need: "300 g",
            buy: "2 onions",
            section: "Produce",
            sources: ["Roast chicken with root vegetables"],
            convertedFrom: "300 g is about 2 onions"
          },
          { id: "l-milk", name: "Milk", need: "", buy: "1 gal", section: "Dairy and eggs", sources: [], staple: true, low: true },
          { id: "l-yog", name: "Greek yoghurt", need: "", buy: "32 oz", section: "Dairy and eggs", sources: [], restock: "Weekly" }
        ]
      : [];

  const lines = () => [...S.data.list, ...laterLines().filter((l) => !S.data.list.some((x) => x.id === l.id))];
  const ticked = () => lines().filter((l) => l.checked);
  const findLine = (id) => lines().find((l) => l.id === id);

  // ---------- Line ----------

  const lineTags = (l) => {
    const tags = [];
    if (l.staple) tags.push(badge(l.low ? "Staple, running low" : "Staple", "neutral"));
    if (l.restock) tags.push(badge(l.restock, "neutral", { icon: "refresh-cw" }));
    if (l.manual) tags.push(badge("Added", "neutral"));
    if (l.changed === "New") tags.push(badge("New", "pine"));
    if (l.unconvertible)
      tags.push(h`<span title="Cups do not convert to how the Pantry holds this, so it stays on its own line.">${badge("Own line", "outline", { icon: "info" })}</span>`);
    if (l.checkLabel)
      tags.push(h`<span title="Moss suggested a brand. Check its label against everyone's restrictions.">${badge("Check the label", "outline", { icon: "info" })}</span>`);
    return tags;
  };

  // The name and amount are labels for the tick box, so the whole row ticks.
  const lineView = (l) => {
    const tags = lineTags(l);
    const meta = l.sources.length ? `For ${l.sources.join(", ")}` : l.convertedFrom || "";
    const tick = `tick-${l.id}`;
    return h`
      <li class="mls-line${l.checked ? " mls-line--done" : ""}">
        ${check("", l.checked, { id: tick, action: "list-tick", data: { line: l.id }, ariaLabel: `Got ${l.name}` })}
        <label class="mls-line__body" for="${tick}">
          <span class="mls-line__name">${l.name}</span>
          ${meta ? caption(meta) : ""}
          ${l.convertedFrom && l.sources.length ? caption(l.convertedFrom) : ""}
          ${l.changed && l.changed !== "New" ? caption(l.changed) : ""}
          ${tags.length ? h`<span class="mls-row">${tags}</span>` : ""}
        </label>
        <label class="mls-line__amount" for="${tick}">
          <span class="mls-num">${l.buy}</span>
          ${l.was ? caption(`Was ${l.was}`) : l.need && l.need !== l.buy ? caption(`Needs ${l.need}`) : ""}
        </label>
        <span class="mls-line__tools">
          ${iconBtn("pencil", `Edit ${l.name}`, { href: A.hrefFor(`list/edit/${l.id}`) })}
          ${l.manual ? iconBtn("trash-2", `Delete ${l.name}`, { action: "list-delete", data: { line: l.id } }) : ""}
        </span>
      </li>`;
  };

  const sectionView = (name, items) => {
    if (!items.length) return "";
    const done = items.filter((l) => l.checked).length;
    return h`
      <section class="mls-section" aria-label="${name}">
        <div class="mls-block-head">
          <h3 class="jds-card-title">${name}</h3>
          ${caption(done ? `${done} of ${items.length}` : String(items.length))}
        </div>
        <ul class="mls-list mls-list--shop" role="list">${items.map(lineView)}</ul>
      </section>`;
  };

  // What this week's meals need that the Pantry already holds, so nothing drops off silently.
  const haveLines = () => {
    const seen = new Map();
    for (const day of S.data.plan.days) {
      if (A.isPast(day.date)) continue;
      for (const m of day.meals) {
        if (m.kind !== "recipe" || m.cooked) continue;
        const r = A.recipe(m.recipeId);
        for (const i of r.ingredients) {
          const p = A.onHand(i.name);
          if (!p || lines().some((l) => l.name.toLowerCase() === i.name.toLowerCase())) continue;
          const row = seen.get(p.id) || { item: p, sources: [] };
          if (!row.sources.includes(r.title)) row.sources.push(r.title);
          seen.set(p.id, row);
        }
      }
    }
    return [...seen.values()];
  };

  const pantryAmount = (p) => (p.qty == null ? "Some" : `${Math.round(p.qty * 100) / 100}${p.unit ? ` ${p.unit}` : ""}`);

  const haveView = () => {
    const rows = haveLines();
    if (!rows.length) return "";
    return h`
      <section class="mls-section" aria-label="You have this">
        <div class="mls-block-head">
          <h3 class="jds-card-title">You have this</h3>
          ${caption(String(rows.length))}
        </div>
        <ul class="mls-list" role="list">
          ${rows.map(
            ({ item, sources }) => h`
              <li class="mls-line mls-line--plain">
                <span class="mls-line__body">
                  <span class="mls-line__name">${item.name}</span>
                  ${caption(`For ${sources.join(", ")}`)}
                </span>
                <span class="mls-line__amount">
                  <span class="mls-num">${pantryAmount(item)}</span>
                  ${caption("In the Pantry")}
                </span>
                <span class="mls-line__tools">
                  ${btn("Need more", { size: "sm", variant: "quiet", icon: "plus", action: "list-have-add", data: { item: item.id } })}
                </span>
              </li>`
          )}
        </ul>
      </section>`;
  };

  // ---------- Page ----------

  const listBar = () => {
    const all = lines();
    const done = ticked().length;
    const pct = all.length ? Math.round((done / all.length) * 100) : 0;
    return h`
      <div class="mls-planbar">
        <div class="mls-progress">
          <span class="jds-caption"><strong class="mls-num">${done}</strong> of ${all.length} got</span>
          <div class="jds-progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Shopping progress">
            <div class="jds-progress__fill" style="width: ${pct}%"></div>
          </div>
          <span></span>
        </div>
        <div class="mls-row mls-hide-phone">
          ${
            A.phase() >= 4
              ? segmented(
                  [
                    { value: "sections", label: "Sections" },
                    { value: "store", label: "Store order" }
                  ],
                  S.listOrder,
                  { label: "List order", action: "list-order" }
                )
              : ""
          }
          ${btn("Add item", { icon: "plus", href: A.hrefFor("list/add") })}
          ${btn("Bought", { variant: "primary", icon: "check", href: A.hrefFor("list/bought") })}
        </div>
      </div>`;
  };

  const rail = () => {
    const missing = S.data.staples.filter((s) => !s.onHand);
    const budget = F.later.budget;
    return h`
      <aside class="mls-rail">
        ${
          A.phase() >= 3
            ? h`<section class="mls-stack mls-stack--tight">
                ${eyebrow("Shopped without the list")}
                <div class="mls-stack mls-stack--tight">
                  ${btn("Paste a receipt", { icon: "receipt", href: A.hrefFor("list/receipt"), disabled: aiOff(), block: true })}
                  <span class="mls-row">${btn("Photograph a receipt", { icon: "camera", disabled: true, size: "sm" })}${badge("Coming later", "neutral")}</span>
                </div>
              </section>`
            : ""
        }
        <section class="mls-stack mls-stack--tight">
          ${eyebrow("Staples on the list")}
          ${
            missing.length
              ? h`<ul class="mls-list mls-stack mls-stack--tiny" role="list">${missing.map((s) => h`<li class="jds-caption">${s.name}${s.target ? `, ${s.target}` : ""}</li>`)}</ul>`
              : caption("Every Staple is in the Pantry.")
          }
          ${btn("Edit Staples", { variant: "link", size: "sm", href: A.hrefFor("pantry/staples") })}
        </section>
        ${
          A.phase() >= 4
            ? h`<section class="mls-stack mls-stack--tight">
                ${eyebrow("Budget")}
                <span class="mls-num">$${budget.estimate} of $${budget.weekly}</span>
                <div class="jds-progress" role="progressbar" aria-valuenow="${Math.round((budget.estimate / budget.weekly) * 100)}" aria-valuemin="0" aria-valuemax="100" aria-label="Budget used">
                  <div class="jds-progress__fill" style="width: ${Math.round((budget.estimate / budget.weekly) * 100)}%"></div>
                </div>
              </section>`
            : ""
        }
      </aside>`;
  };

  const renderList = () => {
    const state = A.reviewState();
    if (state === "loading") return A.page("list", loading("Loading the shopping list"));
    if (state === "error")
      return A.page(
        "list",
        recovery({
          title: "Couldn't load the shopping list",
          msg: "Check the connection, then try again.",
          actions: btn("Try again", { size: "sm", icon: "refresh-cw", href: A.hrefFor("list", { state: "ready" }) })
        })
      );
    if (state === "empty" || !lines().length)
      return A.page(
        "list",
        empty({
          icon: "shopping-basket",
          title: "Nothing to buy",
          action: h`${btn("Add item", { variant: "primary", icon: "plus", href: A.hrefFor("list/add") })}${A.phase() >= 3 ? btn("Paste a receipt", { icon: "receipt", href: A.hrefFor("list/receipt"), disabled: aiOff() }) : ""}`
        })
      );

    const order = A.phase() >= 4 && S.listOrder === "store" ? STORE_ORDER : F.sections;
    const all = lines();
    return A.page(
      "list",
      h`
      ${listBar()}
      <div class="mls-grid">
        <div class="mls-stack">
          ${order.map((name) => sectionView(name, all.filter((l) => l.section === name)))}
          ${haveView()}
        </div>
        ${rail()}
      </div>
      <div class="mls-sticky">
        ${btn("Add item", { icon: "plus", href: A.hrefFor("list/add") })}
        ${btn(`Bought${ticked().length ? ` (${ticked().length})` : ""}`, { variant: "primary", icon: "check", href: A.hrefFor("list/bought") })}
      </div>`
    );
  };

  // ---------- Dialogs ----------

  const sectionOptions = () => F.sections.map((s) => ({ value: s, label: s }));

  const addDialog = () =>
    dialog({
      title: "Add to the list",
      body: h`
        <div class="mls-form">
          ${field("Item", input({ id: "la-name", placeholder: "Dish soap" }), { id: "la-name" })}
          <div class="mls-form-grid">
            ${field("Amount", input({ id: "la-amount", placeholder: "Optional" }), { id: "la-amount" })}
            ${field("Section", select(sectionOptions(), "Other", { id: "la-section" }), { id: "la-section" })}
          </div>
        </div>`,
      foot: h`${btn("Cancel", { action: "close-dialog" })}${btn("Add", { variant: "primary", icon: "plus", action: "list-add" })}`
    });

  const editDialog = ({ lineId }) => {
    const l = findLine(lineId);
    if (!l) return "";
    return dialog({
      title: `Edit ${l.name}`,
      desc: l.sources.length ? `For ${l.sources.join(", ")}` : "",
      body: h`
        <div class="mls-form">
          ${field("Item", input({ id: "le-name", value: l.name }), { id: "le-name" })}
          <div class="mls-form-grid">
            ${field("Amount to buy", input({ id: "le-amount", value: l.buy }), { id: "le-amount", hint: l.need && l.need !== l.buy ? `Recipes need ${l.need}` : "" })}
            ${field("Section", select(sectionOptions(), l.section, { id: "le-section" }), { id: "le-section" })}
          </div>
        </div>`,
      foot: h`
        ${l.manual ? btn("Delete", { variant: "danger", icon: "trash-2", action: "list-delete", data: { line: l.id } }) : ""}
        ${btn("Cancel", { action: "close-dialog" })}
        ${btn("Save", { variant: "primary", action: "list-edit-save", data: { line: l.id } })}`
    });
  };

  // Ticked lines lead because they are what was bought; the rest can still be picked.
  const boughtGroup = (name, items) =>
    items.length
      ? h`
        <section class="mls-stack mls-stack--tiny" aria-label="${name}">
          ${eyebrow(name)}
          <ul class="mls-list" role="list">
            ${items.map((l) => {
              const b = S.bought[l.id] || { take: false, amount: l.buy };
              return h`
                <li class="mls-line">
                  ${check("", b.take, { action: "list-bought-take", data: { line: l.id }, ariaLabel: `Bought ${l.name}` })}
                  <span class="mls-line__body"><span class="mls-line__name">${l.name}</span>${caption(l.section)}</span>
                  <span class="mls-line__amount">${input({ value: b.amount, sm: true, ariaLabel: `Amount of ${l.name}`, disabled: !b.take, data: { line: l.id, action: "list-bought-amount" } })}</span>
                  <span></span>
                </li>`;
            })}
          </ul>
        </section>`
      : "";

  const boughtDialog = () => {
    if (!S.bought) S.bought = Object.fromEntries(lines().map((l) => [l.id, { take: l.checked, amount: l.buy }]));
    const chosen = Object.values(S.bought).filter((b) => b.take).length;
    return dialog({
      title: "Bought",
      wide: true,
      body: h`
        <div class="mls-stack">
          ${boughtGroup("Ticked", lines().filter((l) => l.checked))}
          ${boughtGroup("Not ticked", lines().filter((l) => !l.checked))}
        </div>`,
      foot: h`${btn("Cancel", { action: "list-bought-cancel" })}${btn(chosen ? `Move ${chosen} to the Pantry` : "Move to the Pantry", { variant: "primary", icon: "package", action: "list-bought-save", disabled: !chosen })}`
    });
  };

  const receiptDialog = () =>
    dialog({
      title: "Paste a receipt",
      wide: true,
      body: h`
        <div class="mls-stack">
          ${
            aiOff()
              ? recovery({ title: "Moss can't read receipts right now", msg: "The AI provider is not answering.", role: "status" })
              : ""
          }
          ${field("Receipt text", textarea({ id: "lr-text", rows: 10, value: S.receiptText, placeholder: "Paste the text of a receipt or an order email", disabled: S.receiptReading }), { id: "lr-text" })}
          ${S.receiptReading ? h`<p class="mls-row" role="status">${typing()}${caption("Reading the receipt")}</p>` : ""}
          <div class="mls-row">
            ${btn("Photograph instead", { icon: "camera", disabled: true, size: "sm" })}
            ${badge("Coming later", "neutral")}
          </div>
        </div>`,
      foot: h`${btn("Cancel", { action: "close-dialog" })}${btn("Read receipt", { variant: "primary", icon: "receipt", action: "list-receipt-read", disabled: aiOff() || S.receiptReading })}`
    });

  const receiptReviewDialog = () => {
    const take = S.receiptItems.filter((i) => i.include).length;
    return dialog({
      title: "Check before the Pantry changes",
      desc: "Trader Joe's, 9 lines read",
      wide: true,
      body: h`
        <div class="mls-table-scroll">
          <div class="mls-receipt">
            <span></span>${eyebrow("Item")}${eyebrow("Amount")}${eyebrow("Unit")}
            ${S.receiptItems.map(
              (it) => h`
                ${check("", it.include, { action: "list-receipt-take", data: { item: it.id }, ariaLabel: `Add ${it.name}` })}
                ${input({ value: it.name, sm: true, ariaLabel: "Item", disabled: !it.include })}
                ${input({ value: it.qty, sm: true, num: true, ariaLabel: `Amount of ${it.name}`, disabled: !it.include })}
                ${input({ value: it.unit, sm: true, ariaLabel: `Unit of ${it.name}`, disabled: !it.include })}`
            )}
          </div>
        </div>`,
      foot: h`${btn("Back", { variant: "quiet", icon: "chevron-left", href: A.hrefFor("list/receipt") })}${btn(take ? `Add ${take} to the Pantry` : "Add to the Pantry", { variant: "primary", icon: "package", action: "list-receipt-save", disabled: !take })}`
    });
  };

  // ---------- Routes ----------

  const base = () => "list";

  A.route("list", { render: renderList, sample: "list", label: "Shopping list" });
  A.route("list/add", { page: base, dialog: addDialog, sample: "list/add", label: "Shopping list: add item" });
  A.route("list/edit/:lineId", { page: base, dialog: editDialog, sample: "list/edit/l1", label: "Shopping list: edit a line" });
  A.route("list/bought", { page: base, dialog: boughtDialog, sample: "list/bought", label: "Shopping list: bought" });
  A.route("list/receipt", {
    page: base,
    dialog: receiptDialog,
    sample: "list/receipt",
    label: "Shopping list: paste a receipt",
    phase: 3,
    enter: () => {
      S.receiptReading = false;
    }
  });
  A.route("list/receipt/review", { page: base, dialog: receiptReviewDialog, sample: "list/receipt/review", label: "Shopping list: check a receipt", phase: 3 });

  // ---------- Actions ----------

  const value = (id) => document.getElementById(id)?.value.trim() || "";
  const leadingQty = (text) => {
    const m = /^(\d+(?:\.\d+)?)\s*(.*)$/.exec(text || "");
    return m ? { qty: Number(m[1]), unit: m[2].replace(/^×\s*/, "") } : { qty: null, unit: "" };
  };

  // Bought and receipt lines land in the Pantry, merged by name where an item exists.
  const intoPantry = (name, amountText, section) => {
    const existing = A.onHand(name);
    const { qty, unit } = leadingQty(amountText);
    if (existing) {
      if (existing.qty != null && qty != null && existing.unit === unit) existing.qty += qty;
      existing.updated = "just now";
      existing.source = "bought";
      return;
    }
    S.data.pantry.push({ id: `pi-${Date.now()}-${S.data.pantry.length}`, name, qty, unit, section: section || "Other", source: "bought", updated: "just now" });
  };

  Object.assign(A.actions, {
    "list-tick": (el) => {
      const l = findLine(el.dataset.line);
      l.checked = el.checked;
      if (!S.data.list.includes(l)) S.data.list.push(l);
      A.render();
      if (l.checked) A.toast(`Got ${l.name}.`, { icon: "check", undo: "list-tick-undo", ms: 5000 });
      S.lastTick = l.checked ? l.id : null;
    },
    "list-tick-undo": () => {
      const l = S.lastTick && findLine(S.lastTick);
      if (!l) return;
      l.checked = false;
      S.lastTick = null;
      document.getElementById("toast-root").innerHTML = "";
      A.render();
    },
    "list-have-add": (el) => {
      const p = S.data.pantry.find((x) => x.id === el.dataset.item);
      S.data.list.push({ id: `lh-${p.id}`, name: p.name, need: "", buy: "1", section: F.sections.includes(p.section) ? p.section : "Other", sources: [], manual: true, staple: false, checked: false });
      A.toast(`${p.name} added.`, { icon: "plus" });
      A.render();
    },
    "list-order": (el) => {
      S.listOrder = el.dataset.value;
      A.render();
    },
    "list-add": () => {
      const name = value("la-name");
      if (!name) {
        document.getElementById("la-name").focus();
        return;
      }
      S.data.list.push({ id: `l-${Date.now()}`, name, need: "", buy: value("la-amount") || "1", section: value("la-section") || "Other", sources: [], manual: true, staple: false, checked: false });
      A.toast(`${name} added.`, { icon: "plus" });
      A.go("list");
    },
    "list-edit-save": (el) => {
      const l = findLine(el.dataset.line);
      Object.assign(l, { name: value("le-name") || l.name, buy: value("le-amount") || l.buy, section: value("le-section") || l.section });
      if (!S.data.list.includes(l)) S.data.list.push(l);
      A.go("list");
    },
    "list-delete": (el) => {
      const l = findLine(el.dataset.line);
      S.data.list = S.data.list.filter((x) => x.id !== l.id);
      A.toast(`${l.name} deleted.`, { icon: "trash-2", tone: "drift" });
      A.go("list");
    },
    "list-bought-take": (el) => {
      S.bought[el.dataset.line].take = el.checked;
      A.render();
    },
    "list-bought-cancel": () => {
      S.bought = null;
      A.closeDialog();
    },
    "list-bought-save": () => {
      document.querySelectorAll("[data-action='list-bought-amount']").forEach((inp) => {
        if (S.bought[inp.dataset.line]) S.bought[inp.dataset.line].amount = inp.value;
      });
      S.boughtUndo = { list: structuredClone(S.data.list), pantry: structuredClone(S.data.pantry) };
      const moved = lines().filter((l) => S.bought[l.id]?.take);
      moved.forEach((l) => intoPantry(l.name, S.bought[l.id].amount, l.section));
      S.data.list = S.data.list.filter((l) => !S.bought[l.id]?.take);
      S.bought = null;
      A.toast(`${moved.length} ${moved.length === 1 ? "item" : "items"} moved to the Pantry.`, { title: "Bought", icon: "package", undo: "list-bought-undo", ms: 7000 });
      A.go("list");
    },
    "list-bought-undo": () => {
      if (!S.boughtUndo) return;
      S.data.list = S.boughtUndo.list;
      S.data.pantry = S.boughtUndo.pantry;
      S.boughtUndo = null;
      A.toast("Restored the list and the Pantry.", { icon: "undo-2", tone: "drift" });
      A.render();
    },
    "list-receipt-read": () => {
      S.receiptText = value("lr-text");
      S.receiptReading = true;
      A.render();
      setTimeout(() => {
        S.receiptReading = false;
        if (A.current().path === "list/receipt") A.go("list/receipt/review");
      }, 1400);
    },
    "list-receipt-take": (el) => {
      S.receiptItems.find((i) => i.id === el.dataset.item).include = el.checked;
      A.render();
    },
    "list-receipt-save": () => {
      const rows = [...document.querySelectorAll(".mls-receipt .jds-input")];
      const take = S.receiptItems.filter((i) => i.include);
      S.receiptItems.forEach((it, i) => {
        const [name, qty, unit] = rows.slice(i * 3, i * 3 + 3).map((r) => r.value.trim());
        Object.assign(it, { name, qty, unit });
      });
      take.forEach((it) => intoPantry(it.name, `${it.qty} ${it.unit}`.trim(), "Other"));
      let matched = 0;
      lines().forEach((l) => {
        if (!l.checked && take.some((it) => it.name.toLowerCase().includes(l.name.toLowerCase()) || l.name.toLowerCase().includes(it.name.toLowerCase()))) {
          l.checked = true;
          matched += 1;
        }
      });
      A.toast(`${take.length} items added to the Pantry.${matched ? ` ${matched} list lines ticked.` : ""}`, { title: "Receipt read", icon: "receipt" });
      A.go("list");
    }
  });
})();

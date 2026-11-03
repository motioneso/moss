"""Builds mockups 07 to 10 (strip and attention list) from the Budget pages' frame.

Run from the repository root: python3 docs/superpowers/specs/finance-redesign/build-attention.py
Made-up names and amounts only.
"""
import re
from pathlib import Path

D = Path(__file__).parent
CHEV_L = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>'
CHEV_R = CHEV_L.replace("m15 18-6-6 6-6", "m9 18 6-6-6-6")


def btn(label, kind="secondary", extra=""):
    return f'<button type="button" class="jds-btn jds-btn--{kind} jds-btn--sm"{extra}>{label}</button>'


def badge(text, tone):
    return f'<span class="jds-badge jds-badge--{tone}">{text}</span>'


def row(what, sub, acts, tone=None, label=None, done=False):
    b = badge(label, tone) if label else ""
    cls = "attn-row attn-row--done" if done else "attn-row"
    return (
        f'<div class="{cls}"><div class="attn-row__text"><div class="attn-row__what">{b}<span>{what}</span></div>'
        f'<span class="attn-row__sub">{sub}</span></div><div class="attn-row__acts">{acts}</div></div>'
    )


def attention(rows, more=0, phone=False):
    head = (
        '<div class="rail-head"><span class="jds-eyebrow jds-eyebrow--strong jds-eyebrow--gold">Needs your attention</span>'
        f'<div class="jds-section-head jds-section-head--rule"><h2 class="jds-section-head__title">{len(rows) + more} things</h2></div></div>'
    )
    tail = f'<div class="attn-more">{btn(f"Show {more} more", "ghost")}</div>' if more else ""
    cls = "stack stack--tight attn-phone" if phone else "stack stack--tight"
    return f'<section class="{cls}">{head}<div class="{'attn-list' if not phone else ''}">{"".join(rows)}</div>{tail}</section>'


def tile(label, value, sub, warn=False):
    w = " jds-stat-tile--warn" if warn else ""
    return (
        f'<div class="jds-stat-tile{w}"><div class="jds-stat-tile__label">{label}</div>'
        f'<div class="jds-stat-tile__value">{value}</div><span class="tile-sub">{sub}</span></div>'
    )


def strip(tiles, phone=False):
    cls = "strip strip--phone" if phone else "strip"
    return (
        '<section class="stack stack--tight"><div class="rail-head"><span class="jds-eyebrow jds-eyebrow--strong jds-eyebrow--gold">This month</span>'
        '<div class="jds-section-head jds-section-head--rule"><h2 class="jds-section-head__title">October 2026</h2></div></div>'
        f'<div class="{cls}">{"".join(tiles)}</div></section>'
    )


def hero(ready, short):
    lede = "" if short else '<p class="jds-masthead__lede">Not in a category yet</p>'
    return (
        '<div class="hero' + (" hero--phone" if short else "") + '"><header class="jds-masthead jds-masthead--field"><div class="jds-masthead__row">'
        f'<div class="jds-masthead__main"><p class="jds-masthead__eyebrow">Ready to assign</p><h1 class="jds-masthead__title"><span>{ready}</span></h1>{lede}</div>'
        '<div class="jds-masthead__aside"><div class="hero-act">'
        + btn("Assign", "field", ' aria-label="Assign the ready money"')
        + '<div class="row month-step"><button type="button" class="jds-btn jds-btn--field jds-btn--sm" aria-label="September">'
        + CHEV_L
        + '</button><span>October 2026</span><button type="button" class="jds-btn jds-btn--field jds-btn--sm" aria-label="November">'
        + CHEV_R
        + "</button></div></div></div></div></header></div>"
    )


def balances_rail(src):
    m = re.search(r'<section class="stack stack--tight"><div class="rail-head"><span[^>]*>Accounts</span>.*?</section>', src)
    return m.group(0)


def groups_main(src):
    m = re.search(r"<main class=\"stack\">(.*)</main>", src, re.S).group(1)
    # Drop the old "Needs you" tiles; the attention list replaces them.
    return re.sub(r'^<section class="stack stack--tight"><div class="rail-head"><span[^>]*>Needs you</span>.*?</section>', "", m, count=1)


def page(base, title, hero_html, top, phone):
    src = (D / base).read_text()
    head = src[: src.index('<div class="hero')]
    tail_start = src.index('</div></div></div></body>') if not phone else src.index("</div></div></body>")
    groups = groups_main(src)
    rail = "" if phone else f'<aside class="stack stack--rail">{balances_rail(src)}</aside>'
    page_cls = "page page--phone" if phone else "page"
    top_cls = "page page--phone" if phone else "page page--single"
    body = (
        f'{hero_html}<div class="{top_cls}"><div class="stack">{top}</div></div>'
        f'<div class="{page_cls}"><main class="stack">{groups}</main>{rail}</div>'
    )
    out = head + body + src[tail_start:]
    out = out.replace("Budget (desktop)", title).replace("Budget (phone)", title)
    out = out.replace('<link rel="stylesheet" href="frame.css">', '<link rel="stylesheet" href="frame.css"><link rel="stylesheet" href="attention.css">')
    return out


# Made-up rows. Each state is a list of (tiles, rows, more).
def b_water(done=False):
    if done:
        return row("Harbor Water, $48.40", "Matched to Oct 8 payment", btn("Undo", "ghost"), done=True)
    return row("Harbor Water, $48.40", "Due Fri Oct 10. Posted Oct 8 at Harbor Checking", btn("Match $48.40") + btn("Open", "ghost"), "amber", "Bill")


def b_insurance(late=False):
    return row(
        "Car insurance, $210.00",
        "Due Tue Oct 14" if not late else "Was due Mon Oct 6. Nothing posted",
        btn("Record payment") + btn("Skip", "ghost"),
        "red" if late else "neutral",
        "Past due" if late else "Bill",
    )


def over(name, amt, src):
    return row(f"{name} is over by {amt}", f"{src} has the most left", btn(f"Cover from {src}") + btn("Pick another", "ghost"), "red", "Overspent")


def look(n=3):
    return row(
        f"{n} predicted categories" if n > 1 else "Copperline Coffee, $6.75",
        "Copperline Coffee, City Transit, Kestrel Hardware" if n == 3 else "Predicted: Dining out",
        btn(f"Confirm all {n}" if n > 1 else "Confirm") + btn("Review", "ghost"),
        "amber",
        "Predicted",
    )


STATES = {
    "07-attention-normal": (
        "Attention, normal",
        [tile("Spent", "$2,913.13", "of $3,572.00 assigned"), tile("Left to spend", "$698.87", "across 7 categories"),
         tile("Bills due", "$258.40", "2 bills, next Fri Oct 10"), tile("Overspent", "None", "0 categories")],
        [b_water(), b_insurance(), look()], 0, "$420.79",
    ),
    "08-attention-overspent": (
        "Attention, overspent",
        [tile("Spent", "$2,913.13", "of $3,572.00 assigned"), tile("Left to spend", "$685.37", "across 6 categories"),
         tile("Bills due", "$258.40", "2 bills, next Fri Oct 10"), tile("Overspent", "−$26.50", "Dining out", warn=True)],
        [over("Dining out", "$26.50", "Hobbies"), b_water(), b_insurance(), look()], 0, "$420.79",
    ),
    "09-attention-many": (
        "Attention, many items",
        [tile("Spent", "$2,913.13", "of $3,572.00 assigned"), tile("Left to spend", "$412.08", "across 6 categories"),
         tile("Bills due", "$1,106.90", "5 bills, 1 past due"), tile("Overspent", "−$212.75", "3 categories, Dining out most", warn=True)],
        [b_insurance(True), over("Dining out", "$126.50", "Hobbies"), over("Groceries", "$61.40", "Household"), b_water(True), b_water()], 6, "$420.79",
    ),
    "10-attention-empty": (
        "Attention, empty",
        [tile("Spent", "$2,913.13", "of $3,572.00 assigned"), tile("Left to spend", "$698.87", "across 7 categories"),
         tile("Bills due", "$0.00", "0 bills"), tile("Overspent", "None", "0 categories")],
        [], 0, "$0.00",
    ),
}

links = []
for sid, (title, tiles, rows, more, ready) in STATES.items():
    for phone in (False, True):
        s = strip(tiles, phone)
        top = (attention(rows, more, phone) if rows else "") + s
        base = "01-budget-phone.html" if phone else "01-budget-desktop.html"
        html = page(base, f"{title} ({'phone' if phone else 'desktop'})", hero(ready, phone), top, phone)
        (D / f"{sid}-{'phone' if phone else 'desktop'}.html").write_text(html)
    links.append((sid, title))

rows_html = "".join(
    f'<div class="jds-index__row"><div class="jds-index__title">{t}</div><div class="jds-index__meta"><div class="row">'
    f'<a href="{s}-desktop.html" class="jds-btn jds-btn--secondary jds-btn--sm">Desktop</a>'
    f'<a href="{s}-phone.html" class="jds-btn jds-btn--secondary jds-btn--sm">Phone</a></div></div></div>'
    for s, t in links
)
(D / "attention.html").write_text(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    '<title>Attention · Finance mockup</title><link rel="stylesheet" href="moss-ui.css"><link rel="stylesheet" href="p6.css">'
    '<link rel="stylesheet" href="frame.css"></head><body><div class="index stack"><header class="jds-masthead"><div class="jds-masthead__row">'
    '<div class="jds-masthead__main"><p class="jds-masthead__eyebrow">Cards 351 and 356</p><h1 class="jds-masthead__title"><span>This month and Needs your attention</span></h1>'
    '<p class="jds-masthead__lede">Desktop (1440) and phone (390). All names and amounts are made up.</p></div></div></header>'
    f'<div class="jds-index">{rows_html}</div></div></body></html>\n'
)
print("Built", len(STATES) * 2, "screens.")

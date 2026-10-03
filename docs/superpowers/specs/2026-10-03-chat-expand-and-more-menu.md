# Docked chat: expand button and "more" menu (#2952)

Status: approved by impeccable design review on 2026-10-03 (delegated by Ben), with the changes below folded in.

## Scope

- Desktop docked chat only (window 721px and wider where chat is docked).
- Phone drawer is unchanged. No expand button there.

## Header

Docked order, left to right: mark and name, New chat, Expand (Collapse when expanded), More, Close.

More menu items:

| Item               | Behaviour                                                                        |
| ------------------ | -------------------------------------------------------------------------------- |
| History            | Toggles the history list. Reads "Hide history" while open.                       |
| Start private chat | Toggles private chat. Reads "Leave private chat" while on. Default surface only. |

The menu reuses the existing `Menu` primitive in `@moss/ui` (Escape and outside click close it, focus returns to the trigger).

## Expanded behaviour

- The page header and page body are hidden. Left navigation stays.
- Chat fills the main area to the window height, flush against the window edge and the left navigation: square corners, no border or shadow, no card.
- Reading column is 960px at 1440 wide and about 850px at 1280 (the lesser of 960px and 78% of the area), with 16px minimum side padding. Header text, cards and message box share the same two edges.
- Header text, suggestion cards, thread and message box share the same left and right edges. The header buttons stay pinned to the window's right edge.
- The left navigation's highlighted item is dimmed while expanded.
- The chat stays mounted, so unsent text survives expand and collapse.
- Close while expanded closes chat and resets to docked for next open.

## Open points and recommendations

| Point                                 | Recommendation                                                    | Why                                                                                                               |
| ------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Phone                                 | Desktop only; hide the button on phone widths.                    | The drawer already fills the screen.                                                                              |
| Remember across reloads               | No. Always reopen docked.                                         | Expanded hides the page; reopening into it after a reload is surprising. Revisit if asked.                        |
| Width use                             | Centred 820px reading column, full-bleed background and dividers. | Long lines hurt reading; the "use horizontal space" ruling is met by the full-width surface, not full-width text. |
| Click another nav item while expanded | Navigate and collapse to docked, so the new page is visible.      | Staying expanded would hide the page the user just chose. Unsent text is kept.                                    |

## Review changes folded in

1. The round button at the bottom right of the dev screen is the dev-only note-taking toolbar, not part of the product, so nothing in the product covers the send button. No change needed.
2. Expanded edges line up (checked on the live page, equal to the pixel).
3. Expanded has no card, rounded corner or shadow.
4. The More button looks like the other header buttons, with a box only on hover or while open.
5. Menu icons are 18px, the same as the header icons.

## Screens (local, not committed)

`/tmp/design-chat-expand/`: final-docked, final-menu and final-expanded at 1440 and 1280, and final-phone-390 (png).

## Build checklist

- Keyboard: Expand and More are reachable in order; Escape closes the menu first, then chat; focus lands on the Collapse button after expand.
- App map: new button, menu, and the new home of History and private chat.
- Live proof at 1440x900 and 1280x800, real app, no faked data; phone drawer unchanged.

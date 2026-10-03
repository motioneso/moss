# Docked chat: expand button and "more" menu (#2952)

Status: draft for impeccable review. Prototype is rough and built on main before PR 2958, so
the docked panel still shows the old rounded corners and wrapped status line.

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
- Chat fills the main area to the window height.
- Header, thread and composer share one centred reading column, 820px max, with 16px minimum side padding.
- The chat stays mounted, so unsent text survives expand and collapse.
- Close while expanded closes chat and resets to docked for next open.

## Open points and recommendations

| Point                                 | Recommendation                                                    | Why                                                                                                               |
| ------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Phone                                 | Desktop only; hide the button on phone widths.                    | The drawer already fills the screen.                                                                              |
| Remember across reloads               | No. Always reopen docked.                                         | Expanded hides the page; reopening into it after a reload is surprising. Revisit if asked.                        |
| Width use                             | Centred 820px reading column, full-bleed background and dividers. | Long lines hurt reading; the "use horizontal space" ruling is met by the full-width surface, not full-width text. |
| Click another nav item while expanded | Navigate and collapse to docked, so the new page is visible.      | Staying expanded would hide the page the user just chose. Unsent text is kept.                                    |

## Prototype findings to fix in the build

- Menu icons render larger than header icons; match to 16px.
- Hidden page header and body need `[hidden]` display rules (done in prototype).
- Status line wrap is fixed by PR 2958; rebase onto it.

## Screens (local, not committed)

`/tmp/design-chat-expand/`: docked-1440, docked-1280, menu-1440, menu-1280, expanded-1440, expanded-1280 (png).

## Build checklist

- Keyboard: Expand and More are reachable in order; Escape closes the menu first, then chat; focus lands on the Collapse button after expand.
- App map: new button, menu, and the new home of History and private chat.
- Live proof at 1440x900 and 1280x800, real app, no faked data; phone drawer unchanged.

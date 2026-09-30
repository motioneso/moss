# Chat model picker: providers, drill-in, favorites

Issue: #2810. Requested by Ben, 2026-09-29.

## Problem

The model button above the chat composer opens one flat list of every selectable model (16+ on a
typical install), each row naming the model with its provider underneath. Finding a model means
scrolling the whole list.

## Design

### Top level

- Search box, shown only when the picker holds more than 8 models. Typing replaces the sections
  with a flat filtered list (model name, provider underneath, star toggle).
- `Instance default` row (the admin default, its model id underneath). Not starrable; it is a
  routing choice, not a model.
- `Favorites` section: starred models, directly selectable, each with a filled star to unstar.
  Hidden when empty; a single hint line (`Star a model to pin it here.`) shows instead.
- `Providers` section: one row per provider, ordered as the models arrive from the server. Each
  row shows the model count and a chevron. The provider holding the current choice shows that
  model's id underneath and a check.
- Models another user configured arrive with their provider hidden (null `providerConfigId`,
  provider name `Instance default`). They group under `Shared models` so the list never shows a
  second `Instance default` beside the default row.

### Provider view

- Back row at the top (`<- Anthropic`), returns to the top level and refocuses that provider row.
- One row per model: name, star toggle, check on the current choice.

### Selection

Unchanged. Picking a model runs the existing override mutation, including the cross-provider and
private-mode confirms, and closes the menu. Starring never closes the menu or selects.

### Keyboard

- Up/Down move focus between rows; Home/End jump to the ends.
- Right (or Enter) on a provider row drills in; Left or Backspace in the provider view goes back.
- The star is a separate button in each row, reachable with Tab.
- Escape closes and returns focus to the trigger (existing dismiss hook).

### Phone

Same component renders in the phone chat drawer. The menu keeps its `min(320px, 100vw - 48px)`
width and gains a max height with internal scroll.

## Storage

- Per-user list of model ids in the existing owner-only `app.preferences` table, key
  `chat.favoriteModels`, value a JSON string array. No migration.
- `GET /api/ai/chat-model-favorites` returns `{ modelIds }`; `PUT` with `{ modelIds }` replaces
  the list (deduped, max 100 ids). Permissions match the override routes (`ai.view` / `ai.route`).
- Ids for models no longer selectable are ignored at render and dropped on the next write.
- The list is ordinary user data, so the existing user export already includes it.

## Out of scope

- Reordering favorites (they keep star order).
- Favorites in Settings > Assistant & AI.

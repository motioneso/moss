# Memory package

## 0.1.0

- Memory is now a built-in package. It keeps the same tables and saved data as before.
- Admins can set the model that turns note text into searchable vectors from Settings, Memory search model. Note text is sent to the endpoint you choose, and the screen says so before saving. Running the model on this device is not available yet.
- Notes search and indexing use this one model setting. Until it is set, they say "No embedding model is set up".
- The Memory screen is now part of this package, under Settings, Memory & context. To review lists what Moss suggests, five at a time, and each suggestion can be accepted, dismissed or never suggested again. Saved memories has search, status, kind and source filters and paging, and each memory can be pinned, confirmed, corrected, replaced, marked stale or forgotten. You can also add a memory by hand. History shows replaced and expired memories and dismissed suggestions.
- The Memory search model setting moved to Settings, Memory & context, Search model.

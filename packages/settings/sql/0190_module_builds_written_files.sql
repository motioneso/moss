-- #1949: track the files a module build has written, alongside the URLs it fetched, so the
-- Workshop page can show "what it has written" while a build is running.
ALTER TABLE app.module_builds
  ADD COLUMN written_files jsonb NOT NULL DEFAULT '[]'::jsonb;

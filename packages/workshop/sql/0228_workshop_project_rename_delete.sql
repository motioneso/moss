-- Issue 2362: renaming a project updates its name in place, and deleting one removes the
-- project and its feed rows in a single transaction. The runtime role could already read and
-- insert both tables; it still needs the update and delete grants to do either.
GRANT UPDATE (title, updated_at) ON app.workshop_projects TO jarvis_app_runtime;
GRANT DELETE ON app.workshop_projects TO jarvis_app_runtime;
GRANT DELETE ON app.workshop_project_feed TO jarvis_app_runtime;

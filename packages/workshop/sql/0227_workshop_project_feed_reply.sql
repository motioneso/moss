ALTER TABLE app.workshop_project_feed
  DROP CONSTRAINT IF EXISTS workshop_project_feed_kind_check,
  ADD CONSTRAINT workshop_project_feed_kind_check
    CHECK (kind IN ('user_message', 'assistant_message')),
  DROP CONSTRAINT IF EXISTS workshop_project_feed_delivery_check,
  ADD CONSTRAINT workshop_project_feed_delivery_check
    CHECK (delivery IN ('pending', 'delivered'));

GRANT UPDATE (delivery) ON app.workshop_project_feed TO jarvis_app_runtime;

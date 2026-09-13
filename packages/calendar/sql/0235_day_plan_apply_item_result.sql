-- R2.2-T04B: one typed execution result per reserved apply item. Outcomes stay on
-- the existing outcome column; this field carries the provider reference, actual
-- timing, calendar-mirror result, or the stable failure/conflict reason.
ALTER TABLE app.day_plan_operation_items
  ADD COLUMN IF NOT EXISTS result jsonb;

-- R2.2-T03-R3: a day-plan block must still name the task it was for after that task is gone,
-- so preview can tell "no task" apart from "task no longer exists" (see day-plan-preview.ts
-- eligibilityOf). ON DELETE SET NULL erased that distinction by nulling task_id on deletion.
-- Dropping the foreign key keeps task_id as a plain historical UUID instead.
ALTER TABLE app.day_plan_blocks DROP CONSTRAINT IF EXISTS day_plan_blocks_task_id_fkey;

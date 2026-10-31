ALTER TABLE app.finance_targets
  DROP CONSTRAINT finance_targets_kind_check,
  DROP CONSTRAINT finance_targets_check,
  ADD CONSTRAINT finance_targets_kind_check CHECK (kind IN ('monthly','weekly','refill','balance','removed')),
  ADD CONSTRAINT finance_targets_check CHECK (
    (kind='removed' AND amount_cents=0 AND due_date IS NULL AND weekday IS NULL)
    OR (kind IN ('monthly','refill') AND amount_cents>0 AND due_date IS NULL AND weekday IS NULL)
    OR (kind='balance' AND amount_cents>0 AND due_date IS NOT NULL AND weekday IS NULL)
    OR (kind='weekly' AND amount_cents BETWEEN 1 AND 1801439850948198 AND due_date IS NULL AND weekday IS NOT NULL AND weekday BETWEEN 0 AND 6)
  );

-- Repair 0231 without changing its recorded checksum or the original notes.
ALTER TABLE app.day_plans NO FORCE ROW LEVEL SECURITY;

UPDATE app.day_plans
SET evening_intent = jsonb_set(evening_intent, '{notes}', 'null'::jsonb)
WHERE evening_intent ->> 'notes' = legacy_0229_notes
  -- Match the whitespace accepted by JavaScript String.trim(), including NBSP/BOM.
  AND btrim(legacy_0229_notes,
    U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
  ) = '';

ALTER TABLE app.day_plans FORCE ROW LEVEL SECURITY;

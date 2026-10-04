-- #2984 classifier tools on by default, R2.1: convert old per-tool review entries once (spec 8.7).
--
-- An entry the owner saved with opt-in off becomes kept out, because that may have been a choice.
-- An owner-reviewed risk becomes the sort entry's legacy floor, which only ever raises the risk
-- the sorting pass assigns. Every converted tool starts never tried. The old preparation map is
-- left as it is: its prepared text is still read until a later slice retires it. Existing sort
-- entries win, so running this again changes nothing.
--
-- Same idiom as 0209: the migration role is NOBYPASSRLS and matches no policy on this FORCE RLS
-- table, so the owner disables RLS for this single-transaction backfill and restores ENABLE +
-- FORCE before commit. Not a runtime bypass; runtime roles are untouched.
ALTER TABLE app.integration_connections DISABLE ROW LEVEL SECURITY;

WITH old AS (
  SELECT c.id, e.key AS tool_name, e.value AS entry
  FROM app.integration_connections AS c,
       jsonb_each(c.classifier_preparation -> 'entries') AS e
  WHERE jsonb_typeof(c.classifier_preparation) = 'object'
    AND c.classifier_preparation -> 'version' = '1'::jsonb
    AND jsonb_typeof(c.classifier_preparation -> 'entries') = 'object'
    AND jsonb_typeof(e.value) = 'object'
),
kept_out AS (
  SELECT id, array_agg(tool_name ORDER BY tool_name) AS tool_names
  FROM old
  WHERE entry -> 'optIn' = 'false'::jsonb
  GROUP BY id
),
floors AS (
  SELECT id,
         jsonb_object_agg(
           tool_name,
           jsonb_build_object('status', 'never_tried', 'legacyRiskFloor', entry -> 'reviewedRisk')
         ) AS entries
  FROM old
  WHERE entry ->> 'reviewedRisk' IN ('read', 'write', 'outbound', 'destructive')
  GROUP BY id
)
UPDATE app.integration_connections AS c
SET classifier_kept_out_tools = CASE
      WHEN k.tool_names IS NULL THEN c.classifier_kept_out_tools
      ELSE ARRAY(
        SELECT DISTINCT unnest(c.classifier_kept_out_tools || k.tool_names) ORDER BY 1
      )
    END,
    classifier_sort = CASE
      WHEN f.entries IS NULL THEN c.classifier_sort
      WHEN jsonb_typeof(c.classifier_sort -> 'entries') = 'object'
        AND c.classifier_sort -> 'version' = '1'::jsonb
      THEN jsonb_set(c.classifier_sort, '{entries}', f.entries || (c.classifier_sort -> 'entries'))
      ELSE jsonb_build_object('version', 1, 'entries', f.entries)
    END
FROM app.integration_connections AS src
LEFT JOIN kept_out AS k ON k.id = src.id
LEFT JOIN floors AS f ON f.id = src.id
WHERE c.id = src.id
  AND (k.id IS NOT NULL OR f.id IS NOT NULL);

ALTER TABLE app.integration_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.integration_connections FORCE ROW LEVEL SECURITY;

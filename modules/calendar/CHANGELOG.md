# Calendar package

## 0.12.0

- Add a background job that removes one cached event for the account that queued it. An event the account cannot see is left untouched and reported as not removed.
- Nothing queues this job yet, and retry and retention settings use host defaults.
- Real worker-role dispatch is not proven here.

## 0.11.0

- Accept the original day-plan date field for draft creation and saves.
- Use the account timezone, or the product default, when creating without a timezone.
- Compare draft writes with production and exercise both URL prefixes after real browser sign-in.
- Source-linked creation, enriched plan reads and full Calendar acceptance remain open.

# Shorter Meeting settings copy

Ben asked to check Settings and Meetings for unnecessary explanations. A live
inspection found a long transcript-language paragraph and repeated setup and
hypothetical failure guidance beneath the transcription provider selector.

Keep this cleanup bounded to those two web settings groups:

- Explain transcript language and automatic summaries in one short sentence each.
- Keep the provider's instance-wide scope and audio destination clear.
- Show provider setup help when there are no eligible models.
- Show recovery advice when the saved model is actually unavailable, after the
  provider/model reads succeed. Keep loading and read-failure feedback intact.
- Keep the matching app-map descriptions current. Do not change transcription,
  credentials, saved preferences, control names or native delivery behavior.

Verify with focused existing tests, static checks and the real Settings UI on an
isolated instance. Use independent Standards and Spec review before merge. This
copy cleanup does not delay deployment of the already-reviewed timestamp fix or
count as physical device acceptance.

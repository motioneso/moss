# Vocci production recording acceptance

On 2026-10-24 UTC, Ben unlocked the configured daily-use phone. The actual native
Start delivery button resumed the real recording retained during signed APK
replacement from version code 20261024 to 20261025. The saved source/configuration
identity and enabled delivery choice survived replacement.

The approximately three-minute normal recording completed through the production
ASR service. The actual Meeting UI displayed 34 timestamped segments, including
later windows, and an automatically saved version-1 summary with a nonempty
overview. No manual summary request was made for this recording. Earlier failed
automatic receipts remain unchanged; their successful manual retries are separate
proof and are not counted as fresh automatic-summary acceptance.

Android skipped the package-replacement recovery receiver, so completion required
manual Start. This proves real pending-recording persistence and manual upload
recovery. It does not establish automatic replacement/reboot recovery, interrupted
chunk or byte-offset resume, offline/out-of-range recovery, or production hold
review/Send/Main behavior. Task #3565 stays open for the remaining recovery gaps.

Delivery remains enabled; hold and source cleanup remain off. The original
two-minute screen timeout is restored. No new recording or unlock step is pending.
Private device, source and browser receipts remain outside the public repository.

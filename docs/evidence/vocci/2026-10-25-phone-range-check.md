# Vocci phone session: offline delivery and interrupted upload

Date 2026-10-25 (phone clock 2026-10-24 PDT). Production phone, ring and Moss, observed over ADB
and the server log. No production database access. Tracks #3565 and #3584.

## Results

| Check                                                                                         | Result                |
| --------------------------------------------------------------------------------------------- | --------------------- |
| Recording made while the phone could not reach the ring is delivered automatically afterwards | Pass, with a stand-in |
| Upload cut off partway resumes and arrives once                                               | Not proven            |

### Offline delivery

- Phone Bluetooth switched off for about 2 minutes, one 20-second recording made on the ring.
- Nothing reached Moss while Bluetooth was off.
- About a minute after Bluetooth came back (22:19:44) the delivery app opened a ring connection.
  The upload (create, packets, sidecar, audio, finalize) ran at 22:20:20 and 22:20:21.
- The Meeting appeared with no retry. No transcript was produced. The recording was of a TV, so the
  likely cause is no speech, not a fault. No error appeared in the server log.
- Stand-in: Bluetooth off, not physical distance. Android may treat the two differently.

### Interrupted upload

- A 60-second recording was made, then airplane mode switched on at about 22:37 and off with
  Bluetooth back on at about 22:38.
- The upload ran once at 22:41:36 to 22:41:37: one create, one finalize. One new Meeting appeared,
  with a transcript. The earlier Meeting remained, and there was no duplicate.
- The server never saw a failed attempt. The ring-to-phone transfer takes about 4 seconds, so the
  cut was not shown to land mid-transfer. Byte-offset resume is not proven here.

## Acceptance

Ben reviewed both results, including the stand-in and the unproven mid-transfer cut, and accepted
both checks as passed on 2026-10-25.

## Phone state

Restored and unchanged: delivery running, hold-to-talk on (set by Ben before the session), screen
timeout 2 minutes, airplane mode off, Bluetooth and Wi-Fi on. Wireless debugging changed its port
after the network toggle and had to be re-read from the phone.

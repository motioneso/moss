# Vocci legacy live audio: bounded investigation

## Result

Live streaming remains unverified. Completed-file delivery can operate independently.
No observed activation recipe is available for the tested legacy ring.

## Static evidence

The official Android app version 1.1.24 build 333 was inspected. APK SHA-256:
`3a168e1dfbfbdd8ece2971cea4f406f5cb9fa278ca695b6c459288328563ea45`.

A Hermes bytecode string-reference search for the audio service/write/notify UUID
constants found only the declarations and service mappings (functions 50086 and
50114). Broader audio-channel, streaming and send-audio references did not identify
an active consumer of that legacy channel within the string-reference boundary.
Dynamic lookup and native activation remain unresolved. The native class-search
tool failed its inventory consistency check, so it supplies no native conclusion.

The legacy `startRecording` function builds a single-byte payload containing 1 and
sends it through UART record control. That is evidence of recording control; it
does not establish a live-audio activation command. No additional hardware command
was attempted from this finding.

## Hardware evidence and limits

Earlier authenticated recording tests on Timon V2.5.1, firmware 0.4.01, subscribed
to the available channels and received recording events with zero live audio
packets. Audio was retrieved as a completed file after recording. This is a bounded
negative observation for those conditions; it establishes neither impossibility nor
universal lack of support. No new hardware capture or firmware write was performed
for this static follow-up.

## Remaining dependency

Identify an active legacy audio consumer or an observed activation command before
attempting another ring write. If found, verify notifications before recording,
then measure first-packet latency, continuity and decoding during recording,
separately from file transfer after stop. Preserve binding, recordings and firmware.
V3 app source alone does not establish support on the tested legacy firmware.

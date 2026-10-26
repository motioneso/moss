# Vocci ring app: simpler layout

Status: approved by Ben, 2026-10-25 (mockups below).

## Problem

- The Android ring app (`apps/vocci-delivery`) has two overlapping screens, Hardware and Delivery details,
  with about 25 buttons.
- Most buttons render in every state. Start delivery is the primary button while delivery is already
  running; Connect Moss in browser shows while the account is connected.
- Permissions, Android app settings, Vocci app settings, clear audio and ring setup each appear on both
  screens.

## Goal

One home screen that shows what is happening and the one action that fits now. One settings page that
holds everything else, each control once. No change to delivery, setup, upload or ring behaviour.

## Mockups

`docs/superpowers/mockups/vocci-ring-app-layout/index.html`, rendered as `screens.png`.

1. Home, delivering
2. Home, something is wrong (and the stopped card)
3. Settings

## Home screen

- Title "Vocci ring".
- Status card:
  - Coloured dot, one-line state, one or two lines of detail (ring serial, account, origin).
  - Exactly one button, chosen by state:

| State                                        | Card text                           | Button                                         |
| -------------------------------------------- | ----------------------------------- | ---------------------------------------------- |
| Delivering, healthy                          | Delivering                          | Stop delivery (secondary)                      |
| Stopped                                      | Stopped                             | Start delivery (primary)                       |
| Setup not done or needs recovery             | Set up your ring                    | Set up ring (primary)                          |
| Account disconnected or developer session    | Moss account not connected          | Connect Moss in browser (primary)              |
| Connection request pending                   | Waiting for approval in browser     | Reopen browser approval; Cancel as a text link |
| Vocci app still holds Nearby devices         | Can't reach the ring                | Open Vocci app settings (primary)              |
| Bluetooth or notification permission missing | Permission needed                   | Allow Bluetooth and notifications (primary)    |
| Battery optimization active while delivering | Delivering, may pause in background | Open app settings                              |
| Saved setup unreadable                       | Setup could not be opened           | none; keep the existing recovery text          |
| Recovery message present                     | the message                         | Start delivery if stopped                      |

- When several apply, show the one that blocks delivery first. Order follows the table, top to bottom
  after the first two rows.
- Recent: the latest few deliveries with time, kind (meeting or voice message), length, and outcome.
  Per-recording actions such as Retry transcription move to a recording detail screen opened by
  tapping the row.
- Links: Recordings on ring, Settings.

## Settings page

Each item appears once, with status text where useful:

- Switches: Remind me after an hour, Voice messages (hold to talk).
- Account: name and origin, Disconnect.
- Ring: Set up ring again, About this ring, How to use your ring.
- Phone storage: Clear delivered audio, with the size on the phone.
- Troubleshooting: Permissions and battery. This opens the current permission, battery, Android app
  settings and Vocci app settings help.

## Ring storage screens

Recordings on ring, the recording detail and Exclude from delivery keep their behaviour. Their back
buttons return to Home.

## Rules

- A button appears only when its action can do something in the current state.
- Exactly one primary (filled) button per screen.
- Existing commands, intents, and stored settings keep their names and behaviour, so installs upgrade
  in place.
- Help paragraphs shrink to one line or move to Troubleshooting. Screen copy follows the "copy is
  marketing, not documentation" ruling.
- Keep the existing NativeTheme colours, fonts and button styles.

## Out of scope

- Delivery, upload, setup flow, ring protocol and the reminder logic.
- Any server or Moss web change.

## Verification

- Host tests (`./test.sh`) stay green. Add tests for the state-to-button choice as a plain function.
- Live on Ben's phone: screenshots of home while delivering and stopped, and the settings page.
  Confirm every action from the old screens is still reachable.
- Install as an update over the current install, signed with the kept development key, so setup and
  delivery records survive.

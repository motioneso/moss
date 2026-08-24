# Fleet runbook

This is the overnight work queue. The fleet reads the project board, starts work in separate
lanes, waits for checks and review, and records every decision. A dry run proves what the daemon
decides to do; it does not prove that GitHub, the workspace manager, or an agent would complete it.

## Queue tonight's work

Put each issue on project 2, **Issue and Roadmap Work**, with the `task` label and status **Ready**
or **In Progress**. The daemon finds those issues at the start of a tick. It assigns a risk tier,
then records the issue in its own queue. Do not hand-edit the queue files.

To inspect one recorded lane:

    JARV1S_FLEET_STATE=~/.local/state/jarv1s-fleet node scripts/fleet/fleetctl.mjs get ISSUE

Replace `ISSUE` with the issue number.

## Start the fleet

Install the launcher's separate dependencies once, then start it from the repository directory:

    pnpm --dir scripts/fleet/launcher install
    pnpm --dir scripts/fleet/launcher start

The first start asks setup questions and starts the background timer. Later starts reuse the saved
settings. Closing the viewer does not stop the fleet.

Before trusting a new setup, run one safe tick against a throwaway state directory:

    state="$(mktemp -d /tmp/jarv1s-fleet-dry-run-XXXX)"; mkdir -p "$state/tasks"
    FLEET_DRY_RUN=1 JARV1S_FLEET_STATE="$state" scripts/fleet/tick.sh

The output lines beginning `DRY:` are intended actions only.

## Stop the fleet

For an immediate kill switch, create `STOP` in the state directory:

    touch ~/.local/state/jarv1s-fleet/STOP

The timer may remain enabled, but each tick exits without acting. To stop and disable future ticks:

    systemctl --user disable --now jarv1s-fleet-tick.timer

After Ben has checked the queue, remove the kill switch before the next run:

    rm ~/.local/state/jarv1s-fleet/STOP

## Read what it did

The morning summary is the generated board:

    sed -n '1,240p' ~/.local/state/jarv1s-fleet/board.md

The append-only event log has the details:

    tail -n 60 ~/.local/state/jarv1s-fleet/log.jsonl

`blocked` means the lane is parked. Read its reason before acting. `code-complete, unverified`
means a user-facing change still lacks live proof on its pull request. A security lane waits for
Ben's sign-off before merge. A `DEPUTY` entry means the deputy was enabled, waited for the stated
period, and made a reversible decision within its hard safety limits; review those entries first.

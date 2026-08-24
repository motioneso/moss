# Fleet launcher

## What this is

The launcher starts the overnight fleet. The viewer shows what each lane is doing without
contacting the project board or the running agents.

## Starting it the first time

Install the launcher's separate dependencies once, then start it:

    pnpm --dir scripts/fleet/launcher install --ignore-workspace
    pnpm --dir scripts/fleet/launcher start

The `--ignore-workspace` matters: the launcher sits inside the repo's workspace, so without it
pnpm installs into the repo root and the launcher starts with a missing-package error.

Answer each question, or press Enter to use the value in brackets. The daemon starts in the
background after setup. Closing the viewer does not stop it.

## Setup questions

The judgment command is the command used when the fleet needs a decision. The three build entries
choose a program, a model and an effort for routine, sensitive, and security work. Enter each as
`program/model/effort`, separated by commas. The program is the agent command to launch, such as
the local Claude CLI or Codex; the model must be one that program accepts, because the fleet
launches the program you name and hands it the model you name. Two parts are read as `model/effort`
and keep the program already set.

To see what is installed and what each program says about the models it takes, run:

    scripts/fleet/models.sh Lane cap limits simultaneous lanes. The start budget limits fresh agents for

the run. The deputy is off by default; when on, it may answer after the wait period. Its safety
limits cannot be changed here.

## Where the agents appear

Lane agents open in their own tab, called Fleet Agents, so they never land in a tab you are working
in. The first agent of a run creates it; later ones split a pane inside it. Set `FLEET_AGENT_TAB` to
use a different name.

## Reading the viewer

In Progress shows active and waiting lanes. Ready shows lanes likely to be picked up next. Done
Tonight shows only work finished since the daemon started this run. Use the arrow keys to move and
switch tabs. If the daemon was started at boot rather than by the launcher, Done Tonight says that
the run has no start time and cannot filter safely. Press Enter for the lane story. Press Escape to
return. Press `d` on the list to turn the deputy on or off; its state is always shown in the header.

## Pause and rescue

Press `p` in a lane to confirm a cooperative pause or resume. The running agent is told what to do,
and the action is recorded. Pausing does not kill an agent.

Press `r` to ask for a rescue preview. Nothing starts until you accept it. Accepting starts one fresh
agent and counts against the run budget. Dismiss leaves the lane unchanged.

## Stopping

Press `q` to close the viewer. The fleet keeps running. To stop the fleet, run:

    systemctl --user disable --now jarv1s-fleet-tick.timer

## When something looks wrong at 1am

If the state folder is empty, the daemon has not written its first tick yet. If one row is broken,
the rest of the screen still works; check that lane's record. If the daemon is stopped, press `s`
when offered. A rescue error changes nothing, so try again after checking the command it uses.

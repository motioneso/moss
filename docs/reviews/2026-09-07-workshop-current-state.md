# The Workshop as it stands on main

**7 September 2026.** Read from the code on `origin/main` at commit `bb59e0700`, not from issues
or plans. Anything described here is merged and running. Anything not described here is not built,
whatever an open issue says.

## What the Workshop is today

A place to keep a private project and talk to Moss about it. Three screens, reached from the
left-hand nav at **The Workshop**:

| Screen               | Address          | What it is                                                                                                          |
| -------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| Project list         | `/workshop`      | Every project you have saved, newest first, with the date it started                                                |
| New project          | `/workshop/new`  | An empty chat window asking "What would you like to make?", with three example pills and a box to type in           |
| Project conversation | `/workshop/<id>` | The project as a chat window: your opening request first, then the messages, with the composer pinned at the bottom |

It is admin-only, and projects are private even from other admins.

## What works

**Starting a project.** There is no form. You type what you want into an empty window and send
it; the project is created on that first send and you land straight in it. The name is derived
from your words, and you can change it later. Nothing else happens: no plan is written, no code is
generated, nothing is installed.
The code says so in as many words, and the tool's own summary line shown to you is "Save a private
Workshop project. Planning has not started."

**Talking to the project.** Each message you add is saved, and Moss answers it. If the answer
fails or takes longer than 45 seconds, your message is still saved and is marked as awaiting
delivery rather than lost. A late answer that arrives after the deadline is logged and dropped, so
a slow model can never hang the save.

**Renaming and deleting.** Click the project name in the top bar to rename it in place. Delete
sits behind the More button at the right of that bar, with a confirm step, and returns you to the
list. Deleting removes the project and all of its messages together.

**The top bar tells you where you are.** Inside a project it shows the Workshop as the way back,
then the project name, then the date it started.

**Starting one from chat.** Ask Moss in ordinary chat to build something and it saves a Workshop
project and gives you the link. It copies only your request, never the surrounding conversation.
Incognito chats and chats it cannot verify are refused, with a message telling you to use the new
project screen instead.

**Your data is yours.** Projects and their messages are both included in a data export, and both
are deleted when you delete your account.

## What it does not do

These are the honest gaps, all confirmed in the code rather than assumed.

**It cannot build anything.** There is no plan, no code generation, no install, no preview. The
Workshop is a notebook that answers back.

**The conversation has no memory.** Each reply is built from the persona, the project title, the
opening request, and your newest message. Earlier messages in the same project are not sent, so
Moss will not remember what it told you two messages ago and can contradict itself across a
conversation. This is the biggest gap between how the screen looks and how it behaves: it looks
like a chat and reads like a chat, but every turn starts cold.

**The screen promises something the product cannot do.** The new-project window says "Moss will
ask a few questions, show you the screens, then build it." None of those three things happen. That
copy is describing the intended Workshop, not the one that shipped.

**You cannot choose which model answers.** The reply uses whichever model is configured for
ordinary interactive chat. There is no per-project or per-screen choice.

**There is a build-command tool that nothing can reach.** `workshop.runCommand` is registered and
would run one shell command in a project folder, behind a mandatory approval card. But nothing on
main supplies the service it needs, so every call fails with "Running project commands is not
available on this surface." It arrived with the outside-agent work; the piece that would have
called it never merged.

**The old build screens are gone but their data is not.** An earlier Workshop, built around
June to August, showed modules being built with live progress. That was replaced. The build
records and the Settings route that lists them still exist, but nothing creates new ones any more,
so that table only holds whatever was made before the replacement.

## What has been merged, in order

Newest first. Only pull requests that changed the Workshop itself.

**The current Workshop**

- **#2405** Project list tidy-up: the save status line went, rename moved into the menu, Enter
  sends a message
- **#2395** The build-command tool (part of the outside-agent work; see below)
- **#2376** The project workspace, slices 3 to 7: the top bar trail, the project as a real chat
  window, the form-free start screen, and rename and delete
- **#2364** The green masthead and row list on the Workshop home page
- **#2365** Moss answers each saved message
- **#2372** Unexpected Workshop errors are now logged on the server
- **#2307** The rewrite: private projects, a durable message feed, and a real project screen

**The earlier Workshop, since replaced**

- **#2009**, **#1991** Fixes for builds stuck showing "Building"
- **#1978** Made the three action buttons work
- **#1966** Real build progress and finish notifications
- **#1964**, **#1948** Real build and module data, and owner visibility
- **#1940** Ask Moss for a module in chat and get a plan back
- **#1804** The original page listing modules Moss was building

## The outside-agent work, being removed

Five merged pull requests (**#2377**, **#2382**, **#2395**, **#2411**, **#2412**) added a second,
separate way of talking to a model, so that an outside agent could run build steps inside a
project. Ben ruled it out on 7 September 2026: he does not want a second connection sitting beside
the one Moss already has, and does not want people picking a helper by product name.

Pull request **#2418**, which would have wired it into the Workshop and added the setting, is
closed unmerged. Pull request **#2420** removes the five merged pieces. What Ben wants instead is
recorded in issue **#2421**: the Workshop picks its build model from providers you have already
connected, and the ability to run a build comes from deepening the connection Moss already has.

Note that **#2395**, the build-command tool, is in both lists. It is the one piece that could
stand on its own, but nothing calls it today.

## One loose end worth knowing about

The Workshop's own record of its database changes lists three files (`0223`, `0224`, `0228`) but
there are four in the folder — `0227`, which lets Moss's replies be saved at all, is missing from
the list. This does **not** break anything: the installer reads the folder, not the list, so all
four run. It is a stale declaration left over from a migration renumbering in #2365, worth
correcting so the record matches reality.

## Where the design is heading

Merged code has not caught up with two decisions already taken.

- **5 September 2026:** the Workshop is to be redesigned as a chat window with an artifact panel
  beside it, in the Park Press look. Open issues #2397 through #2401 carry the slices for that
  work, and none have merged.
- Supervised build sessions (#2023) remain the larger direction, with confinement work (#2265,
  #2277) as the prerequisite nobody has finished.

So: the Workshop you can use today is a private project notebook that answers back. Everything
that makes it a workshop is still ahead of it.

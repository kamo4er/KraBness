# Changelog

What changed from release to release. Downloads are on the [releases](https://github.com/kamo4er/KraBness/releases) page.

## 0.1.57

**Live pages stay light: only the ones you can see run. Diagrams on the phone draw without internet, live pages reach Telegram as files, and the project now has automatic tests on GitHub and a changelog.**

### Live pages
- Only the pages you can see are running. Scroll a 3D scene away and it pauses; scroll back and it starts again. Ten scenes in a chat no longer make the browser drop them or the laptop warm up. Same in the app: pages off-screen don't keep a browser view in memory.
- In the web UI a card takes the page's own height (between 160 and 640 px) instead of a fixed 380 px. A full-screen page keeps the usual size.

### Diagrams on the phone
- The app loads the diagram library from your hub instead of a CDN, so mermaid diagrams draw over Tailscale even with no internet on the phone. If the hub can't serve it, the app falls back to the CDN as before.

### Telegram
- The session's Telegram bot sends a live page as a file `page-1.html` with a short note, instead of a wall of code over several messages. A piece of markup still goes as code.

### For everyone checking the project
- Every push to this repository runs the typecheck and the unit tests on a clean Windows machine. The badge in the README shows the result.
- `CHANGELOG.md` (and `CHANGELOG.ru.md`) lists what changed in every release.
- The README GIF now shows the PC and the phone side by side: one chat, the approval tapped on the phone.

## 0.1.56

**Approvals show only what changes, live pages tell the agent when they break, and the README is new: a short demo GIF, the point in three lines, details folded away.**

### Approvals
- The approval card for a file edit now shows a real line diff: only the changed lines and two lines around them. Before, the whole old text was marked as removed and the whole new text as added, even when the agent only appended a function.

### Live pages
- A ```` ```html ```` block runs by itself only if it is a whole page (`<!doctype html>`, `<html>`) or has a script, a canvas or an SVG. A piece of markup, like a template edit the agent shows you, appears as code with a Run button.
- If the page throws an error, the card shows it with a "Send to the agent" button: the error goes to this session as a message.
- The agent is told what the sandbox doesn't allow (localStorage, cookies, alert, forms, window.open), so it stops relying on them.

### Tasks
- The task report shows the goal once instead of six times. Each step has an "open chat" button, changed files are a list with status marks.

### Session branches
- New session branches are called `krab/<name>`, and the name is shorter: up to four words, without filler words. Old `kamharn/` branches keep working.

### Smaller things
- Web: the session list says "working" in color while an agent works, like the app does.
- App: the "talk" chip asks before turning talk mode off; the Telegram bot chip refreshes when you come back to the app.
- Web: the Telegram bot chip refreshes when you come back to the tab.

## 0.1.55

**The chat header is cleaner: one settings chip, a ⋯ menu and green chips for what's on. The web gets a command palette (Ctrl+K). The Dispatcher no longer waits for sessions it hands work to.**

### Chat header

- The session title fits again: on the phone the header is just ←, the title, the connection dot and ⋯.
- One chip shows "model · reasoning · approvals". Tap it to change the model, the reasoning level or the approval mode. Claude sessions also show the limits there and "Continue on a free model" (the former "→ opencode").
- Everything else is in the ⋯ menu, grouped: Project (files and changes, dev server preview, session branch), Agent (auto-check, compact the context, talk mode in the app), Link (Telegram bot, find in chat in the app). Switches show on/off. Deleting the session is separate at the bottom.
- What's switched on shows as green chips under the header: the session branch, auto-check, talk mode, the Telegram bot. Tap a chip to open its settings.
- The web and the app now share one list of session actions, so they show the same things.

### Command palette (web)

- Ctrl+K (it works in any keyboard layout): actions of the open session, switching its model, new session, tasks, the Dispatcher, settings sections and any session by its title.
- Type any part of a word, in Russian or English.

### Dispatcher hands work off and stays free

- Handing a task to a session returns at once. The Dispatcher answers "handed over" and is ready for your next message.
- The hub watches the sessions itself and wakes the Dispatcher when one finishes, asks a question, needs approval, fails or hits a limit. News that arrives while it's busy comes in one message.
- Up to three sessions work on its tasks at once (`dispatcher.maxSessions`). A busy session or folder waits its turn. A new session in a busy git project gets its own copy on a separate branch.
- Assignments survive a hub restart.

## 0.1.54

**The Dispatcher gets a long memory, works without Claude, and a fallback model takes over when Claude can't answer. The README is rewritten with fresh screenshots.**

Version 0.1.53 was withdrawn. Everything from it is in this release.

### Long memory

- The Dispatcher remembers what was said in all your chats, including earlier ones, day by day, so you can ask what was done on a given day. It all lives in the hub's database on this PC. What it recalls goes to the Dispatcher's model like any other context.
- Close a group for memory in its settings: its chats aren't remembered or found.
- Settings → Agents → Memory in the web UI: look things up or forget matching records (up to five per press; the diary and the chats themselves stay).
- It searches by words out of the box. A diary by days and search by meaning need a local OpenAI-compatible model (`memory.writer` and `memory.embeddings` in the config). In LM Studio the model must already be loaded.
- `memory.enabled: false` in the config turns it off.

### Any brain, one chat

- Settings → Agents → Dispatcher: choose the main model and, if you want, a fallback. The chat stays the same, only the model under it changes.
- No Claude Code or not signed in: the Dispatcher starts on an opencode model with tools right away.
- Claude as the main one and a fallback chosen: when Claude hits its limit or isn't signed in, the fallback answers, including the message that was cut off. It gets a short summary of the conversation. Afterwards the next message goes back to Claude, and Claude learns what happened meanwhile. You get one notification and a mark in the chat.
- A fallback is never picked for you: the conversation and screenshots go to its provider. Limits of other providers don't trigger a switch, their error shows in the chat.

### PC control on opencode models

- Off by default, a checkbox in the same settings. Needs a model with vision and [uv](https://docs.astral.sh/uv/) (the installer now offers it).
- Screenshots and the mouse go without asking. Typing, keys, launching programs and commands ask every time, and the card shows what exactly.
- **Weaker than on Claude:** there is no safety classifier here, and a mouse click on "Pay" or "Send" doesn't ask. There is only an instruction to the model to ask first.
- Tested live on Kimi k3.1-pro. Other providers go through the same code but weren't tried live.
- Only the Dispatcher gets these tools: ordinary opencode sessions don't see them, and its folder can't host an ordinary opencode session.

### README

- New screenshots, in English and in Russian, and new sections: the Dispatcher, tasks and auto-check, live pages and layout comments, search and token usage.
- It now says plainly what the features need and where their limits are. For example, voice on the PC is Russian only for now, and a screenshot of the PC screen needs ffmpeg.

### Fixes

- `show_screen` now really sends the screenshot to the chat as a file.
- Approval cards for MCP tools in opencode show the arguments instead of `*`.

## 0.1.53

_Withdrawn: everything from it is in 0.1.54._

**The Dispatcher now works without Claude, and a fallback model takes over when Claude can't answer.**

### Any brain, one chat

- Settings → Agents → Dispatcher: choose the main model and, if you want, a fallback. The chat stays the same, only the model under it changes.
- No Claude Code or not signed in: the Dispatcher starts on an opencode model with tools right away.
- Claude as the main one and a fallback chosen: when Claude hits its limit or isn't signed in, the fallback answers, including the message that was cut off. It gets a short summary of the conversation. Afterwards the next message goes back to Claude, and Claude learns what happened meanwhile. You get one notification and a mark in the chat.
- A fallback is never picked for you: the conversation and screenshots go to its provider. Limits of other providers don't trigger a switch, their error shows in the chat.

### PC control on opencode models

- Off by default, a checkbox in the same settings. Needs a model with vision and [uv](https://docs.astral.sh/uv/) (the installer now offers it).
- Screenshots and the mouse go without asking. Typing, keys, launching programs and commands ask every time, and the card shows what exactly.
- **Weaker than on Claude:** there is no safety classifier here, and a mouse click on "Pay" or "Send" doesn't ask. There is only an instruction to the model to ask first.
- Tested live on Kimi k3.1-pro. Other providers go through the same code but weren't tried live.
- Only the Dispatcher gets these tools: ordinary opencode sessions don't see them, and its folder can't host an ordinary opencode session.

### Fixes

- `show_screen` now really sends the screenshot to the chat as a file.
- Approval cards for MCP tools in opencode show the arguments instead of `*`.
- The README finally describes the Dispatcher.

## 0.1.52

**Tap to talk in the app, and voice on the PC no longer cuts you off mid-sentence.**

### Microphone in the app

- No need to hold the button anymore: tap 🎤 and speak, tap ⏹ to stop. Handy in the car or with your hands busy.
- In talk mode (on by default in the Dispatcher's chat) the message is sent as soon as you tap ⏹, and the answer is read aloud.
- With text in the field: a short tap sends, a long press adds more by voice (also until the second tap).
- Forgot to turn it off: the microphone stops by itself after 2 minutes or when you leave the chat.

### Voice on the PC

- A phrase ends after 1.3 seconds of silence (was 0.7), a command after the beep after 1.6 seconds. Natural pauses between words no longer split a command in two.
- If a phrase sounds unfinished (no period at the end, a comma, "..."), it waits up to 2 more seconds for the rest and glues it on.
- Settings → Computer → Voice on the PC: choose the pause (1, 1.3, 1.5, 2 or 3 seconds).

## 0.1.51

**The Dispatcher remembers, finds old conversations and saves the limit; search across all chats.**

### Search across all chats

- Web: a search line above the session list. App: 🔍 in the header of the session list.
- Finds user and agent messages in every session, highlights the matches, a tap opens the session. Words match by their beginning, all words must be present.
- The whole existing history is indexed once on the first start (about a second for a few thousand messages), new messages right away. Deleting a session removes it from the search.

### The Dispatcher's memory

- Two files in the Dispatcher's folder: USER.md (about you) and MEMORY.md (agreements, where things are). Their text is part of its instructions, so it remembers across conversations.
- It adds facts itself ("remember that..."), and you can edit both files in the Project view of its session.
- It searches past conversations in all sessions: "how did we fix that last week?"

### Saving the limit

- Routine text work (summarize, translate, classify, draft) goes to a cheaper model: Claude Haiku, or a local model on your PC if one is running (an OpenAI-compatible server, default 127.0.0.1:8080). If the local one doesn't answer, Haiku does.

## 0.1.50

**The Dispatcher: one assistant that runs your sessions, works on the PC and listens to your voice.**

### The Dispatcher

- A special Claude session pinned above the session list in the web UI and the app ("create" the first time).
- It doesn't write code itself: it reads your sessions, writes to them on your behalf (marked as the Dispatcher in the chat), waits for the result and reports back. It can create new sessions and orchestrator tasks and picks the model by the job.
- It answers routine questions and permission requests of the sessions itself, but never says "yes" to irreversible things (git push, deletion, dropping tables): those stay with you.
- It answers briefly, the first line is the result.

### Working on the PC

- On Windows the Dispatcher gets hands: screenshot, click, type, hotkeys, launching and switching programs, clipboard. It uses Windows-MCP (MIT), pinned to a fixed version, with telemetry off and without its PowerShell, file, registry and process tools.
- Looking and clicking go without questions; typing, hotkeys and launching programs go through Claude's own safety check. Sending messages, paying, deleting: only after your "yes".
- While you are using the mouse or keyboard, it waits instead of fighting you for the cursor.
- "Show the screen" sends a screenshot right into the chat.
- Needs uv (winget install astral-sh.uv).

### Voice on the PC

- Start a phrase with "Krabik" ("Krabik, open Notepad"): the command goes to the Dispatcher and the beginning of the answer is played through the speakers. Said just "Krabik": wait for the beep and speak.
- Everything is local: Whisper on the GPU (CPU works too, slower), Piper for the voice. Phrases without the wake word go nowhere and are not logged.
- Turn it on in Settings → Computer → Voice on the PC; you can pick the microphone and see the log there. The first start downloads the speech models (a few gigabytes).
- Windows only for now, needs uv.

### Talk mode in the app

- Hold 🎤 and speak: release, and the message is sent by itself; when the agent finishes, the beginning of the answer is read aloud.
- On by default in the Dispatcher's chat, in other sessions: ⋯ → Talk mode.

## 0.1.49

**HTML files sent by the agent become live cards in the chat, and big pages run whole.**

### Live cards for HTML files

- When an agent sends an .html file to the chat, it now shows up as the same live card as an html block: run it in place, open full screen, view or copy the code.
- Pages up to 3 MB load by themselves; bigger ones have a "Show as a live page" button so the chat history does not pull megabytes on every open.
- Handy for heavy pages that do not fit into an answer, for example a 3D model packed into the page.

### Fixes

- "▶ Run" in the project viewer now runs big .html files whole. Before, the viewer handed over only the first 512 KB, and a large page silently hung.

## 0.1.48

**Live artifacts: when an agent answers with an HTML page, it runs right in the chat.**

### Live pages in the chat

- An html code block in an agent answer becomes a working page inside the chat: 3D scenes (three.js from a CDN), charts, interactive demos.
- Buttons on the card: full screen, restart, show the code, copy the code.
- While the agent is still writing the block, the card waits ("Assembling…") and starts once the block stops changing.
- The page runs isolated: it cannot see your token, the hub API, or the chat window. Links from it open in the browser.
- The hub adds a short hint to the agent's instructions so agents know they can answer this way. Turn it off with `"artifactsHint": false` in the config.

### HTML files in the project viewer

- An .html file in the project viewer has a "▶ Run" button that opens it as a live page. Sibling .js and .css files linked by relative paths are not loaded, so it suits all-in-one-file pages.

### Phone app

- The same live cards. In the chat feed the card only shows the page, so scrolling the chat still works; tap it to open full screen and interact.
- Mermaid diagrams are now drawn in the app too: fitted to the screen width in the chat, tap for full size with zoom. If the diagram cannot be drawn, the app shows its source and the reason.

## 0.1.47

**Copy agent answers on the phone: the whole answer or any part of it.**

### Copying in the app

- Every agent answer now has two buttons next to 🔊:
  - **⧉ Copy** puts the whole answer on the clipboard as one text, with list items and markdown kept.
  - **✂ Select** opens the answer full screen as a single text field. Hold a word, drag the selection handles across any number of paragraphs and list items, then "Copy". There is also "Copy all" at the top.
- Before, Android could only select inside one paragraph or one list item at a time.

## 0.1.46

**Layout comments right on the page: tap what looks wrong, the agent fixes it. Dev server previews through your own proxy.**

### Layout comments

- In the chat, open the dev server preview (▶) and pick "💬 comments" next to the port. The page opens with a 💬 button in the corner.
- "Pick an element", tap the thing you don't like, write what's wrong. "Bigger block" selects the parent if you hit something too small.
- Comments pile up as numbered marks on the page and survive a reload (hot reload too). Edit or delete them before sending.
- "Send to the agent" sends one message to this session's agent: your text, a CSS selector, a piece of HTML, size and key styles for each comment, plus a snapshot. A small element is captured together with the block around it and outlined in red, so the agent sees what it overlaps.
- Works on the phone too: big buttons, tap to pick.

### Previews through your own proxy

- If you reach the hub through your own reverse proxy (a NAS or a router with a public IP), add one more name on it pointing to the same hub address and port, and set it in Settings → Connection → Hub addresses → Preview address. Previews and layout comments then open through it, no Tailscale needed. Hot reload works too.
- Over Tailscale the preview now always uses the Tailscale address. Before, a home network address could be picked, and the preview didn't open from mobile data.

### Small things

- The release script refuses to publish notes with a bare `@name` outside code: GitHub turns it into a mention of a random user.

## 0.1.45

**A Telegram bot for any session, token usage with a calendar, `@` to mention project files.**

### `@` mentions files

- Type `@` in the message box: a list of the project's files and folders appears, like in an IDE. It narrows as you type, by name, by part of the path or by letters in order (`sbt` finds `sessionbot.ts`).
- Pick a file and `@path/to/file` goes into the message. Pick a folder and the list shows what is inside it. Names with spaces are quoted.
- Web: arrows, Enter or Tab to pick, Esc to close, or the mouse. App: tap.
- `.gitignore` is respected; `node_modules`, builds and caches are skipped.
- Claude Code reads the mentioned file by itself; opencode reads it with a tool.

### A Telegram bot for a session

- Connect your own bot (a token from `@BotFather`) to any session: chat header ✈ on the web, "⋯ → Telegram bot" in the app.
- Write to the bot and it goes to the agent of that session. Photos, documents, voice messages and albums land in the session folder. The answer and the files the agent sends come back to Telegram. Permission requests and simple questions come as buttons.
- Several people can use one bot: each connects with a one-time code or link. Each person has a name you can edit, and messages to the agent are signed with it, so the agent knows who is writing.
- The answer goes only to whoever asked. What you write in KraBness doesn't go to Telegram.
- Uses the same Telegram proxy as the notification bot. Files through the proxy are fixed (Telegram used to answer "there is no document in the request").

### Token usage

- Settings → Token usage: new tokens and cache reads by day, a calendar heat map, presets (today, 7 days, 30 days, this month) or your own period, breakdown by model and by session, and the cost as if paid by API.
- Every session shows its usage in the list and in the chat header.
- History from before the update is picked up once from Claude Code and opencode logs.

### Groups without your global rules

- A group checkbox "Without my global rules": Claude in the group's sessions skips `~/.claude/CLAUDE.md` and `~/.claude/rules`. Handy for chats that are not about code; put what you need into the group prompt.

### Small things

- Thinking level labels are now just `auto`, `high`, `max` and so on, and the field in the app header is narrower.

## 0.1.44

**Choose how hard the model thinks, stop a running task, see when a task is waiting for you.**

### Thinking effort

- Pick how hard the model thinks before answering: in the chat header next to the model, in the new session form, and separately for the worker and the reviewer of a task.
- Claude Code: `low`, `medium`, `high`, `xhigh`, `max`. opencode: each model has its own set (for example `low/high/max`); models without levels show no choice.
- Applies from the next message. Switching the model resets the level to the model default.

### Tasks

- **Stop**: a running, queued or waiting task can be stopped. The agents stop, the project copy is rolled back, the chats stay.
- **Waiting for you**: when an agent in a task asks for permission or asks a question, the task shows "waiting for your answer" in the list, in the counter and on the task page, with a button to the chat. Before, it silently looked like "running".
- **Continue a failed task**: everything the agent managed to do stays in the project copy. "Continue" sends the agent the error and asks it to finish.
- **One more round** now also sends the latest review if the worker hasn't seen it yet (when the review rounds ran out).
- **The copy is a boundary**: an opencode worker can't read or touch files outside its project copy; such requests are denied without asking you.
- **Fair review diff**: the review and the report count changes from the point where the copy branched off. Work merged into the main branch while the task was running is no longer shown as "removed by the task".
- Local models whose server is down are shown greyed out in the model list instead of disappearing, and the list refreshes when you open it.

## 0.1.43

**Tasks: give the hub a goal and get back a reviewed, tested change. Plus auto-checks after every agent turn.**

### Tasks

A task is a goal for a project ("add CSV export", "fix the sum and add a test"). The hub drives it from start to report:

1. The worker does the job in its own copy of the project (a separate git branch), in autonomous mode.
2. The project checks run, if you set them up (see below). A red check goes back to the worker to fix.
3. Another model reviews the diff.
4. The worker fixes the review remarks, then a second review. At most two rounds.
5. You get a report and a notification: what was done, changed files, checks, the review verdict.

Then it's your call: **Merge** (one squashed commit into the main branch), **One more round** (with your comment) or **Discard**. Nothing reaches the main branch without you.

- The worker and the reviewer are any model of any engine you have. By default the worker is Claude Code if you're signed in, otherwise your opencode model, and the reviewer is opencode (free models work fine). No Claude subscription is needed. The last choice is remembered.
- Tasks survive a hub restart and continue from the step they were on. A task that hits the Claude limit waits for the reset and goes on by itself.
- Task chats are hidden from the session list and open from the task page.
- Web UI: "Tasks" in the sidebar. App: the 🗂 button on the main screen.

### Task queue

- Choose how many tasks run at once (1 to 5, default 2). The rest wait in the queue and start when a slot frees up.
- "Start at night (02:00)": the task waits until then.
- When the whole queue is done, one summary notification arrives: how many are ready and how many broke.

### Auto-checks

- A project can have check commands: tests, typecheck, lint. The hub suggests them from `package.json`, `pyproject.toml`, Cargo or Go.
- With auto-check on, the commands run after every agent turn. The result shows up in the chat as a card with the output folded.
- A red check goes back to the agent with the tail of the output, up to 3 attempts. The same error twice in a row stops it, so it never loops.
- Web UI: the ✓ button in the chat header. App: ⋯ → Auto-check.

### Claude limit

- The limit banner has a new "Don't wait" button: it hands the session over to an opencode model right away. Otherwise the session waits for the reset and continues by itself, as before.
- Auto-check doesn't ping an agent that is waiting for the limit.

### Branch copies get dependencies

A session or task copy of the project now gets `node_modules` from the main project as links, so tests and typecheck work there right away. Workspace packages point to the copy itself, so the copy is checked against its own code. Deleting the copy removes only the links.

## 0.1.42

**Reach your PC without Tailscale, clickable file paths in the chat, settings by section.**

### Remote access through your own server

If Tailscale doesn't work from your phone (a VPN on the PC often breaks it on mobile data), the hub can now go through your own VPS:

- the PC keeps an outgoing SSH tunnel to the server, so nothing has to be opened on the PC or the router;
- the server serves the hub over HTTPS with a free Let's Encrypt certificate, no domain needed (`krab.<server-ip>.sslip.io`);
- one command sets up the server (Ubuntu or Debian): Caddy and a tunnel user whose key may only open this one tunnel. The command with your key is in Settings → Connection;
- the tunnel reconnects by itself, its status and a "Check" button are in the web UI and in the app.

Only paired devices get in, as before. Requests that come through the tunnel never count as local, even though they arrive from 127.0.0.1.

### Hub addresses

- New block in Settings → Connection → Hub addresses: every address the phone can use, with a check for each.
- Own addresses behind a reverse proxy: for example, a NAS on a public IP. They go into the pairing QR. `scripts\firewall-lan.ps1 -Proxy <proxy IP>` opens the hub port on the home network for the proxy only.
- An already paired app picks up new hub addresses by itself and uses whichever answers: Tailscale, your server or your proxy. `https://` addresses no longer get `:7420` appended.
- A listen address that disappeared (DHCP) no longer stops the hub from starting.

### Waking the PC without Tailscale

The wake relay can sit behind the same HTTPS reverse proxy, so the phone wakes the PC from any network. The relay checks the PC by its home address first.

### Clickable file paths

Paths in the agent's answers (`src/app.ts:42`, `docs/`, `[notes](docs/notes.md)`) open the project viewer right on that file. A line number is highlighted and scrolled to, a folder opens as a list. Works in the web UI and in the app.

### Settings by section

Settings now open as a short list: General, Agents, Connection, Notifications, Computer, Updates. Tap one to get just those settings. Same in the web UI and in the app.

## 0.1.41

**KraBness: your AI coding agents run on your PC, you drive them from your phone.**

A small hub on your Windows PC starts AI coding agents, and the web UI and the Android app show the same live session from anywhere. Start a task at your desk, approve a command from the couch, read the result on the bus.

### What's inside

- **Two engines:** [opencode](https://opencode.ai) with any model (OpenAI, OpenRouter, DeepSeek, Gemini, Kimi, GLM, free models, your own LM Studio or Ollama server) and the official Claude Code CLI on your Claude subscription or an Anthropic API key.
- **One live session everywhere:** web UI and Android app, reconnects and catches up by itself, message drafts are kept.
- **Approvals and agent questions** as buttons: in the app, in a notification or in Telegram.
- **Files both ways:** attach files, photos or a camera shot; the agent sends files back.
- **Project view without the agent:** git diff, file browser, editing text files, a mini terminal.
- **Context compaction:** one tap replaces a long history with a short summary, earlier messages fold away.
- **Notifications** from the app itself or via a Telegram bot (with SOCKS5/HTTP proxy support).
- **Session groups** with a shared prompt, a separate git branch per session, your own MCP servers and skills for both engines, continuing existing Claude Code sessions.
- **Extras:** Claude limits in % with auto-continue after a reset, dev-server preview on the phone, a screenshot of the PC screen, voice input and read-aloud, putting the PC to sleep and waking it up.
- **English and Russian** interface.
- **Updates in one tap:** the hub checks GitHub daily, installs signed releases only and rolls back if something fails.

## 0.1.40

- App: bold text with code inside (like **`src/app.ts`**) is shown as code, without the backticks.

## 0.1.39

- The installer offers to install what is missing: opencode and Claude Code (with npm), Tailscale (winget or the official installer, checked with SHA256).
- If opencode isn't installed, it still shows up in Settings -> Engines with a hint how to install it, instead of disappearing.
- Models and providers no longer show "Invalid URL" when opencode isn't running, but a clear message.

## 0.1.38

- Installer: works on a fresh Windows where PowerShell scripts are disabled (it calls npm.cmd instead of npm.ps1).
- Installer: if a previous run stopped halfway, it starts over instead of saying "already installed".
- Claude Code installed with npm (`npm i -g @anthropic-ai/claude-code`) is now found by the hub.

## 0.1.37

- The installer can now install Node.js by itself on Windows without winget: it downloads the official Node.js 24 LTS installer from nodejs.org, checks its SHA256 and installs it.
- Installer errors are shown as one clear red line instead of a PowerShell stack trace.

## 0.1.36

Security release, please update.

- Fixed: the device check could be bypassed with an encoded path, and a website open in the browser on the PC could reach the hub. Now every request is checked by the route it really goes to.
- Protection against DNS rebinding, and only the hub's own page counts as "local" (not any localhost port).
- Requests through a reverse proxy or tunnel need a device token.
- Network paths are rejected before they reach the disk.
- Telegram: only a private chat can be linked, and the link code changes after 5 wrong tries.
- Saved secrets of MCP servers and the Telegram proxy are not sent to a new address.
- Dev-server preview: a separate key per port, a malformed request no longer stops the hub.
- Updates are now signed: the hub installs only archives signed by the author's key.
- Screenshots in the README.

## 0.1.35

- Compact the context: the 🗜 button in the web chat header, or ⋯ → Compact the context in the app. The agent replaces a long history with a short summary and keeps working with what matters.
- The chat shows where the context was compacted and how many tokens it freed. Earlier messages collapse under "Show earlier messages", the summary is one tap away.
- Automatic compaction (when the context runs out) is shown the same way.
- Works with both Claude Code and opencode.

## 0.1.34

- Claude Code sign-in right in KraBness: Settings → Engines shows who is signed in (subscription and email, or an API key).
- "Sign in on the PC" opens the Claude Code sign-in on your PC, the status updates by itself.
- Your own Anthropic API key instead of a subscription: checked with Anthropic before saving, kept only on your PC.
- A clear message instead of "Not logged in" when Claude Code isn't signed in or isn't installed.
- The installer checks the Claude Code sign-in and tells you how to sign in.

## 0.1.33

- KraBness is now licensed under the GNU AGPL-3.0: use it, change it, share it, and keep modified versions open.
- Settings show the license and a link to the source code.

## 0.1.32

- Simpler notifications: the app shows them itself, and Telegram covers the case when Android has closed the app. No Firebase setup.
- The installer no longer stops on a harmless build warning in Windows PowerShell 5.

## 0.1.31

The first public release of KraBness: AI coding agents on your PC, controlled from your phone.

- opencode (any model) and the official Claude Code CLI in one place
- Web UI and Android app with the same live session, approvals, questions and files
- Notifications from the app or via a Telegram bot (with proxy support)
- Interface in English and Russian
- Updates from GitHub in one tap, with rollback
- Message drafts in the app survive switching sessions and app restarts

Install: `irm https://github.com/kamo4er/KraBness/releases/latest/download/install.ps1 | iex`

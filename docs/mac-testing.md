# Testing KraBness on a Mac

macOS support is in beta. Every change already runs on a real Mac in CI (Apple Silicon: unit tests, a clean install, restart, update and rollback), but some things only a person at a Mac can check. If you have 20 minutes, please go through this list and [open an issue](https://github.com/kamo4er/KraBness/issues) with the results (what macOS, Intel or Apple Silicon, what worked, what didn't, the last lines of `~/KraBness/data/logs/hub.log`).

## 1. Install

```bash
curl -fsSL https://github.com/kamo4er/KraBness/releases/latest/download/install.sh | bash
```

- [ ] The installer finishes and opens http://127.0.0.1:7420.
- [ ] It offered to install opencode and Claude Code, and they work: Settings → Agents shows them as engines.
- [ ] `~/KraBness/scripts/krabness status` says the hub answers.

## 2. Claude Code sign-in

- [ ] Settings → Agents → Claude → Sign in on the PC opens a Terminal window with `claude auth login`, and the sign-in in the browser works.

## 3. A session and a task

- [ ] A new session with opencode (a free model) answers.
- [ ] A session with Claude answers (if you have a subscription or an API key).
- [ ] The terminal in a session (⋯ → Files and changes → terminal) runs `git status`, `npm -v`, `brew -v` (if you use Homebrew): your usual PATH works there.
- [ ] A task on a git project goes through to "ready" and "Merge" works.

## 4. Phone

- [ ] With Tailscale on the Mac and the phone, the Android app pairs by the QR code (Settings → Connect a device) and shows the sessions.
- [ ] A permission request from an agent arrives on the phone, and "Allow" works.

## 5. Mac things

- [ ] Settings → Computer → PC screen: macOS asks for the Screen Recording permission; after you allow it (and restart KraBness: `krabness restart`), the screenshot shows your screen, not just the wallpaper.
- [ ] "Sleep" from the phone puts the Mac to sleep.
- [ ] Preview of a dev server: start one (for example `npx vite` in a project) and check that it appears in the ▶ menu of the session.
- [ ] Did macOS show any other permission prompts (Documents, Desktop, network)? Which ones, and when?

## 6. Restart, autostart, update

- [ ] Settings → Computer → Restart hub: the page reconnects by itself.
- [ ] After a reboot and login the hub is running again (if you said yes to autostart).
- [ ] When a new release comes out: Settings → Updates → Update installs it.

## 7. Remove

- [ ] `~/KraBness/scripts/krabness uninstall` stops the hub and removes the launchd agent. The folder `~/KraBness` with your data stays; delete it yourself if you want.

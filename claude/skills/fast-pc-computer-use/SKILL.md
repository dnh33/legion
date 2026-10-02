---
name: "fast-pc-computer-use"
description: "Use before any computer use on Daniel's Windows PC: pick the no-GUI route first, grant apps once, jump to the right monitor, batch actions and verify via shell instead of screenshots."
---

# Fast computer use on Daniel's PC

Every GUI round trip costs seconds, and each extra screenshot costs tokens. Goal: **as few tool calls as possible, no exploring.**

## 0. Do you need the GUI at all? (usually not)

Prefer, in order:
1. `device_bash`: git, files, scripts, `curl`, ssh to servers. Check state here instead of screenshots.
2. APIs and databases. To test a web app logged in:
   - create a test user via the app's API (e.g. `POST /api/auth/sign-up/email`);
   - mark it verified or give it data with SQL (`docker exec <db> psql`);
   - drive the pages with Playwright **in the cloud** (API sign-in via `page.request.post`, which sets the cookies).
   Don't click through sign-up forms or mail.
3. The built-in browser, for web pages on the PC.
4. Desktop GUI (`computer_*`) **only** when the credential or state lives in a desktop app. Example: pushing to GitHub needs GitHub Desktop, because nothing else on the PC or in the cloud is logged in.

## 1. Get access in ONE round

- Call `computer_resolve_access` once, with **every** app you will touch. Include the **window process basename**, not just the launcher name. Example: `["GitHub Desktop", "githubdesktop.exe"]`.
  - Windows apps often open their window from a worker process with a versioned path (`...\app-3.6.6\githubdesktop.exe`).
  - Auto-updates change that path, so **re-resolve every session**. Never reuse an old bundleId.
  - If screenshots say `"<name>.exe" was hidden`, that basename is what's missing: resolve it and request it.
- Then one `computer_request_access` with all returned entries, passing `willHide` and `screenshotFiltering` verbatim.
- Clicking the desktop, taskbar or Start menu needs a grant for `"File Explorer"`. Avoid those clicks and use `computer_open_application` instead.
- Terminals, PowerShell and IDEs are **click-only** (no typing or keys). Never plan work that types into them; use `device_bash`.

## 2. Screens

- There are two monitors: `"24G2W1G4"` and `"24G2W1G4 (2)"`. **Apps open on `"24G2W1G4 (2)"`, the primary.**
- Right after `computer_open_application`, call `computer_switch_display("24G2W1G4 (2)")`, then take one screenshot.
- The `request_access` result lists `windowLocations`: use it to know the display without looking.
- Take screenshots at `scale: 0.5` for navigation. Use `zoom` on a region only when small text matters.
- If the app isn't visible after opening (minimized, or restarted after an update), call `computer_open_application` again. Don't hunt around.

## 3. Act in batches

- **Focus first.** After `open_application`, Claude's own window still has keyboard focus, so key presses fail. The first action is a `left_click` inside the target window's body; not the taskbar, and not blank desktop.
- Put predictable sequences in **one** `computer_batch`: click, type, key, a short wait, then **one** screenshot at the end. Coordinates refer to the screenshot taken before the batch.
- Prefer keyboard shortcuts to menus. GitHub Desktop:
  - `ctrl+o` = add local repository;
  - `ctrl+shift+t` = fetch;
  - `ctrl+p` = push / publish;
  - the big blue button in the middle does the obvious next step.
- Waits: 2–4 s for UI changes, around 8 s for network actions. Never wait longer; verify instead.

## 4. Verify without the GUI

Check the result where it's cheap, not with extra screenshots:
- git: `git branch -vv` (in sync with `origin/main`, nothing "ahead");
- web: `curl -s -o /dev/null -w '%{http_code}'`;
- server: `ssh … 'docker ps'`.

Take a GUI screenshot only when something failed and you need to read an error dialog.

## 5. Known flows (copy them)

**Publish or push a repo with GitHub Desktop** (Daniel is logged in there; nowhere else is):
1. Resolve and request `GitHub Desktop` + `githubdesktop.exe`.
2. `open_application`, `switch_display("24G2W1G4 (2)")`, screenshot at 0.5.
3. If the repo isn't loaded: `ctrl+o`, type the path (e.g. `D:\localnaut`), click **Add repository**.
4. New repo: click **Publish repository**, keep **Keep this code private** checked, org None, click **Publish repository**. Existing repo: click the **Push origin** button, or `ctrl+p` after a click inside the window.
5. Verify with `device_bash`: `git branch -vv`.

If GitHub refuses because of a private email, rewrite the commits to `3074491+dnh33@users.noreply.github.com`. Don't ask Daniel to change his GitHub settings.

## 6. Things that aren't allowed, so don't try

- Typing passwords, tokens or card numbers into any field.
- Creating accounts on external services.
- Solving CAPTCHAs.

If a step needs one of these, ask Daniel to do that one step, then continue.
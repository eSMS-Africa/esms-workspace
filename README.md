# eSMS Workspace

The eSMS suite - **Email, SMS, SMPP and admin** - in a native desktop window for
macOS, Windows and Linux. System notifications, an unread badge, and background
auto-updates. Built with Electron.

Download page: <https://esmsafrica.io/workspace>

## What it does

- **One window, four services.** A left rail switches between Email
  (`send.esmsafrica.io`), SMS (`sms.esmsafrica.io`), SMPP (`smpp.esmsafrica.io`)
  and Admin (`auth.esmsafrica.io/admin`). Each is a persistent view sharing one
  session, so you **sign in once** (central auth) and switch freely.
- **System notifications** - the web apps' notifications become native ones.
- **Unread badge** - dock/taskbar badge aggregated across services (from each
  page's title, e.g. a leading `(3)`).
- **Auto-updates** - new versions download in the background from GitHub Releases
  (`electron-updater`) and apply on restart.
- **External links open in your browser** - anything outside `esmsafrica.io`.
- Menu / shortcuts: ⌘/Ctrl+1..4 switch service, ⌘/Ctrl+R reload the current one.

## Develop

```bash
npm install
npm start
```

## Build installers locally

```bash
npm run dist          # current OS
npm run dist:mac      # universal .dmg
npm run dist:win      # .exe (NSIS)
npm run dist:linux    # AppImage + .deb
```

Output lands in `dist/`.

## Release (produces the downloads the site links to)

Tag a version and push - the **Release** workflow builds on macOS, Windows and
Linux runners and publishes the installers to this repo's GitHub Releases with
stable names:

```bash
npm version patch        # bumps package.json + creates a git tag
git push --follow-tags
```

Assets published to `releases/latest/download/`:

| Platform | Asset |
|----------|-------|
| macOS (universal) | `eSMS-Workspace-mac-universal.dmg` |
| Windows (x64) | `eSMS-Workspace-win-x64.exe` |
| Linux (AppImage) | `eSMS-Workspace-x86_64.AppImage` |
| Linux (Debian/Ubuntu) | `eSMS-Workspace-amd64.deb` |

## Code signing (optional but recommended)

Unsigned builds work (macOS users run the one-line installer or `xattr -cr`).
For signed/notarized builds, add these repo secrets - the workflow uses them
automatically:

- **macOS:** `CSC_LINK` (base64 .p12), `CSC_KEY_PASSWORD`, plus `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for notarization.
- **Windows:** `CSC_LINK`, `CSC_KEY_PASSWORD`.

## Notes for the web apps

The unread badge reads a leading `(N)` from each service's page title. To drive
it, have a service set e.g. `document.title = "(3) Inbox - eSMS Mail"`. Native
notifications work out of the box via the standard `Notification` API.

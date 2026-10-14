# eSMS Workspace

The eSMS suite - **Email, SMS, SMPP, Admin, Links, Support and Help** - in a native
desktop window for macOS, Windows and Linux. One shared login session, a native left
rail, system notifications, an unread badge, and background auto-updates. Built with
Electron.

Download page: <https://esmsafrica.io/workspace>

## What it is

Each product is a live eSMS web app; Workspace wraps them as persistent `<webview>`
panes on one pan/switch shell, all sharing a single session partition (`persist:esms`),
so you **sign in once** through central auth and switch freely between products. A left
rail (native traffic lights inset on macOS) drives the switching.

- **One window, seven panes.** Email (`send.esmsafrica.io`), SMS (`sms.esmsafrica.io`),
  SMPP (`smpp.esmsafrica.io`), Admin (`auth.esmsafrica.io/admin`), eSMS Links
  (`links.esmsafrica.io`), Support (`console.esmsafrica.io`), and Help
  (`esmsafrica.io/help`, at the foot of the rail).
- **Role-gated panes.** Admin and Support stay hidden until central auth confirms the
  signed-in user's roles. The app makes one authenticated call to `auth.esmsafrica.io/auth/me`
  on the shared session (on launch, on focus, and periodically), derives entitlements, and
  only then reveals - and only then loads - a gated pane. Losing access bounces you out and
  unloads the pane.
- **In-app auth and payments.** Google / GitHub OAuth and Paystack checkout are treated as
  **trusted hosts** and kept inside the shared session (popups open as child windows on the
  same `persist:esms` partition), so sign-in and card top-ups complete in the app instead of
  being ejected to the system browser and losing the session. Every other off-domain link
  opens in the real browser.
- **First-party password vault.** Login forms on eSMS origins can save their password,
  encrypted by the OS keychain (macOS Keychain / Windows DPAPI / Linux libsecret) via
  Electron `safeStorage`, and auto-fill next time - similar to Safari's password manager but
  working the same on all three platforms. Never touches non-eSMS pages.
- **Deep links.** `esmsworkspace://email`, `esmsworkspace://sms`, etc. focus the app and jump
  straight to that pane.
- **Remembers its place.** Window size and position persist across launches.
- **System notifications** and clipboard access are granted to eSMS pages (everything else
  denied); the web apps' notifications become native ones.
- **Unread badge.** Dock / taskbar badge (Windows overlay icon) aggregated across panes from a
  leading `(N)` in each page's title.
- **Auto-updates.** New versions download in the background from GitHub Releases
  (`electron-updater`) and apply on restart; unsigned macOS builds that can't self-install fall
  back to opening the release download page.
- **Self-recovery.** A crashed shell renderer or service pane reloads itself.

## Tech stack

- **Electron `^32.2.0`** (main + preload + renderer), `nodeIntegration: false`,
  `contextIsolation: true`, `webviewTag: true`.
- **electron-updater `^6.3.9`** for GitHub-Releases auto-updates.
- **electron-builder `^25.1.8`** for packaging/publishing installers.
- No renderer framework - plain HTML/CSS/JS shell. App version currently **0.4.2**.

## Project structure

| Path | Purpose |
|------|---------|
| `main.js` | Electron main process: window + persisted bounds, single-instance lock, deep-link protocol (`esmsworkspace://`), application menu, in-app vs external navigation rules (internal eSMS + trusted auth/payment hosts), password vault IPC (`safeStorage`), badge/overlay, identity + role entitlements (`/auth/me`), and auto-update flow. |
| `preload.js` | Context-isolated bridge exposing `window.esms` (open-external, badge, switch/reload service, entitlements, update status, vault count/clear, sign out) and the `<webview>` preload path. |
| `webview-preload.js` | Runs inside every service webview - the first-party password vault (find fields, fill, offer to save) for eSMS login pages only. Unpacked from the asar. |
| `renderer/index.html` | Shell markup: splash, left rail, panes stage, settings menu, update toast (with a strict CSP). |
| `renderer/app.js` | Builds the panes/webviews, pane switching, lazy-loading + hiding of gated panes, unread parsing, update banner, settings/account menu. |
| `renderer/style.css` | Shell styling. |
| `build/icon.png` | App icon (electron-builder `buildResources`). |
| `install.sh` | One-line macOS installer: downloads the latest `.dmg`, installs to `/Applications`, de-quarantines (unsigned), launches. |
| `.github/workflows/release.yml` | Tag-triggered multi-OS build + publish to GitHub Releases, plus a checksums job. |

## Local development

```bash
npm install
npm start        # electron .
```

## Build installers locally

```bash
npm run dist          # current OS (electron-builder)
npm run dist:mac      # universal .dmg + .zip
npm run dist:win      # NSIS .exe (x64)
npm run dist:linux    # AppImage + .deb
```

Output lands in `dist/`.

## Build and release (CI/CD)

Releases are cut by **git tag**. Pushing a `v*` tag runs the **Release** workflow
(`.github/workflows/release.yml`), which builds on macOS, Windows and Linux runners and
`electron-builder --publish always` uploads the installers to this repo's GitHub Releases;
a follow-up job publishes `SHA256SUMS.txt`.

```bash
npm version patch     # bumps package.json + creates a git tag
git push --follow-tags
```

Assets published to `releases/latest/download/` (stable names):

| Platform | Asset |
|----------|-------|
| macOS (universal) | `eSMS-Workspace-mac-universal.dmg` |
| Windows (x64, NSIS) | `eSMS-Workspace-win-x64.exe` |
| Linux (AppImage) | `eSMS-Workspace-x86_64.AppImage` |
| Linux (Debian/Ubuntu) | `eSMS-Workspace-amd64.deb` |

## Configuration

The app itself needs no runtime configuration - it points at the fixed eSMS production
hosts. The only env vars are CI/build secrets consumed by the Release workflow:

- **GitHub publish:** `GH_TOKEN` (the workflow's `GITHUB_TOKEN`).
- **Signing (optional).** Unsigned builds ship today (`CSC_IDENTITY_AUTO_DISCOVERY=false`).
  To sign/notarize, add repo secrets - macOS: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`; Windows: `CSC_LINK`, `CSC_KEY_PASSWORD`.

## Menus and shortcuts

- **Workspace menu:** switch service with **Cmd/Ctrl+1..6** (Email, SMS, SMPP, Admin, eSMS
  Links, Support), **Reload service** on **Cmd/Ctrl+R** (reloads only the active pane, not the
  shell), plus Check for Updates.
- **View menu is custom** - it keeps zoom / fullscreen / devtools but deliberately drops the
  default Reload / Force-Reload, which also bind Cmd/Ctrl+R and would tear down every pane by
  reloading the whole shell.
- **Rail settings menu:** reload all services, check for updates, clear saved logins, and sign
  out everywhere (wipes the shared session).

## Security model

- Panes and popups stay in the app only for `https://*.esmsafrica.io` plus the trusted
  sign-in / checkout hosts (Google, GitHub, Paystack, Pesapal); anything else opens in the
  system browser, and only `http(s)`, `mailto` and `tel` links are ever handed to the OS.
- The saved-logins vault is keyed by the calling page's own origin, so one eSMS subdomain can
  never read another's saved password. Shell-only IPC (badge, vault admin, sign-out, updates)
  is accepted only from the app window.
- Notifications and clipboard are granted to eSMS pages only.
- `npm test` runs syntax checks plus `test/main.test.cjs`, which drives `main.js` against a
  mocked Electron (no Electron download needed).

## Notes for the web apps

- **Unread badge** reads a leading `(N)` (or `N unread`) from each service's page title. To
  drive it, set e.g. `document.title = "(3) Inbox - eSMS Mail"`.
- **Desktop notifications** work out of the box via the standard `Notification` API.
- Every webview request carries `eSMSWorkspace/<version>` in the user-agent, so backends can
  see who is on the desktop app.

## Related services

Wraps these live eSMS products, all behind central auth (`auth.esmsafrica.io`):
eSMS Mail (`send.esmsafrica.io`), SMS app (`sms.esmsafrica.io`), SMPP client portal
(`smpp.esmsafrica.io`), the auth/super-admin console (`auth.esmsafrica.io/admin`), eSMS Links
(`links.esmsafrica.io`), Support console (`console.esmsafrica.io`), and the Help center
(`esmsafrica.io/help`).

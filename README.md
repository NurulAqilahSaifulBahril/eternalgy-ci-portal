# Eternalgy C&I Portal

Commercial-department portal for solar C&I projects, packaged as a Windows desktop app.

Nine modules: Sales Pipeline, Project Management (with customisable stages), Material List,
Solar Design, Savings Analysis, GITA Doc Checklist, Installation Reports, KPI Dashboard, and
an admin-only IT Admin page.

## Install

Download `Eternalgy-CI-Portal-Setup-<version>.exe` from the
[latest release](https://github.com/NurulAqilahSaifulBahril/eternalgy-ci-portal/releases/latest)
and run it.

Windows SmartScreen will warn that the publisher is unknown, because the installer is not
code-signed. Choose **More info → Run anyway**. Signing it requires buying a code-signing
certificate.

The app checks GitHub Releases for a newer version on launch, downloads it in the background,
and then offers a **Restart now** bar. Nothing installs until you agree, so an update can't
interrupt an edit in progress. There is also **File → Check for Updates…**.

## Signing in

First launch seeds one administrator account:

| Username | Password   |
|----------|------------|
| `admin`  | `admin123` |

You are forced to change that password immediately. Add colleagues from **IT Admin → Users**.
Usernames may contain spaces; capitals and extra spaces are ignored when signing in.

> **Scope of the sign-in.** This is an accountability layer, not a security boundary. The whole
> app runs locally, so anyone who opens developer tools can reach the underlying data directly.
> It gives every change a named author and keeps casual users out of IT Admin. It does not
> protect data from someone technical. Real access control would need a server.

## Where data lives

Everything is stored in the app's own local storage on that machine — there is no backend and
no server call. Consequences worth knowing:

- Data is **per machine, per install**. Two people running the app do not see each other's data.
- Moving data between machines is the **Backup (.json) / Restore backup** pair in the sidebar.
- App updates preserve data. The app is served over a fixed `app://portal` origin precisely so
  storage survives a version change.
- Backup files contain user password hashes. They are salted and stretched, but a backup is
  not something to pass around casually.

## Edit log

Every change is recorded with the signed-in user, timestamp, module, record, field, and the
before/after values, visible under **IT Admin → Edit log** with filters and CSV export. Sign-ins,
failed sign-ins and account changes are logged too. The log keeps the most recent 3000 entries.

## Development

```bash
npm install
npm start        # run the desktop app
npm run web      # or serve just the page at http://localhost:5173
```

The entire UI is one self-contained file, `index.html` — no build step, no framework, no
external requests apart from Google Fonts.

| File | Purpose |
|------|---------|
| `index.html` | The whole portal: markup, styles, and all application logic |
| `main.js` | Electron main process — window, `app://` protocol, auto-updater, menu |
| `preload.js` | The only renderer bridge: update-ready notification and restart |
| `server.js` | Plain static server for browser-based development |
| `build/icon.ico` | Application icon |

## Releasing

Bump `version` in `package.json`, commit, then:

```bash
npm run release
```

This builds the NSIS installer and publishes it to GitHub Releases along with `latest.yml`,
the feed the auto-updater reads. Requires `GH_TOKEN` in the environment with `repo` scope.

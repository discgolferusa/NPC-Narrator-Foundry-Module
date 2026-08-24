# Foundry package checklist

This module is packaged to behave like a normal Foundry VTT module.

## Required layout

```text
Data/modules/npc-narrator/
  module.json
  LICENSE
  README.md
  CHANGELOG.md
  scripts/
  styles/
  templates/
  lib/signalr.min.js
```

Folder name **must** equal `module.json` → `id` (`npc-narrator`).

## Manifest fields Foundry cares about

| Field | Purpose |
|-------|---------|
| `id` / `title` / `description` / `version` | Identity + update detection |
| `compatibility.minimum` / `verified` | Core version gate |
| `esmodules` / `styles` | Loaded when the module is enabled |
| `manifest` | Stable URL Foundry polls for updates (`…/releases/latest/download/module.json`) |
| `download` | **Version-specific** zip for this release (`…/releases/download/vX.Y.Z/module.zip`) |
| `url` / `bugs` / `changelog` / `license` | Listing / support metadata |

## Release automation

Push to `main` runs `.github/workflows/package-on-main.yml`:

1. Tests
2. Builds `dist/module.zip` + `dist/module.json`
3. Creates/updates GitHub release tag `v{version}` from `module.json`

**Important:** bump `version` in `module.json` whenever you want Foundry clients to see an update. Re-publishing the same version refreshes assets but will not prompt already-installed worlds to update.

## SignalR

Pairing uses SignalR. Foundry CSP often blocks CDN scripts, so the browser build is vendored at `lib/signalr.min.js` and must ship inside `module.zip`.

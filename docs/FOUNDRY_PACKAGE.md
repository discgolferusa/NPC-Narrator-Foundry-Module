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
2. **Computes the next version automatically** (patch +1 from the latest `v*` release tag; first release uses `module.json`)
3. Writes that version into `module.json` and commits it with `[skip ci]`
4. Builds `dist/module.zip` + `dist/module.json`
5. Creates/updates GitHub release tag `v{version}`

You do **not** need to bump `version` for ordinary updates. To jump to a new major/minor (e.g. `1.0.0`), set that version in `module.json` once and merge — CI will publish it, then resume patch bumps from there.

## SignalR

Pairing uses SignalR. Foundry CSP often blocks CDN scripts, so the browser build is vendored at `lib/signalr.min.js` and must ship inside `module.zip`.

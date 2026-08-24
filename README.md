# NPC Narrator — Foundry VTT Module

Foundry VTT **v13–v14** module that links a world to an [NPC Narrator](https://github.com/discgolferusa/NPC-Yaml-Editor-CSharp) campaign.

## Features

- GM pairs the world with a one-time code from the DM console (same pattern as Discord)
- Registers as a campaign **device** (`role: foundry`) on SignalR
- **System-agnostic Actor sheet header button** → map party member / Narrator NPC
- **GM authoring wizards** (create-only): Actor → Create Narrator NPC; Scene → Create Narrator Location
- Mappings stored by **actor id** / **scene id** in world settings (duplicated docs start unmapped)
- Token HUD: **Chat** or **Whisper** with an NPC (name-match + override)
- Replies post to Foundry chat as **Narrator** and **NPC** lines
- Whisper replies stay private to the sending player (+ GMs)
- TTS follows the GM’s existing audio recipient (e.g. Discord)
- **GM Sync Narrator portrait** on a mapped Actor: downloads the closed-mouth still and sets sheet + prototype token art (and updates placed tokens when possible)

## Install

Every push to `main` publishes a versioned Foundry package (`module.zip` + `module.json`) to GitHub Releases. The patch version is **bumped automatically** so Foundry can detect updates without hand-editing `module.json`.

### Install from Foundry UI (recommended)

In Foundry Setup: **Add-on Modules → Install Module**, paste:

```text
https://github.com/discgolferusa/NPC-Narrator-Foundry-Module/releases/latest/download/module.json
```

Foundry downloads the zip, places it under `Data/modules/npc-narrator/`, and can later check that same manifest URL for updates when `version` increases.

### Unzip into Foundry (manual)

1. Download [`module.zip`](https://github.com/discgolferusa/NPC-Narrator-Foundry-Module/releases/latest/download/module.zip).
2. Unzip into Foundry `Data/modules/` so you have `Data/modules/npc-narrator/module.json` (folder name must match `module.json` `id`).
3. Enable **NPC Narrator** in the world module list.
4. Open **Configure Settings → Module Settings → NPC Narrator**:
   - **Yaml Editor base URL** defaults to `https://www.npcnarrator.com` (change only if you self-host)
   - Use **Campaign pairing → Bind / Unbind** and paste a one-time pairing code from the DM console

### Appear in Foundry’s public module browser

Install-via-URL works immediately after a release. Listing in Foundry’s built-in package directory is a separate one-time creator step:

1. Create a Foundry account and open the [package submission form](https://foundryvtt.com/packages/submit/).
2. Package URL: `https://github.com/discgolferusa/NPC-Narrator-Foundry-Module`
3. For each published version, submit the **version-specific** manifest (not `/latest/`), e.g.  
   `https://github.com/discgolferusa/NPC-Narrator-Foundry-Module/releases/download/v0.2.9/module.json`
4. After approval, each new `main` merge auto-bumps the patch version and publishes a release. For the Foundry website listing, add each new **version-specific** manifest URL in the package admin (or use Foundry’s package release API).

See Foundry’s [package release notes](https://foundryvtt.wiki/en/development/guides/releases-and-history) for why `/latest/` is for clients, while the website listing needs a pinned release manifest.

### Local package (optional)

```bash
npm ci
npm run package
```

Creates `dist/module.zip` (top-level folder `npc-narrator/`, including `lib/signalr.min.js`).

## GM setup

1. In NPC Narrator DM console → Player Invites → **Generate Foundry Pairing Code**.
2. In Foundry: Module Settings → **Campaign pairing → Bind / Unbind** (or `/narrator bind` / `game.npcNarrator.bind()`), paste the code.
3. Set **Campaign text output** → Specific device → the Foundry device.
4. Set **Campaign audio output** as desired (e.g. Discord).
5. Open any Actor sheet → **NPC Narrator** header button (or right-click Actor Directory → Map actor).
6. After mapping a Narrator NPC (and assigning a talking portrait in the DM Campaign Editor), use **Sync Narrator portrait** on the Actor sheet (or **Sync portrait** in the mapping dialog) so Foundry uses the same closed-mouth still players see.

### Create Narrator content from Foundry (GM)

Requires an active bind. Wizards are **create-only** (no overwrite of existing YAML). TTS voice sample is not offered in Foundry — the server applies template voice defaults.

1. **Actor → NPC:** Actor sheet header **Create Narrator NPC**, or Actor Directory → **NPC Narrator: Create NPC…**
   - Prefills name (and biography text into Role when available).
   - On success, writes `npcOverrides[actorId]` and refreshes the NPC catalog.
   - If the actor is already mapped, opens mapping instead of creating another link.
2. **Scene → Location:** Scene config header **Create Narrator Location**, or Scene Directory → **NPC Narrator: Create Location…**
   - Prefills name; summary from the scene’s linked journal page when present.
   - On success, writes `locationMaps[sceneId]` so the new location appears in later NPC wizards.

API: `game.npcNarrator.createNpcFromActor(actor)`, `game.npcNarrator.createLocationFromScene(scene)`

## Player setup

- Open your character sheet → **NPC Narrator** header button → choose party member
- Or `/narrator character` (uses assigned character / selected token)

## Talking to NPCs (players)

Foundry does **not** open the Token HUD (or any context menu) when a player right-clicks an NPC they do not own. This module adds its own menu:

1. **Hover** the NPC token (targeting alone is optional).
2. **Right-click** → **Chat** or **Whisper**.

**Chat** posts the player line and Narrator/NPC replies into the **global Foundry chat log**. **Whisper** is private to the sender and GMs.

Also available:
- `/narrator chat` / `/narrator whisper` (uses targeted / hovered token)
- **Alt+C** / **Alt+W** (Configure Controls)
- Token layer toolbar buttons (when Foundry shows them)
- GM Token HUD icons (when the HUD opens)

## Chat commands

| Command | Who | Action |
|---------|-----|--------|
| `/narrator bind` | GM | Open bind dialog |
| `/narrator character` | Anyone | Map assigned/selected actor |
| `/narrator chat` | Anyone | Chat with targeted NPC |
| `/narrator whisper` | Anyone | Whisper to targeted NPC |
| `/narrator status` | Anyone | Show bind status |

## Mapping storage (copy-safe)

| Map | Storage | Behavior on actor duplicate |
|-----|---------|-----------------------------|
| Party member (GM) | world `partyMaps[actorId]` | New actor id → blank |
| Party member (player) | user flag `partyMaps[actorId]` | New actor id → blank |
| Narrator NPC | world `npcOverrides[actorId]` (GM only) | New actor id → blank |
| Narrator Location | world `locationMaps[sceneId]` (GM only) | New scene id → blank |

API: `game.npcNarrator.mapActor(actor)`, `game.npcNarrator.syncPortrait(actor)`

## Architecture

```text
Foundry module → Yaml Editor (pairing, Bearer APIs, SignalR)
              → Middleware (/npc-turn with include_audio)
```

See yaml-editor `docs/FOUNDRY_INTEGRATION.md` and this repo’s `docs/FOUNDRY_PACKAGE.md` for packaging / Foundry listing notes.

## License

Proprietary — see `LICENSE`. You may use the module with Foundry / NPC Narrator;
redistribution, resale, and modification for redistribution are not allowed.


- Chat and dialog content from the API / LLM is HTML-escaped before render.
- Bind / unbind are GM-only (`openBindDialog`, `bindWithPairingCode`, `unbindSession`, `game.npcNarrator.bind/unbind`).
- **Follow-up:** the campaign Bearer session token is currently stored in a Foundry **world** setting and is readable by all clients. A future redesign should use per-user short-lived tokens or a GM-only proxy so players never hold the campaign Bearer.

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

## Install

1. Copy this folder into Foundry `Data/modules/npc-narrator` (folder name must match `module.json` `id`).
2. Enable **NPC Narrator** in the world module list.
3. Open **Configure Settings → Module Settings → NPC Narrator**:
   - **Yaml Editor base URL** defaults to `https://www.npcnarrator.com` (change only if you self-host)
   - Use **Campaign pairing → Bind / Unbind** and paste a one-time pairing code from the DM console

## GM setup

1. In NPC Narrator DM console → Player Invites → **Generate Foundry Pairing Code**.
2. In Foundry: Module Settings → **Campaign pairing → Bind / Unbind** (or `/narrator bind` / `game.npcNarrator.bind()`), paste the code.
3. Set **Campaign text output** → Specific device → the Foundry device.
4. Set **Campaign audio output** as desired (e.g. Discord).
5. Open any Actor sheet → **NPC Narrator** header button (or right-click Actor Directory → Map actor).

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

API: `game.npcNarrator.mapActor(actor)`

## Architecture

```text
Foundry module → Yaml Editor (pairing, Bearer APIs, SignalR)
              → Middleware (/npc-turn with include_audio)
```

See yaml-editor `docs/FOUNDRY_INTEGRATION.md`.

## Security notes

- Chat and dialog content from the API / LLM is HTML-escaped before render.
- Bind / unbind are GM-only (`openBindDialog`, `bindWithPairingCode`, `unbindSession`, `game.npcNarrator.bind/unbind`).
- **Follow-up:** the campaign Bearer session token is currently stored in a Foundry **world** setting and is readable by all clients. A future redesign should use per-user short-lived tokens or a GM-only proxy so players never hold the campaign Bearer.

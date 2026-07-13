# NPC Narrator — Foundry VTT Module

Foundry VTT **v13–v14** module that links a world to an [NPC Narrator](https://github.com/discgolferusa/NPC-Yaml-Editor-CSharp) campaign.

## Features

- GM pairs the world with a one-time code from the DM console (same pattern as Discord)
- Registers as a campaign **device** (`role: foundry`) on SignalR
- **System-agnostic Actor sheet header button** → map party member / Narrator NPC
- Mappings stored by **actor id** in world settings (duplicated actors start unmapped)
- Token HUD: **Chat** or **Whisper** with an NPC (name-match + override)
- Replies post to Foundry chat as **Narrator** and **NPC** lines
- Whisper replies stay private to the sending player (+ GMs)
- TTS follows the GM’s existing audio recipient (e.g. Discord)

## Install

1. Copy this folder into Foundry `Data/modules/npc-narrator` (folder name must match `module.json` `id`).
2. Enable **NPC Narrator** in the world module list.
3. Open **Configure Settings → Module Settings → NPC Narrator**:
   - Set **Yaml Editor base URL** (HTTPS origin, no trailing slash)
   - Paste a **Pairing code** from the DM console and Save, **or** use **Campaign pairing → Bind / Unbind**

## GM setup

1. In NPC Narrator DM console → Player Invites → **Generate Foundry Pairing Code**.
2. In Foundry: Module Settings → paste the pairing code (or `/narrator bind` / `game.npcNarrator.bind()`).
3. Set **Campaign text output** → Specific device → the Foundry device.
4. Set **Campaign audio output** as desired (e.g. Discord).
5. Open any Actor sheet → **NPC Narrator** header button (or right-click Actor Directory → Map actor).

## Player setup

- Open your character sheet → **NPC Narrator** header button → choose party member
- Or `/narrator character` (uses assigned character / selected token)

## Talking to NPCs (players)

Players usually **cannot** open the Token HUD on NPC tokens they do not own. Use targeting instead:

1. **Target** the NPC token (Target tool, or double-click / `T` while hovering — depending on your Foundry version).
2. Then either:
   - Click **Chat** / **Whisper** tools on the left **Token** scene controls toolbar
   - Type `/narrator chat` or `/narrator whisper`
   - Press **Alt+C** (chat) or **Alt+W** (whisper) — remappable in Configure Controls
   - Or `game.npcNarrator.chat()` / `game.npcNarrator.whisper()` from a macro

GMs who can open the Token HUD still get the chat/whisper icons there.

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

API: `game.npcNarrator.mapActor(actor)`

## Architecture

```text
Foundry module → Yaml Editor (pairing, Bearer APIs, SignalR)
              → Middleware (/npc-turn with include_audio)
```

See yaml-editor `docs/FOUNDRY_INTEGRATION.md`.

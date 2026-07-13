# NPC Narrator — Foundry VTT Module

Foundry VTT **v13–v14** module that links a world to an [NPC Narrator](https://github.com/discgolferusa/NPC-Yaml-Editor-CSharp) campaign.

## Features

- GM pairs the world with a one-time code from the DM console (same pattern as Discord)
- Registers as a campaign **device** (`role: foundry`) on SignalR
- Players map their Foundry user to a party character (auto name-match + override)
- Token HUD: **Chat** or **Whisper** with an NPC (name-match + GM override)
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
5. Right-click actors in the sidebar → **NPC Narrator: Map to NPC** when name match fails.

## Player setup

- `/narrator character` — confirm or change party character mapping
- Select an NPC token → Token HUD chat / whisper icons

## Chat commands

| Command | Who | Action |
|---------|-----|--------|
| `/narrator bind` | GM | Open bind dialog |
| `/narrator character` | Anyone | Character mapping |
| `/narrator status` | Anyone | Show bind status |

## Architecture

```text
Foundry module → Yaml Editor (pairing, Bearer APIs, SignalR)
              → Middleware (/npc-turn with include_audio)
```

See yaml-editor `docs/FOUNDRY_INTEGRATION.md`.

# Changelog

All notable releases of the NPC Narrator Foundry module are published as GitHub Releases:

https://github.com/discgolferusa/NPC-Narrator-Foundry-Module/releases

## 0.2.9

- Package SignalR client (`lib/signalr.min.js`) into the installable zip (required for pairing under Foundry CSP).
- Align `module.json` with Foundry install/update fields (`manifest`, versioned `download`, `bugs`, `changelog`, `LICENSE`).
- Publish versioned `module.zip` on every push to `main` so Foundry can install/update like other modules.
- Automatically bump the patch version on each `main` release so Foundry update checks work without hand-editing `module.json`.
- Use a proprietary license (personal Foundry use only; no resale or redistribution of modifications).

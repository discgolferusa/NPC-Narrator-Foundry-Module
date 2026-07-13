/**
 * NPC Narrator — Foundry VTT module (v13–v14)
 * Talks only to the Yaml Editor edge (never middleware directly).
 */

const MODULE_ID = "npc-narrator";
const FLAG_SCOPE = MODULE_ID;

/** @type {import("@microsoft/signalr").HubConnection | null} */
let hubConnection = null;
let heartbeatTimer = null;
let partyCharactersCache = null;
let npcsCache = null;

function editorBaseUrl() {
  return String(game.settings.get(MODULE_ID, "editorBaseUrl") || "").replace(/\/+$/, "");
}

function getSession() {
  return game.settings.get(MODULE_ID, "session") || null;
}

async function setSession(session) {
  await game.settings.set(MODULE_ID, "session", session);
}

function authHeaders() {
  const session = getSession();
  if (!session?.sessionToken) return {};
  return { Authorization: `Bearer ${session.sessionToken}` };
}

async function apiFetch(path, options = {}) {
  const base = editorBaseUrl();
  if (!base) throw new Error("Set the Yaml Editor base URL in module settings.");
  const headers = {
    Accept: "application/json",
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...authHeaders(),
    ...(options.headers || {}),
  };
  const response = await fetch(`${base}${path}`, { ...options, headers });
  let data = null;
  const text = await response.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { response, data };
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function nameMatchScore(a, b) {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) return 0;
  if (left === right) return 100;
  if (left.includes(right) || right.includes(left)) return 80;
  return 0;
}

function bestNameMatch(name, items, nameKey = "name") {
  let best = null;
  let bestScore = 0;
  for (const item of items || []) {
    const score = nameMatchScore(name, item[nameKey]);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return bestScore >= 80 ? best : null;
}

async function ensureSignalR() {
  if (globalThis.signalR?.HubConnectionBuilder) return;
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/@microsoft/signalr@8.0.7/dist/browser/signalr.min.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load SignalR client."));
    document.head.appendChild(script);
  });
}

async function stopHub() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (hubConnection) {
    try {
      await hubConnection.stop();
    } catch {
      /* ignore */
    }
    hubConnection = null;
  }
}

async function startHub() {
  const session = getSession();
  const base = editorBaseUrl();
  if (!session?.sessionToken || !base) return;

  await ensureSignalR();
  await stopHub();

  hubConnection = new signalR.HubConnectionBuilder()
    .withUrl(`${base}/hubs/campaign-audio`, {
      accessTokenFactory: () => session.sessionToken,
    })
    .withAutomaticReconnect()
    .build();

  hubConnection.on("campaignText", (payload) => {
    void handleCampaignText(payload);
  });

  hubConnection.onreconnected(async () => {
    await hubConnection.invoke(
      "JoinAsFoundry",
      session.sessionToken,
      session.deviceLabel || `Foundry ${game.world?.id || ""}`
    );
  });

  await hubConnection.start();
  await hubConnection.invoke(
    "JoinAsFoundry",
    session.sessionToken,
    session.deviceLabel || `Foundry ${game.world?.id || ""}`
  );

  heartbeatTimer = setInterval(() => {
    hubConnection?.invoke("Heartbeat").catch(() => {});
  }, 30000);

  ui.notifications.info("NPC Narrator: connected to campaign channel.");
}

async function refreshCatalogs() {
  const session = getSession();
  if (!session?.sessionToken) {
    partyCharactersCache = null;
    npcsCache = null;
    return;
  }
  try {
    const party = await apiFetch("/api/foundry/party/characters");
    if (party.response.ok) {
      partyCharactersCache = party.data?.characters || party.data?.members || [];
    }
    const npcs = await apiFetch("/api/foundry/npcs");
    if (npcs.response.ok) {
      npcsCache = npcs.data?.npcs || [];
    }
  } catch (err) {
    console.warn(`${MODULE_ID} catalog refresh failed`, err);
  }
}

function getPlayerMapping() {
  return game.user.getFlag(FLAG_SCOPE, "playerId") || null;
}

async function setPlayerMapping(playerId) {
  await game.user.setFlag(FLAG_SCOPE, "playerId", playerId || null);
}

function getNpcOverrides() {
  return game.settings.get(MODULE_ID, "npcOverrides") || {};
}

async function setNpcOverride(actorId, npcId) {
  const map = { ...getNpcOverrides() };
  if (!npcId) delete map[actorId];
  else map[actorId] = npcId;
  await game.settings.set(MODULE_ID, "npcOverrides", map);
}

function resolvePlayerIdForUser() {
  const mapped = getPlayerMapping();
  if (mapped) return mapped;

  const actor =
    game.user.character ||
    canvas.tokens?.controlled?.[0]?.actor ||
    game.actors?.find((a) => a.isOwner && a.type === "character");

  if (!actor || !partyCharactersCache?.length) return null;
  const match = bestNameMatch(actor.name, partyCharactersCache, "name");
  return match?.player_id || match?.id || null;
}

function resolveNpcIdForToken(token) {
  const actor = token?.actor;
  if (!actor) return null;
  const overrides = getNpcOverrides();
  if (overrides[actor.id]) return overrides[actor.id];

  if (!npcsCache?.length) return null;
  const match = bestNameMatch(token.name || actor.name, npcsCache, "name");
  return match?.id || null;
}

function whisperTargets(foundryUserId) {
  const ids = new Set();
  if (foundryUserId) ids.add(foundryUserId);
  for (const user of game.users) {
    if (user.isGM) ids.add(user.id);
  }
  return [...ids];
}

async function postChatLine({ content, alias, role, visibility, foundryUserId }) {
  if (!content?.trim()) return;

  const isWhisper = visibility === "whisper";
  const data = {
    content: content.trim(),
    speaker: { alias: alias || (role === "narrator" ? "Narrator" : "NPC") },
    type: CONST.CHAT_MESSAGE_TYPES?.OTHER ?? 0,
  };

  if (role === "narrator") {
    data.flags = { [MODULE_ID]: { role: "narrator" } };
  }

  if (isWhisper) {
    data.whisper = whisperTargets(foundryUserId);
  }

  // Prefer create with speaker alias; fall back to GM attribution for narration if needed.
  try {
    await ChatMessage.create(data);
  } catch (err) {
    console.warn(`${MODULE_ID} chat create failed`, err);
    if (role === "narrator") {
      const gm = game.users.find((u) => u.isGM);
      await ChatMessage.create({
        ...data,
        speaker: ChatMessage.getSpeaker({ user: gm || game.user }),
        content: `<em>[Narrator]</em> ${content.trim()}`,
      });
    }
  }
}

async function handleCampaignText(payload) {
  if (!payload) return;
  const visibility = payload.visibility || "chat";
  const foundryUserId = payload.foundry_user_id || null;

  if (visibility === "whisper" && foundryUserId && foundryUserId !== game.user.id && !game.user.isGM) {
    return;
  }

  if (payload.role === "player" && payload.player_text) {
    // Outgoing player lines are echoed by the local turn poster for chat mode.
    return;
  }

  if (payload.role === "narrator" && (payload.narration_text || payload.npc_text)) {
    await postChatLine({
      content: payload.narration_text || payload.npc_text,
      alias: "Narrator",
      role: "narrator",
      visibility,
      foundryUserId,
    });
    return;
  }

  if (payload.role === "npc" && (payload.dialogue_text || payload.npc_text)) {
    await postChatLine({
      content: payload.dialogue_text || payload.npc_text,
      alias: payload.npc_name || "NPC",
      role: "npc",
      visibility,
      foundryUserId,
    });
    return;
  }

  // Combined / legacy payloads
  if (payload.narration_text) {
    await postChatLine({
      content: payload.narration_text,
      alias: "Narrator",
      role: "narrator",
      visibility,
      foundryUserId,
    });
  }
  if (payload.dialogue_text) {
    await postChatLine({
      content: payload.dialogue_text,
      alias: payload.npc_name || "NPC",
      role: "npc",
      visibility,
      foundryUserId,
    });
  } else if (payload.npc_text && !payload.narration_text) {
    await postChatLine({
      content: payload.npc_text,
      alias: payload.npc_name || "NPC",
      role: "npc",
      visibility,
      foundryUserId,
    });
  }
}

async function bindWithPairingCode(pairingToken) {
  const worldId = game.world?.id;
  if (!worldId) throw new Error("World id unavailable.");
  const base = editorBaseUrl();
  if (!base) throw new Error("Set the Yaml Editor base URL in module settings.");

  const raw = await fetch(`${base}/api/foundry/sessions`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      pairing_token: pairingToken,
      world_id: worldId,
      device_label: `Foundry ${game.world?.title || worldId}`,
    }),
  });
  const sessionData = await raw.json();
  if (!raw.ok) {
    throw new Error(sessionData?.error || "Pairing failed.");
  }

  await setSession({
    sessionToken: sessionData.session_token,
    campaignId: sessionData.campaign_id,
    ownerUserId: sessionData.owner_user_id,
    worldId: sessionData.world_id,
    channelKey: sessionData.channel_key,
    expiresAt: sessionData.expires_at,
    deviceLabel: `Foundry ${game.world?.title || worldId}`,
  });

  await refreshCatalogs();
  await startHub();
  return sessionData;
}

async function unbindSession() {
  await stopHub();
  await setSession(null);
  partyCharactersCache = null;
  npcsCache = null;
  ui.notifications.info("NPC Narrator: unbound from campaign.");
}

async function sendNpcTurn({ text, npcId, visibility }) {
  const playerId = resolvePlayerIdForUser();
  if (!playerId) {
    throw new Error("Map your Foundry character to a party member first (NPC Narrator → Character mapping).");
  }
  if (!npcId) {
    throw new Error("Could not match this token to an NPC. Ask the GM to set an NPC override.");
  }

  const requestId = foundry.utils.randomID?.() || crypto.randomUUID();
  const { response, data } = await apiFetch("/api/foundry/npc-turn", {
    method: "POST",
    body: JSON.stringify({
      text,
      player_id: playerId,
      npc_id: npcId,
      visibility,
      foundry_user_id: game.user.id,
      request_id: requestId,
    }),
  });

  if (!response.ok) {
    throw new Error(data?.error || `NPC turn failed (${response.status})`);
  }

  if (visibility === "chat") {
    await postChatLine({
      content: text,
      alias: game.user.character?.name || game.user.name,
      role: "player",
      visibility: "chat",
    });
  } else {
    await postChatLine({
      content: text,
      alias: game.user.character?.name || game.user.name,
      role: "player",
      visibility: "whisper",
      foundryUserId: game.user.id,
    });
  }

  return data;
}

async function promptMessage(token, visibility) {
  const npcId = resolveNpcIdForToken(token);
  const npcName = token?.name || token?.actor?.name || "NPC";
  const title = visibility === "whisper" ? `Whisper to ${npcName}` : `Chat with ${npcName}`;

  if (!npcId && !game.user.isGM) {
    ui.notifications.error("Could not match this token to an NPC. Ask the GM to map it.");
    return;
  }

  let resolvedNpcId = npcId;
  if (!resolvedNpcId && game.user.isGM) {
    resolvedNpcId = await pickNpcId(npcName);
    if (!resolvedNpcId) return;
    if (token.actor) await setNpcOverride(token.actor.id, resolvedNpcId);
  }

  const content = `
    <div class="npc-narrator-dialog">
      <p class="npc-narrator-status">${resolvedNpcId ? `NPC: <code>${resolvedNpcId}</code>` : ""}</p>
      <div class="form-group">
        <label>Message</label>
        <textarea id="npc-narrator-text" rows="4" style="width:100%"></textarea>
      </div>
    </div>`;

  const result = await new Promise((resolve) => {
    new Dialog({
      title,
      content,
      buttons: {
        send: {
          icon: '<i class="fas fa-paper-plane"></i>',
          label: "Send",
          callback: (html) => {
            const text = html.find("#npc-narrator-text").val();
            resolve(String(text || "").trim());
          },
        },
        cancel: {
          label: "Cancel",
          callback: () => resolve(null),
        },
      },
      default: "send",
    }).render(true);
  });

  if (!result) return;
  try {
    await sendNpcTurn({ text: result, npcId: resolvedNpcId, visibility });
    ui.notifications.info("NPC Narrator: message sent.");
  } catch (err) {
    ui.notifications.error(err.message || String(err));
  }
}

async function pickNpcId(hintName) {
  await refreshCatalogs();
  const options = (npcsCache || [])
    .map((n) => `<option value="${n.id}">${n.name} (${n.id})</option>`)
    .join("");
  if (!options) {
    ui.notifications.error("No NPCs available from NPC Narrator.");
    return null;
  }
  const match = bestNameMatch(hintName, npcsCache, "name");
  return new Promise((resolve) => {
    new Dialog({
      title: "Select NPC Narrator record",
      content: `<div class="form-group"><label>NPC</label><select id="npc-narrator-npc">${options}</select></div>`,
      buttons: {
        ok: {
          label: "Use",
          callback: (html) => resolve(html.find("#npc-narrator-npc").val()),
        },
        cancel: { label: "Cancel", callback: () => resolve(null) },
      },
      default: "ok",
      render: (html) => {
        if (match?.id) html.find("#npc-narrator-npc").val(match.id);
      },
    }).render(true);
  });
}

async function openCharacterMapping() {
  await refreshCatalogs();
  const chars = partyCharactersCache || [];
  if (!chars.length) {
    ui.notifications.warn("No party characters loaded. Bind the world first.");
    return;
  }
  const current = getPlayerMapping() || resolvePlayerIdForUser() || "";
  const options = chars
    .map((c) => {
      const id = c.player_id || c.id;
      const label = c.label || c.name || id;
      return `<option value="${id}" ${id === current ? "selected" : ""}>${label}</option>`;
    })
    .join("");

  new Dialog({
    title: "NPC Narrator — Character mapping",
    content: `
      <p>Associate your Foundry user with a party character for NPC turns.</p>
      <div class="form-group">
        <label>Party character</label>
        <select id="npc-narrator-player">${options}</select>
      </div>`,
    buttons: {
      save: {
        label: "Save",
        callback: async (html) => {
          const id = html.find("#npc-narrator-player").val();
          await setPlayerMapping(id);
          ui.notifications.info("Character mapping saved.");
        },
      },
      cancel: { label: "Cancel" },
    },
    default: "save",
  }).render(true);
}

async function openBindDialog() {
  const session = getSession();
  const status = session
    ? `Bound to campaign <code>${session.campaignId}</code>`
    : "Not bound.";
  const currentUrl = editorBaseUrl();

  new Dialog({
    title: "NPC Narrator — Bind world",
    content: `
      <div class="npc-narrator-dialog">
        <p class="npc-narrator-status ${session ? "ok" : ""}">${status}</p>
        <p>Paste the one-time pairing code from the DM console (Player Invites → Foundry VTT).</p>
        <div class="form-group">
          <label>Yaml Editor base URL</label>
          <input type="text" id="npc-narrator-url" style="width:100%" value="${currentUrl.replace(/"/g, "&quot;")}" placeholder="https://editor.example.com" />
        </div>
        <div class="form-group">
          <label>Pairing code</label>
          <input type="text" id="npc-narrator-pairing" style="width:100%" placeholder="Paste pairing code" autocomplete="off" />
        </div>
      </div>`,
    buttons: {
      bind: {
        icon: '<i class="fas fa-link"></i>',
        label: "Bind",
        callback: async (html) => {
          const url = String(html.find("#npc-narrator-url").val() || "").trim().replace(/\/+$/, "");
          const code = String(html.find("#npc-narrator-pairing").val() || "").trim();
          if (!url) {
            ui.notifications.error("Set the Yaml Editor base URL first.");
            return;
          }
          if (!code) {
            ui.notifications.error("Paste a pairing code.");
            return;
          }
          try {
            await game.settings.set(MODULE_ID, "editorBaseUrl", url);
            await bindWithPairingCode(code);
            await game.settings.set(MODULE_ID, "pairingCode", "");
            ui.notifications.info("NPC Narrator: world bound.");
          } catch (err) {
            ui.notifications.error(err.message || String(err));
          }
        },
      },
      unbind: {
        label: "Unbind",
        callback: async () => {
          await unbindSession();
        },
      },
      cancel: { label: "Close" },
    },
    default: "bind",
  }).render(true);
}

/**
 * Settings application opened from Configure Settings → "Bind / Unbind".
 * Pairing codes are one-time and are not stored permanently.
 */
class NpcNarratorPairingMenu extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "npc-narrator-pairing-menu",
      title: "NPC Narrator — Campaign pairing",
      classes: ["npc-narrator-dialog"],
      template: `modules/${MODULE_ID}/templates/pairing.hbs`,
      width: 480,
      height: "auto",
      closeOnSubmit: false,
      submitOnChange: false,
    });
  }

  getData() {
    const session = getSession();
    const campaignId = session?.campaignId
      ? String(session.campaignId).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
      : "";
    return {
      editorBaseUrl: editorBaseUrl(),
      statusHtml: session
        ? `Bound to campaign <code>${campaignId}</code>`
        : "Not bound to a campaign yet.",
      bound: Boolean(session?.sessionToken),
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find(".npc-narrator-unbind").on("click", async (event) => {
      event.preventDefault();
      await unbindSession();
      this.render(true);
    });
  }

  async _updateObject(_event, formData) {
    const url = String(formData.editorBaseUrl || "").trim().replace(/\/+$/, "");
    const code = String(formData.pairingCode || "").trim();
    if (!url) {
      ui.notifications.error("Set the Yaml Editor base URL first.");
      return;
    }
    await game.settings.set(MODULE_ID, "editorBaseUrl", url);
    if (!code) {
      ui.notifications.warn("Enter a pairing code to bind, or use Unbind.");
      return;
    }
    try {
      await bindWithPairingCode(code);
      await game.settings.set(MODULE_ID, "pairingCode", "");
      ui.notifications.info("NPC Narrator: world bound.");
      this.render(true);
    } catch (err) {
      ui.notifications.error(err.message || String(err));
    }
  }
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "editorBaseUrl", {
    name: "Yaml Editor base URL",
    hint: "HTTPS origin of NPC Yaml Editor (no trailing slash), e.g. https://editor.example.com",
    scope: "world",
    config: true,
    type: String,
    default: "",
    restricted: true,
  });

  game.settings.register(MODULE_ID, "pairingCode", {
    name: "Pairing code",
    hint: "Paste a one-time code from the DM console, then Save Changes to bind — or use Configure Settings → NPC Narrator → Bind / Unbind.",
    scope: "world",
    config: true,
    type: String,
    default: "",
    restricted: true,
    onChange: (value) => {
      // Defer until ready so bind helpers and notifications exist.
      if (!game.ready || !game.user?.isGM) return;
      const code = String(value || "").trim();
      if (!code) return;
      void (async () => {
        try {
          if (!editorBaseUrl()) {
            ui.notifications.error("Set Yaml Editor base URL before pairing.");
            return;
          }
          await bindWithPairingCode(code);
          // Clear the one-time code from settings after a successful bind.
          await game.settings.set(MODULE_ID, "pairingCode", "");
          ui.notifications.info("NPC Narrator: world bound from settings.");
        } catch (err) {
          ui.notifications.error(err.message || String(err));
        }
      })();
    },
  });

  game.settings.registerMenu(MODULE_ID, "pairingMenu", {
    name: "Campaign pairing",
    label: "Bind / Unbind",
    hint: "Open the pairing form to paste a code from the DM console, bind this world, or unbind.",
    icon: "fas fa-link",
    type: NpcNarratorPairingMenu,
    restricted: true,
  });

  game.settings.register(MODULE_ID, "session", {
    name: "Foundry session",
    scope: "world",
    config: false,
    type: Object,
    default: null,
  });

  game.settings.register(MODULE_ID, "npcOverrides", {
    name: "NPC token overrides",
    scope: "world",
    config: false,
    type: Object,
    default: {},
  });
});

Hooks.once("ready", async () => {
  game.npcNarrator = {
    bind: openBindDialog,
    mapCharacter: openCharacterMapping,
    refresh: refreshCatalogs,
    unbind: unbindSession,
  };

  const session = getSession();
  if (session?.sessionToken) {
    try {
      await refreshCatalogs();
      await startHub();
    } catch (err) {
      console.warn(`${MODULE_ID} reconnect failed`, err);
      ui.notifications.warn("NPC Narrator: could not reconnect. Re-bind if the session expired.");
    }
  }

  if (partyCharactersCache?.length && !getPlayerMapping()) {
    const guessed = resolvePlayerIdForUser();
    if (guessed) await setPlayerMapping(guessed);
  }
});

Hooks.on("getActorDirectoryEntryContext", (_html, options) => {
  if (!game.user.isGM) return;
  options.push({
    name: "NPC Narrator: Map to NPC",
    icon: '<i class="fas fa-theater-masks"></i>',
    callback: async (li) => {
      const actorId = li.data("documentId") || li.data("entryId") || li.attr("data-document-id");
      const actor = game.actors.get(actorId);
      if (!actor) return;
      const npcId = await pickNpcId(actor.name);
      if (npcId) {
        await setNpcOverride(actor.id, npcId);
        ui.notifications.info(`Mapped ${actor.name} → ${npcId}`);
      }
    },
  });
});

Hooks.on("renderTokenHUD", (hud, html) => {
  const token = hud.object;
  if (!token?.actor) return;
  const root = html instanceof jQuery ? html : $(html);
  const col = root.find(".col.right");
  if (!col.length) return;

  const chatBtn = $(`<div class="control-icon" title="Chat with NPC (Narrator)"><i class="fas fa-comments"></i></div>`);
  const whisperBtn = $(`<div class="control-icon" title="Whisper to NPC (Narrator)"><i class="fas fa-user-secret"></i></div>`);
  chatBtn.on("click", () => promptMessage(token, "chat"));
  whisperBtn.on("click", () => promptMessage(token, "whisper"));
  col.append(chatBtn, whisperBtn);
});

Hooks.on("chatMessage", (_log, message) => {
  if (!message.startsWith("/narrator")) return true;
  const parts = message.split(/\s+/);
  const cmd = parts[1];
  if (cmd === "bind" && game.user.isGM) {
    openBindDialog();
    return false;
  }
  if (cmd === "character") {
    openCharacterMapping();
    return false;
  }
  if (cmd === "status") {
    const s = getSession();
    ChatMessage.create({
      content: s
        ? `NPC Narrator bound to <code>${s.campaignId}</code>`
        : "NPC Narrator is not bound.",
      whisper: [game.user.id],
    });
    return false;
  }
  return true;
});

console.log(`${MODULE_ID} | Loaded`);

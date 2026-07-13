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

function savedPairingCode() {
  return String(game.settings.get(MODULE_ID, "pairingCode") || "").trim();
}

function getSession() {
  const session = game.settings.get(MODULE_ID, "session");
  if (!session || typeof session !== "object" || !session.sessionToken) return null;
  return session;
}

async function setSession(session) {
  await game.settings.set(MODULE_ID, "session", session || {});
}

async function clearSavedPairingCode() {
  const current = savedPairingCode();
  if (!current) return;
  if (!game.npcNarrator) game.npcNarrator = {};
  game.npcNarrator._clearingPairingCode = true;
  try {
    await game.settings.set(MODULE_ID, "pairingCode", "");
  } finally {
    game.npcNarrator._clearingPairingCode = false;
  }
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
    // Load from the module (Foundry CSP often blocks CDN scripts).
    script.src = `modules/${MODULE_ID}/lib/signalr.min.js`;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load SignalR client from the module lib folder."));
    document.head.appendChild(script);
  });
  if (!globalThis.signalR?.HubConnectionBuilder) {
    throw new Error("SignalR loaded but HubConnectionBuilder is missing.");
  }
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
      // Bearer token auth — do not send cookies. Credentials + ACAO:* is blocked by browsers
      // when Foundry (e.g. http://localhost:30000) talks to the Yaml Editor origin.
      withCredentials: false,
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

function getPartyMaps() {
  return game.settings.get(MODULE_ID, "partyMaps") || {};
}

/** Player-writable actor → party maps (world settings require GM). */
function getUserPartyMaps() {
  return game.user.getFlag(FLAG_SCOPE, "partyMaps") || {};
}

async function setPartyMap(actorId, playerId) {
  if (!actorId) return;
  if (!game.user.isGM) {
    throw new Error("Only a GM can write world party maps.");
  }
  const map = { ...getPartyMaps() };
  if (!playerId) delete map[actorId];
  else map[actorId] = playerId;
  await game.settings.set(MODULE_ID, "partyMaps", map);
}

async function setUserPartyMap(actorId, playerId) {
  if (!actorId) return;
  const map = { ...getUserPartyMaps() };
  if (!playerId) delete map[actorId];
  else map[actorId] = playerId;
  await game.user.setFlag(FLAG_SCOPE, "partyMaps", map);
}

/**
 * Persist party mapping: GM → world setting; players → user flag (same actor-id keying).
 */
async function savePartyMap(actorId, playerId) {
  if (game.user.isGM) await setPartyMap(actorId, playerId);
  else await setUserPartyMap(actorId, playerId);
  if (game.user.character?.id === actorId) {
    await setPlayerMapping(playerId || null);
  }
}

/** @deprecated Legacy per-user fallback; prefer partyMaps[actorId]. */
function getPlayerMapping() {
  return game.user.getFlag(FLAG_SCOPE, "playerId") || null;
}

/** @deprecated Legacy per-user fallback; prefer savePartyMap. */
async function setPlayerMapping(playerId) {
  await game.user.setFlag(FLAG_SCOPE, "playerId", playerId || null);
}

function getNpcOverrides() {
  return game.settings.get(MODULE_ID, "npcOverrides") || {};
}

async function setNpcOverride(actorId, npcId) {
  if (!actorId) return;
  if (!game.user.isGM) {
    throw new Error("Only a GM can write Narrator NPC maps.");
  }
  const map = { ...getNpcOverrides() };
  if (!npcId) delete map[actorId];
  else map[actorId] = npcId;
  await game.settings.set(MODULE_ID, "npcOverrides", map);
}

function guessPartyPlayerId(actor) {
  if (!actor || !partyCharactersCache?.length) return null;
  const match = bestNameMatch(actor.name, partyCharactersCache, "name");
  return match?.player_id || match?.id || null;
}

function guessNpcId(actor) {
  if (!actor || !npcsCache?.length) return null;
  const match = bestNameMatch(actor.name, npcsCache, "name");
  return match?.id || null;
}

/**
 * Resolve Narrator party member for an Actor.
 * World partyMaps (GM) → user partyMaps[actorId] → legacy user flag → name match.
 * Actor-id keys mean duplicated actors start unmapped.
 */
function resolvePlayerIdForActor(actor) {
  if (!actor) return null;
  const mapped = getPartyMaps()[actor.id];
  if (mapped) return mapped;

  const userMapped = getUserPartyMaps()[actor.id];
  if (userMapped) return userMapped;

  // Legacy: single user flag when this is the user's assigned character.
  if (game.user.character?.id === actor.id) {
    const legacy = getPlayerMapping();
    if (legacy) return legacy;
  }

  return guessPartyPlayerId(actor);
}

function resolvePlayerIdForUser() {
  const actor =
    game.user.character ||
    canvas.tokens?.controlled?.[0]?.actor ||
    game.actors?.find((a) => a.isOwner);
  return resolvePlayerIdForActor(actor) || getPlayerMapping();
}

function resolveNpcIdForActor(actor) {
  if (!actor) return null;
  const overrides = getNpcOverrides();
  if (overrides[actor.id]) return overrides[actor.id];
  return guessNpcId(actor);
}

function resolveNpcIdForToken(token) {
  return resolveNpcIdForActor(token?.actor);
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

async function bindWithPairingCode(pairingToken, options = {}) {
  const worldId = game.world?.id;
  if (!worldId) throw new Error("World id unavailable.");

  const base = String(options.baseUrl || editorBaseUrl() || "").replace(/\/+$/, "");
  if (!base) throw new Error("Set the Yaml Editor base URL in module settings.");

  const code = String(pairingToken || "").trim();
  if (!code) throw new Error("Pairing code is required.");

  if (options.persistUrl) {
    await game.settings.set(MODULE_ID, "editorBaseUrl", base);
  }

  let raw;
  try {
    raw = await fetch(`${base}/api/foundry/sessions`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        pairing_token: code,
        world_id: worldId,
        device_label: `Foundry ${game.world?.title || worldId}`,
      }),
    });
  } catch (err) {
    throw new Error(
      `Could not reach Yaml Editor at ${base}. Check the URL, that the editor is running, and that HTTPS/CORS allow Foundry (${err.message || err}).`
    );
  }

  const responseText = await raw.text();
  let sessionData = null;
  try {
    sessionData = responseText ? JSON.parse(responseText) : null;
  } catch {
    throw new Error(
      `Yaml Editor returned non-JSON (${raw.status}) from ${base}/api/foundry/sessions. Is Foundry support deployed on this editor? Body: ${responseText.slice(0, 180)}`
    );
  }

  if (!raw.ok) {
    throw new Error(sessionData?.error || `Pairing failed (HTTP ${raw.status}).`);
  }

  if (!sessionData?.session_token) {
    throw new Error("Pairing response missing session_token.");
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

  await clearSavedPairingCode();

  try {
    await refreshCatalogs();
  } catch (err) {
    console.warn(`${MODULE_ID} catalog refresh after bind failed`, err);
  }

  try {
    await startHub();
  } catch (err) {
    console.warn(`${MODULE_ID} SignalR connect after bind failed`, err);
    ui.notifications.warn(
      `Bound to campaign, but live text channel failed: ${err.message || err}. Reload the world or re-bind after checking the editor URL.`
    );
  }

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

/**
 * Players usually cannot open the Token HUD on unowned NPCs.
 * Prefer a single targeted token; fall back to controlled / hovered.
 * @returns {Token|null}
 */
function resolveNpcToken() {
  const targets = [...(game.user.targets || [])].filter((t) => t?.actor);
  if (targets.length === 1) return targets[0];
  if (targets.length > 1) {
    ui.notifications.warn("NPC Narrator: target exactly one NPC token.");
    return null;
  }

  const controlled = (canvas.tokens?.controlled || []).filter((t) => t?.actor);
  if (controlled.length === 1) return controlled[0];
  if (controlled.length > 1) {
    ui.notifications.warn("NPC Narrator: select or target exactly one NPC token.");
    return null;
  }

  const hover = canvas.tokens?.hover;
  if (hover?.actor) return hover;

  ui.notifications.warn(
    "NPC Narrator: target an NPC token first (double-click or use the Target tool). Players usually cannot open the Token HUD on NPCs."
  );
  return null;
}

async function promptMessageForTargetedNpc(visibility) {
  const token = resolveNpcToken();
  if (!token) return;
  await promptMessage(token, visibility);
}

async function promptMessage(token, visibility) {
  if (!token?.actor) {
    ui.notifications.warn("NPC Narrator: that token has no actor.");
    return;
  }

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
    if (token.actor) {
      try {
        await setNpcOverride(token.actor.id, resolvedNpcId);
      } catch (err) {
        console.warn(`${MODULE_ID} could not save NPC override`, err);
      }
    }
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

function tokenFromContextApplication(application, li) {
  const doc =
    application?.document ||
    application?.placeable?.document ||
    application?.object?.document ||
    null;
  if (doc?.object) return doc.object;
  if (doc?.id && canvas.tokens?.get) {
    const t = canvas.tokens.get(doc.id);
    if (t) return t;
  }
  const tokenId =
    li?.dataset?.documentId ||
    li?.dataset?.tokenId ||
    li?.[0]?.dataset?.documentId ||
    li?.[0]?.dataset?.tokenId;
  if (tokenId && canvas.tokens?.get) return canvas.tokens.get(tokenId);
  return canvas.tokens?.hover || null;
}

function addTokenNarratorContextOptions(application, menuItems) {
  menuItems.push(
    {
      name: "NPC Narrator: Chat",
      icon: '<i class="fas fa-comments"></i>',
      callback: (li) => {
        const token = tokenFromContextApplication(application, li);
        if (token) void promptMessage(token, "chat");
        else void promptMessageForTargetedNpc("chat");
      },
    },
    {
      name: "NPC Narrator: Whisper",
      icon: '<i class="fas fa-user-secret"></i>',
      callback: (li) => {
        const token = tokenFromContextApplication(application, li);
        if (token) void promptMessage(token, "whisper");
        else void promptMessageForTargetedNpc("whisper");
      },
    }
  );
}

/** Token layer tools for players who cannot open the NPC Token HUD. */
function registerTokenLayerNarratorTools(controls) {
  const makeTool = (name, title, icon, visibility) => ({
    name,
    title,
    icon,
    button: true,
    order: visibility === "chat" ? 90 : 91,
    onChange: (_event, active) => {
      if (active) void promptMessageForTargetedNpc(visibility);
    },
    onClick: () => void promptMessageForTargetedNpc(visibility),
  });

  const chatTool = makeTool(
    "npc-narrator-chat",
    "NPC Narrator: Chat with targeted NPC",
    "fas fa-comments",
    "chat"
  );
  const whisperTool = makeTool(
    "npc-narrator-whisper",
    "NPC Narrator: Whisper to targeted NPC",
    "fas fa-user-secret",
    "whisper"
  );

  // Foundry v13+ scene controls may be a record keyed by control name.
  if (controls && !Array.isArray(controls)) {
    const tokenControl = controls.tokens || controls.token;
    if (!tokenControl) return;
    tokenControl.tools = tokenControl.tools || {};
    if (Array.isArray(tokenControl.tools)) {
      tokenControl.tools.push(chatTool, whisperTool);
    } else {
      tokenControl.tools[chatTool.name] = chatTool;
      tokenControl.tools[whisperTool.name] = whisperTool;
    }
    return;
  }

  if (Array.isArray(controls)) {
    const tokenControl = controls.find((c) => c.name === "token" || c.name === "tokens");
    if (!tokenControl) return;
    if (!Array.isArray(tokenControl.tools)) tokenControl.tools = [];
    tokenControl.tools.push(chatTool, whisperTool);
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

async function openActorNarratorMapping(actor) {
  if (!actor) {
    ui.notifications.warn("Open an Actor sheet (or select a token) first.");
    return;
  }
  if (!actor.isOwner && !game.user.isGM) {
    ui.notifications.error("You do not own this actor.");
    return;
  }

  await refreshCatalogs();
  if (!getSession()?.sessionToken) {
    ui.notifications.warn("Bind the Foundry world to NPC Narrator before mapping actors.");
    return;
  }

  const chars = partyCharactersCache || [];
  const npcs = npcsCache || [];
  const currentPlayer =
    getPartyMaps()[actor.id] ||
    getUserPartyMaps()[actor.id] ||
    (game.user.character?.id === actor.id ? getPlayerMapping() : null) ||
    guessPartyPlayerId(actor) ||
    "";
  const currentNpc = getNpcOverrides()[actor.id] || guessNpcId(actor) || "";

  const partyOptions = [
    `<option value="">(None — unmapped)</option>`,
    ...chars.map((c) => {
      const id = c.player_id || c.id;
      const label = c.label || c.name || id;
      return `<option value="${id}" ${id === currentPlayer ? "selected" : ""}>${label}</option>`;
    }),
  ].join("");

  const npcOptions = [
    `<option value="">(None — unmapped)</option>`,
    ...npcs.map((n) => {
      const id = n.id;
      const label = n.name || id;
      return `<option value="${id}" ${id === currentNpc ? "selected" : ""}>${label}</option>`;
    }),
  ].join("");

  const canEditParty = actor.isOwner || game.user.isGM;
  const canEditNpc = game.user.isGM;
  const partyStoreNote = game.user.isGM
    ? "Stored in world settings by actor id (copies start unmapped)."
    : "Stored on your user by actor id (copies start unmapped). GMs can also set a world map.";

  const content = `
    <div class="npc-narrator-dialog">
      <p>Mappings are keyed by actor id. Duplicating this actor creates a new id, so copies start <strong>unmapped</strong>.</p>
      <p><strong>Actor:</strong> ${actor.name.replace(/</g, "&lt;")}</p>
      ${canEditParty ? `
      <div class="form-group">
        <label>Party member (who speaks)</label>
        <select id="npc-narrator-party-map">${partyOptions}</select>
        <p class="notes">${partyStoreNote}</p>
      </div>` : ""}
      ${canEditNpc ? `
      <div class="form-group">
        <label>Narrator NPC (token target)</label>
        <select id="npc-narrator-npc-map">${npcOptions}</select>
        <p class="notes">Used when chatting with this actor’s token. Leave blank to rely on name match.</p>
      </div>` : `
      <p class="notes">Ask a GM to map Narrator NPC targets.</p>`}
    </div>`;

  new Dialog({
    title: "NPC Narrator — Actor mapping",
    content,
    buttons: {
      save: {
        icon: '<i class="fas fa-save"></i>',
        label: "Save",
        callback: async (html) => {
          try {
            if (canEditParty) {
              const partyId = String(html.find("#npc-narrator-party-map").val() || "").trim();
              await savePartyMap(actor.id, partyId || null);
            }
            if (canEditNpc) {
              const npcId = String(html.find("#npc-narrator-npc-map").val() || "").trim();
              await setNpcOverride(actor.id, npcId || null);
            }
            ui.notifications.info(`NPC Narrator mapping saved for ${actor.name}.`);
          } catch (err) {
            console.error(`${MODULE_ID} actor mapping failed`, err);
            ui.notifications.error(err.message || String(err));
          }
        },
      },
      cancel: { label: "Cancel" },
    },
    default: "save",
  }).render(true);
}

async function openCharacterMapping() {
  const actor =
    game.user.character ||
    canvas.tokens?.controlled?.[0]?.actor ||
    null;
  if (actor) {
    await openActorNarratorMapping(actor);
    return;
  }
  ui.notifications.warn("Assign a character to your user, open an Actor sheet, or select a token first.");
}

function addActorSheetNarratorButton(buttons, actor) {
  if (!actor) return;
  if (!actor.isOwner && !game.user.isGM) return;
  buttons.unshift({
    label: "NPC Narrator",
    class: "npc-narrator-map",
    icon: "fas fa-theater-masks",
    onclick: () => {
      void openActorNarratorMapping(actor);
    },
  });
}

function addActorSheetV2NarratorControl(controls, actor) {
  if (!actor) return;
  if (!actor.isOwner && !game.user.isGM) return;
  controls.push({
    icon: "fa-solid fa-theater-masks",
    label: "NPC Narrator",
    onClick: () => {
      void openActorNarratorMapping(actor);
    },
  });
}

async function openBindDialog() {
  const session = getSession();
  const status = session
    ? `Bound to campaign <code>${session.campaignId}</code>`
    : "Not bound.";
  const currentUrl = editorBaseUrl();
  const currentCode = savedPairingCode();

  new Dialog({
    title: "NPC Narrator — Bind world",
    content: `
      <div class="npc-narrator-dialog">
        <p class="npc-narrator-status ${session ? "ok" : ""}">${status}</p>
        <p>Uses the Yaml Editor URL and pairing code from module settings (you can edit them here).</p>
        <div class="form-group">
          <label>Yaml Editor base URL</label>
          <input type="text" id="npc-narrator-url" style="width:100%" value="${currentUrl.replace(/"/g, "&quot;")}" placeholder="https://editor.example.com" />
        </div>
        <div class="form-group">
          <label>Pairing code</label>
          <input type="text" id="npc-narrator-pairing" style="width:100%" value="${currentCode.replace(/"/g, "&quot;")}" placeholder="Paste pairing code" autocomplete="off" />
        </div>
      </div>`,
    buttons: {
      bind: {
        icon: '<i class="fas fa-link"></i>',
        label: "Bind",
        callback: async (html) => {
          const url = String(html.find("#npc-narrator-url").val() || "").trim().replace(/\/+$/, "");
          const code = String(html.find("#npc-narrator-pairing").val() || "").trim() || savedPairingCode();
          if (!url) {
            ui.notifications.error("Set the Yaml Editor base URL first.");
            return;
          }
          if (!code) {
            ui.notifications.error("Paste a pairing code in settings or this dialog.");
            return;
          }
          try {
            await bindWithPairingCode(code, { baseUrl: url, persistUrl: true });
            ui.notifications.info("NPC Narrator: world bound.");
          } catch (err) {
            console.error(`${MODULE_ID} bind failed`, err);
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
 * Configure Settings → Bind / Unbind.
 * Prefills from module settings so the pairing code does not need to be retyped.
 */
class NpcNarratorPairingMenu extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "npc-narrator-pairing-menu",
      title: "NPC Narrator — Campaign pairing",
      classes: ["npc-narrator-dialog"],
      template: `modules/${MODULE_ID}/templates/pairing.hbs`,
      width: 520,
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
      pairingCode: savedPairingCode(),
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
    const data = foundry.utils.expandObject?.(formData) ?? formData;
    const url = String(data.editorBaseUrl ?? formData.editorBaseUrl ?? "").trim().replace(/\/+$/, "");
    const code = String(data.pairingCode ?? formData.pairingCode ?? "").trim() || savedPairingCode();

    if (!url) {
      ui.notifications.error("Set the Yaml Editor base URL first.");
      return;
    }
    if (!code) {
      ui.notifications.error("Enter a pairing code (module settings or this form).");
      return;
    }

    try {
      await game.settings.set(MODULE_ID, "editorBaseUrl", url);
      await game.settings.set(MODULE_ID, "pairingCode", code);
      await bindWithPairingCode(code, { baseUrl: url, persistUrl: false });
      ui.notifications.info("NPC Narrator: world bound.");
      this.render(true);
    } catch (err) {
      console.error(`${MODULE_ID} bind failed`, err);
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
    hint: "Paste the one-time code from the DM console, then open Campaign pairing → Bind / Unbind (or Save Changes to bind immediately).",
    scope: "world",
    config: true,
    type: String,
    default: "",
    restricted: true,
    onChange: (value) => {
      if (!game.ready || !game.user?.isGM) return;
      const code = String(value || "").trim();
      if (!code) return;
      if (game.npcNarrator?._clearingPairingCode) return;
      void (async () => {
        try {
          if (!editorBaseUrl()) {
            ui.notifications.error("Set Yaml Editor base URL before pairing.");
            return;
          }
          await bindWithPairingCode(code);
          ui.notifications.info("NPC Narrator: world bound from settings.");
        } catch (err) {
          console.error(`${MODULE_ID} settings bind failed`, err);
          ui.notifications.error(err.message || String(err));
        }
      })();
    },
  });

  game.settings.registerMenu(MODULE_ID, "pairingMenu", {
    name: "Campaign pairing",
    label: "Bind / Unbind",
    hint: "Opens the bind form prefilled from the URL and pairing code settings above.",
    icon: "fas fa-link",
    type: NpcNarratorPairingMenu,
    restricted: true,
  });

  game.settings.register(MODULE_ID, "session", {
    name: "Foundry session",
    scope: "world",
    config: false,
    type: Object,
    default: {},
  });

  game.settings.register(MODULE_ID, "partyMaps", {
    name: "Actor → party member maps",
    hint: "Keyed by Foundry actor id so duplicated actors start unmapped.",
    scope: "world",
    config: false,
    type: Object,
    default: {},
  });

  game.settings.register(MODULE_ID, "npcOverrides", {
    name: "Actor → Narrator NPC maps",
    hint: "Keyed by Foundry actor id so duplicated actors start unmapped.",
    scope: "world",
    config: false,
    type: Object,
    default: {},
  });

  game.keybindings.register(MODULE_ID, "chatTargetedNpc", {
    name: "Chat with targeted NPC",
    hint: "Opens Chat for the NPC token you have targeted (players usually cannot open the Token HUD on NPCs).",
    editable: [{ key: "KeyC", modifiers: ["Alt"] }],
    onDown: () => {
      void promptMessageForTargetedNpc("chat");
      return true;
    },
  });

  game.keybindings.register(MODULE_ID, "whisperTargetedNpc", {
    name: "Whisper to targeted NPC",
    hint: "Opens Whisper for the NPC token you have targeted.",
    editable: [{ key: "KeyW", modifiers: ["Alt"] }],
    onDown: () => {
      void promptMessageForTargetedNpc("whisper");
      return true;
    },
  });
});

Hooks.once("ready", async () => {
  game.npcNarrator = {
    ...(game.npcNarrator || {}),
    bind: openBindDialog,
    mapCharacter: openCharacterMapping,
    mapActor: openActorNarratorMapping,
    chat: () => promptMessageForTargetedNpc("chat"),
    whisper: () => promptMessageForTargetedNpc("whisper"),
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

  // Migrate legacy user flag / name guess → actor-id map (GM: world; players: user flag).
  const assigned = game.user.character;
  if (assigned && partyCharactersCache?.length) {
    const existing = getPartyMaps()[assigned.id] || getUserPartyMaps()[assigned.id];
    if (!existing) {
      const legacy = getPlayerMapping() || guessPartyPlayerId(assigned);
      if (legacy) {
        try {
          await savePartyMap(assigned.id, legacy);
        } catch (err) {
          console.warn(`${MODULE_ID} party map migrate skipped`, err);
        }
      }
    }
  }
});

// System-agnostic sheet entry points (do not inject into system sheet templates).
Hooks.on("getActorSheetHeaderButtons", (sheet, buttons) => {
  addActorSheetNarratorButton(buttons, sheet.actor || sheet.document);
});

Hooks.on("getHeaderControlsApplicationV2", (app, controls) => {
  const doc = app.document;
  if (!doc || doc.documentName !== "Actor") return;
  addActorSheetV2NarratorControl(controls, doc);
});

Hooks.on("getActorDirectoryEntryContext", (_html, options) => {
  options.push({
    name: "NPC Narrator: Map actor",
    icon: '<i class="fas fa-theater-masks"></i>',
    condition: (li) => {
      const actorId = li.data("documentId") || li.data("entryId") || li.attr("data-document-id");
      const actor = game.actors.get(actorId);
      return Boolean(actor && (actor.isOwner || game.user.isGM));
    },
    callback: async (li) => {
      const actorId = li.data("documentId") || li.data("entryId") || li.attr("data-document-id");
      const actor = game.actors.get(actorId);
      if (actor) await openActorNarratorMapping(actor);
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

// Players rarely get Token HUD on unowned NPCs — offer canvas context options when available.
Hooks.on("getTokenPlaceableContextOptions", (application, menuItems) => {
  addTokenNarratorContextOptions(application, menuItems);
});
Hooks.on("getTokenContextOptions", (application, menuItems) => {
  addTokenNarratorContextOptions(application, menuItems);
});

// Token layer buttons: target an NPC, then click Chat/Whisper in the left toolbar.
Hooks.on("getSceneControlButtons", (controls) => {
  registerTokenLayerNarratorTools(controls);
});

Hooks.on("chatMessage", (_log, message) => {
  if (!message.startsWith("/narrator")) return true;
  const parts = message.trim().split(/\s+/);
  const cmd = parts[1];
  if (cmd === "bind" && game.user.isGM) {
    openBindDialog();
    return false;
  }
  if (cmd === "character") {
    openCharacterMapping();
    return false;
  }
  if (cmd === "chat" || cmd === "whisper") {
    void promptMessageForTargetedNpc(cmd);
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

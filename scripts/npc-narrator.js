/**
 * NPC Narrator — Foundry VTT module (v13–v14)
 * Talks only to the Yaml Editor edge (never middleware directly).
 */

import { runLocationAuthoringWizard, runNpcAuthoringWizard } from "./narrator-wizard.js";

const MODULE_ID = "npc-narrator";
const FLAG_SCOPE = MODULE_ID;

/** @type {import("@microsoft/signalr").HubConnection | null} */
let hubConnection = null;
let heartbeatTimer = null;
let partyCharactersCache = null;
let npcsCache = null;
/** @type {Array<{id:string,name:string}>|null} */
let locationsCache = null;

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
    locationsCache = null;
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
    const locations = await apiFetch("/api/foundry/locations");
    if (locations.response.ok) {
      locationsCache = locations.data?.locations || [];
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

function getLocationMaps() {
  return game.settings.get(MODULE_ID, "locationMaps") || {};
}

async function setLocationMap(sceneId, locationId) {
  if (!sceneId) return;
  if (!game.user.isGM) {
    throw new Error("Only a GM can write Narrator location maps.");
  }
  const map = { ...getLocationMaps() };
  if (!locationId) delete map[sceneId];
  else map[sceneId] = locationId;
  await game.settings.set(MODULE_ID, "locationMaps", map);
}

/** Strip simple HTML and collapse whitespace for wizard prefill. */
function plainTextSeed(value, maxLen = 500) {
  const text = String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

function actorBiographySeed(actor) {
  const sys = actor?.system || {};
  const candidates = [
    sys.details?.biography?.value,
    sys.details?.biography,
    sys.biography?.value,
    sys.biography,
    sys.description?.value,
    sys.description,
  ];
  for (const c of candidates) {
    const text = plainTextSeed(c, 400);
    if (text) return text;
  }
  return "";
}

function sceneSummarySeed(scene) {
  try {
    const journalId = scene?.journal;
    if (journalId) {
      const journal = game.journal.get(journalId);
      const page = journal?.pages?.contents?.[0];
      const html = page?.text?.content || "";
      const text = plainTextSeed(html, 2000);
      if (text) return text;
    }
  } catch {
    /* ignore */
  }
  return "";
}

async function requireBoundSessionForAuthoring() {
  if (!game.user.isGM) {
    ui.notifications.error("Only a GM can create Narrator content from Foundry.");
    return false;
  }
  if (!getSession()?.sessionToken) {
    ui.notifications.warn("Bind the Foundry world to NPC Narrator before creating content.");
    await openBindDialog();
    return Boolean(getSession()?.sessionToken);
  }
  return true;
}

/**
 * Create-only NPC wizard from an Actor. If already mapped, offers mapping UI instead of overwrite.
 */
async function openCreateNarratorNpcFromActor(actor) {
  if (!actor) {
    ui.notifications.warn("Open an Actor sheet first.");
    return;
  }
  if (!(await requireBoundSessionForAuthoring())) return;

  const existing = getNpcOverrides()[actor.id];
  if (existing) {
    const choice = await dialogWait({
      title: "NPC Narrator — Already linked",
      content: `
        <div class="npc-narrator-dialog">
          <p><strong>${escapeHtml(actor.name)}</strong> is already mapped to Narrator NPC <code>${escapeHtml(existing)}</code>.</p>
          <p>Create-only wizards do not overwrite existing links. Open mapping to change the link, or clear it first.</p>
        </div>`,
      buttons: [
        { action: "map", label: "Open mapping", icon: "fas fa-link", default: true, callback: () => "map" },
        { action: "cancel", label: "Cancel" },
      ],
    });
    if (choice === "map") await openActorNarratorMapping(actor);
    return;
  }

  await refreshCatalogs();
  const bio = actorBiographySeed(actor);
  try {
    const created = await runNpcAuthoringWizard({
      dialogWait,
      apiFetch,
      locations: locationsCache || [],
      seed: {
        name: actor.name || "New NPC",
        role: bio || "",
      },
      sourceLabel: `Foundry actor:${actor.id} ${actor.name || ""}`.trim(),
    });
    if (!created?.id) return;

    await setNpcOverride(actor.id, created.id);
    await refreshCatalogs();
    ui.notifications.info(`NPC Narrator: created ${created.name || created.id} and mapped this actor.`);
  } catch (err) {
    ui.notifications.error(err.message || String(err));
  }
}

/**
 * Create-only Location wizard from a Scene. If already mapped, offers clear/cancel (no overwrite).
 */
async function openCreateNarratorLocationFromScene(scene) {
  if (!scene) {
    ui.notifications.warn("Select a Scene first.");
    return;
  }
  if (!(await requireBoundSessionForAuthoring())) return;

  const existing = getLocationMaps()[scene.id];
  if (existing) {
    const choice = await dialogWait({
      title: "NPC Narrator — Already linked",
      content: `
        <div class="npc-narrator-dialog">
          <p><strong>${escapeHtml(scene.name)}</strong> is already mapped to Narrator location <code>${escapeHtml(existing)}</code>.</p>
          <p>Create-only wizards do not overwrite. Clear the map to create a new location for this scene.</p>
        </div>`,
      buttons: [
        {
          action: "clear",
          label: "Clear map",
          callback: () => "clear",
        },
        { action: "cancel", label: "Cancel", default: true },
      ],
    });
    if (choice === "clear") {
      await setLocationMap(scene.id, null);
      ui.notifications.info("NPC Narrator: scene location map cleared.");
    }
    return;
  }

  try {
    const created = await runLocationAuthoringWizard({
      dialogWait,
      apiFetch,
      seed: {
        name: scene.name || "New Location",
        summary: sceneSummarySeed(scene),
      },
      sourceLabel: `Foundry scene:${scene.id} ${scene.name || ""}`.trim(),
    });
    if (!created?.id) return;

    await setLocationMap(scene.id, created.id);
    await refreshCatalogs();
    ui.notifications.info(`NPC Narrator: created location ${created.name || created.id} and mapped this scene.`);
  } catch (err) {
    ui.notifications.error(err.message || String(err));
  }
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

function chatAlreadyPosted(requestId, role) {
  if (!requestId || !role || !game.messages) return false;
  return game.messages.contents.some(
    (m) => m.getFlag?.(MODULE_ID, "requestId") === requestId && m.getFlag?.(MODULE_ID, "role") === role
  );
}

async function postChatLine({ content, alias, role, visibility, foundryUserId, requestId }) {
  if (!content?.trim()) return;
  if (requestId && role && chatAlreadyPosted(requestId, role)) return;

  const isWhisper = visibility === "whisper";
  let body = escapeHtml(content.trim());
  if (role === "narrator") {
    // Narration reads as stage direction in chat.
    body = `<em class="npc-narrator-narration">${body}</em>`;
  }

  const data = {
    content: body,
    speaker: { alias: alias || (role === "narrator" ? "Narrator" : "NPC") },
    flags: {
      [MODULE_ID]: {
        role: role || "other",
        requestId: requestId || null,
      },
    },
  };

  const style = CONST.CHAT_MESSAGE_STYLES?.OTHER ?? CONST.CHAT_MESSAGE_STYLES?.IC;
  if (style !== undefined) data.style = style;

  // Foundry v13+: `type` is a document subtype string. Never pass numeric CHAT_MESSAGE_TYPES
  // (that became "0" and breaks systems like Torg). Omit type and let the system default.

  if (isWhisper) {
    data.whisper = whisperTargets(foundryUserId);
  }

  try {
    await ChatMessage.create(data);
  } catch (err) {
    console.warn(`${MODULE_ID} chat create failed`, err);
    // Retry without type/style in case the system rejects our choices.
    const fallback = {
      content: data.content,
      speaker: data.speaker,
      flags: data.flags,
    };
    if (isWhisper) fallback.whisper = data.whisper;
    await ChatMessage.create(fallback);
  }
}

/**
 * Post narration/NPC dialogue from an /npc-turn JSON body into Foundry chat.
 * Works even when campaign text policy is not pointed at the Foundry device.
 */
async function postTurnRepliesToChat(data, visibility, foundryUserId, requestId) {
  if (!data || typeof data !== "object") return;
  const rid = requestId || data.request_id || null;
  const narration = String(data.narration_text || "").trim();
  const dialogue = String(data.dialogue_text || data.npc_text || "").trim();
  const npcName = String(data.npc_name || "NPC").trim() || "NPC";

  if (narration) {
    await postChatLine({
      content: narration,
      alias: "Narrator",
      role: "narrator",
      visibility,
      foundryUserId,
      requestId: rid,
    });
  }
  if (dialogue) {
    await postChatLine({
      content: dialogue,
      alias: npcName,
      role: "npc",
      visibility,
      foundryUserId,
      requestId: rid,
    });
  }
}

async function handleCampaignText(payload) {
  if (!payload) return;
  const visibility = payload.visibility || "chat";
  const foundryUserId = payload.foundry_user_id || null;
  const requestId = payload.request_id || null;

  if (visibility === "whisper" && foundryUserId && foundryUserId !== game.user.id && !game.user.isGM) {
    return;
  }

  if (payload.role === "player" && payload.player_text) {
    // Outgoing player lines are posted by the local turn sender into Foundry chat.
    return;
  }

  if (payload.role === "narrator" && (payload.narration_text || payload.npc_text)) {
    await postChatLine({
      content: payload.narration_text || payload.npc_text,
      alias: "Narrator",
      role: "narrator",
      visibility,
      foundryUserId,
      requestId,
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
      requestId,
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
      requestId,
    });
  }
  if (payload.dialogue_text) {
    await postChatLine({
      content: payload.dialogue_text,
      alias: payload.npc_name || "NPC",
      role: "npc",
      visibility,
      foundryUserId,
      requestId,
    });
  } else if (payload.npc_text && !payload.narration_text) {
    await postChatLine({
      content: payload.npc_text,
      alias: payload.npc_name || "NPC",
      role: "npc",
      visibility,
      foundryUserId,
      requestId,
    });
  }
}

async function bindWithPairingCode(pairingToken, options = {}) {
  if (!game.user?.isGM) {
    throw new Error("Only the GM can bind this world to NPC Narrator.");
  }

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
  if (!game.user?.isGM) {
    ui.notifications.error("Only the GM can unbind NPC Narrator.");
    return;
  }
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

  // Always post into Foundry chat so everyone sees public turns (and whispers stay private).
  await postChatLine({
    content: text,
    alias: game.user.character?.name || game.user.name,
    role: "player",
    visibility,
    foundryUserId: game.user.id,
    requestId,
  });
  await postTurnRepliesToChat(data, visibility, game.user.id, requestId);

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
      <p class="npc-narrator-status">${resolvedNpcId ? `NPC: <code>${escapeHtml(resolvedNpcId)}</code>` : ""}</p>
      <div class="form-group">
        <label>Message</label>
        <textarea name="message" id="npc-narrator-text" rows="4" style="width:100%"></textarea>
      </div>
    </div>`;

  const result = await dialogWait({
    title,
    content,
    buttons: [
      {
        action: "send",
        label: "Send",
        icon: "fas fa-paper-plane",
        default: true,
        callback: (_event, button) => {
          const el =
            button.form?.elements?.message ||
            button.form?.querySelector?.("#npc-narrator-text, textarea[name='message']");
          return String(el?.value || "").trim();
        },
      },
      { action: "cancel", label: "Cancel" },
    ],
  });

  if (!result || result === "cancel") return;
  const text = typeof result === "string" ? result : "";
  if (!text) return;
  try {
    await sendNpcTurn({ text, npcId: resolvedNpcId, visibility });
    ui.notifications.info("NPC Narrator: message sent.");
  } catch (err) {
    ui.notifications.error(err.message || String(err));
  }
}

function getDialogV2() {
  return foundry?.applications?.api?.DialogV2 || null;
}

/**
 * Prefer ApplicationV2 DialogV2; fall back to V1 Dialog on older clients.
 * @returns {Promise<any>}
 */
async function dialogWait({ title, content, buttons }) {
  const DialogV2 = getDialogV2();
  if (DialogV2?.wait) {
    try {
      return await DialogV2.wait({
        window: { title },
        content,
        modal: true,
        rejectClose: false,
        buttons,
      });
    } catch {
      return null;
    }
  }

  // V1 fallback
  return new Promise((resolve) => {
    const v1Buttons = {};
    for (const b of buttons || []) {
      v1Buttons[b.action] = {
        icon: b.icon ? `<i class="${b.icon}"></i>` : undefined,
        label: b.label,
        callback: (html) => {
          if (typeof b.callback === "function") {
            const root = html?.[0] || html;
            const form = {
              elements: {
                message: root?.querySelector?.("[name='message'], #npc-narrator-text"),
                npc: root?.querySelector?.("#npc-narrator-npc, [name='npc']"),
                party: root?.querySelector?.("#npc-narrator-party-map, [name='party']"),
                npcMap: root?.querySelector?.("#npc-narrator-npc-map, [name='npcMap']"),
                editorUrl: root?.querySelector?.("#npc-narrator-url, [name='editorUrl']"),
                pairingCode: root?.querySelector?.("#npc-narrator-pairing, [name='pairingCode']"),
              },
              querySelector: (sel) => root?.querySelector?.(sel),
            };
            // Prefer jQuery find when available
            if (html?.find) {
              form.elements.message = html.find("#npc-narrator-text, [name='message']")[0] || form.elements.message;
              form.elements.npc = html.find("#npc-narrator-npc")[0] || form.elements.npc;
              form.elements.party = html.find("#npc-narrator-party-map")[0] || form.elements.party;
              form.elements.npcMap = html.find("#npc-narrator-npc-map")[0] || form.elements.npcMap;
              form.elements.editorUrl = html.find("#npc-narrator-url")[0] || form.elements.editorUrl;
              form.elements.pairingCode = html.find("#npc-narrator-pairing")[0] || form.elements.pairingCode;
              form.querySelector = (sel) => html.find(sel)[0];
            }
            resolve(b.callback(null, { form }));
            return;
          }
          resolve(b.action);
        },
      };
    }
    const defaultBtn = (buttons || []).find((b) => b.default)?.action || Object.keys(v1Buttons)[0];
    new Dialog({
      title,
      content,
      buttons: v1Buttons,
      default: defaultBtn,
      close: () => resolve(null),
    }).render(true);
  });
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

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function eventClientPoint(event) {
  const oe = event?.originalEvent || event?.data?.originalEvent || event;
  return {
    clientX: Number(oe?.clientX ?? event?.clientX ?? 0),
    clientY: Number(oe?.clientY ?? event?.clientY ?? 0),
  };
}

function tokenCanOpenHud(token, event) {
  if (!token) return false;
  if (typeof token._canHUD === "function") {
    try {
      return Boolean(token._canHUD(game.user, event));
    } catch {
      /* fall through */
    }
  }
  return Boolean(token.isOwner);
}

/**
 * Foundry does not show Token HUD or a context menu for unowned tokens.
 * Players need our own right-click menu to Chat/Whisper NPCs.
 */
function shouldShowPlayerTokenContextMenu(token, event) {
  return Boolean(token?.actor && !tokenCanOpenHud(token, event));
}

let _npcNarratorMenuOpenedAt = 0;
let _npcNarratorMenuCloser = null;

function closeNpcNarratorTokenContextMenu() {
  document.getElementById("npc-narrator-token-context")?.remove();
  if (_npcNarratorMenuCloser) {
    document.removeEventListener("pointerdown", _npcNarratorMenuCloser, true);
    document.removeEventListener("keydown", _npcNarratorMenuCloser, true);
    _npcNarratorMenuCloser = null;
  }
}

function showNpcNarratorTokenContextMenu(token, event) {
  if (!token?.actor) return;
  const now = Date.now();
  if (now - _npcNarratorMenuOpenedAt < 250) return;
  _npcNarratorMenuOpenedAt = now;

  closeNpcNarratorTokenContextMenu();

  const { clientX, clientY } = eventClientPoint(event);
  const name = escapeHtml(token.name || token.actor.name || "NPC");

  const menu = document.createElement("menu");
  menu.id = "npc-narrator-token-context";
  menu.className = "npc-narrator-token-context";
  menu.setAttribute("role", "menu");
  menu.innerHTML = `
    <header class="npc-narrator-token-context-title">${name}</header>
    <li class="context-item" data-action="chat" role="menuitem">
      <i class="fas fa-comments"></i><span>Chat</span>
    </li>
    <li class="context-item" data-action="whisper" role="menuitem">
      <i class="fas fa-user-secret"></i><span>Whisper</span>
    </li>
  `;

  document.body.appendChild(menu);

  // Keep on-screen.
  const rect = menu.getBoundingClientRect();
  const left = Math.min(clientX, window.innerWidth - rect.width - 8);
  const top = Math.min(clientY, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;

  const onAction = (ev) => {
    const item = ev.target?.closest?.("[data-action]");
    if (item && menu.contains(item)) {
      ev.preventDefault();
      ev.stopPropagation();
      const action = item.dataset.action;
      closeNpcNarratorTokenContextMenu();
      void promptMessage(token, action);
      return;
    }
    // Outside click / Escape
    if (ev.type === "keydown" && ev.key !== "Escape") return;
    if (ev.type === "pointerdown" && menu.contains(ev.target)) return;
    closeNpcNarratorTokenContextMenu();
  };

  _npcNarratorMenuCloser = onAction;
  // Defer so the opening right-click does not immediately dismiss the menu.
  setTimeout(() => {
    document.addEventListener("pointerdown", onAction, true);
    document.addEventListener("keydown", onAction, true);
  }, 0);

  try {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.originalEvent?.preventDefault?.();
    event?.originalEvent?.stopPropagation?.();
  } catch {
    /* ignore */
  }
}

/**
 * Patch Token right-click so players get Chat/Whisper on unowned NPCs.
 * Core Foundry only opens the Token HUD for owned tokens, and often never
 * dispatches clickRight / context hooks for unowned tokens — so we also listen
 * on the canvas view.
 */
function findTokenAtClientPoint(clientX, clientY) {
  if (!canvas?.ready || !canvas.tokens) return null;
  if (canvas.tokens.hover?.actor) return canvas.tokens.hover;

  let point = null;
  try {
    point = canvas.canvasCoordinatesFromClient?.({ x: clientX, y: clientY }) ?? null;
  } catch {
    point = null;
  }
  if (!point) return null;

  const hits = canvas.tokens.placeables.filter((t) => {
    if (!t.visible || !t.actor) return false;
    if (t.document?.hidden && !game.user.isGM) return false;
    try {
      return Boolean(t.bounds?.contains?.(point.x, point.y));
    } catch {
      return false;
    }
  });
  if (!hits.length) return null;
  hits.sort((a, b) => (Number(a.document?.sort) || 0) - (Number(b.document?.sort) || 0));
  return hits[hits.length - 1];
}

function installPlayerTokenRightClickMenu() {
  const TokenClass = CONFIG?.Token?.objectClass;
  if (TokenClass?.prototype && !TokenClass.prototype._npcNarratorRightClickPatched) {
    TokenClass.prototype._npcNarratorRightClickPatched = true;
    const original = TokenClass.prototype._onClickRight;
    TokenClass.prototype._onClickRight = function (event) {
      if (shouldShowPlayerTokenContextMenu(this, event)) {
        showNpcNarratorTokenContextMenu(this, event);
        return false;
      }
      return original.call(this, event);
    };
  }

  const view = canvas?.app?.view || document.getElementById("board");
  if (!view || view.dataset.npcNarratorContextMenu) return;
  view.dataset.npcNarratorContextMenu = "1";

  const onRightClick = (event) => {
    if (event.type === "pointerdown" && event.button !== 2) return;

    const token = findTokenAtClientPoint(event.clientX, event.clientY);
    if (!shouldShowPlayerTokenContextMenu(token, event)) return;

    event.preventDefault();
    event.stopImmediatePropagation?.();
    event.stopPropagation();
    showNpcNarratorTokenContextMenu(token, event);
  };

  view.addEventListener("contextmenu", onRightClick, true);
  view.addEventListener("pointerdown", onRightClick, true);
}

async function pickNpcId(hintName) {
  await refreshCatalogs();
  if (!npcsCache?.length) {
    ui.notifications.error("No NPCs available from NPC Narrator.");
    return null;
  }
  const match = bestNameMatch(hintName, npcsCache, "name");
  const npcOptionsHtml = npcsCache
    .map((n) => {
      const sel = n.id === match?.id ? " selected" : "";
      return `<option value="${escapeHtml(n.id)}"${sel}>${escapeHtml(n.name)} (${escapeHtml(n.id)})</option>`;
    })
    .join("");
  const result = await dialogWait({
    title: "Select NPC Narrator record",
    content: `<div class="form-group"><label>NPC</label><select name="npc" id="npc-narrator-npc">${npcOptionsHtml}</select></div>`,
    buttons: [
      {
        action: "ok",
        label: "Use",
        default: true,
        callback: (_event, button) => {
          const el = button.form?.elements?.npc || button.form?.querySelector?.("#npc-narrator-npc");
          return el?.value || null;
        },
      },
      { action: "cancel", label: "Cancel" },
    ],
  });
  if (!result || result === "cancel") return null;
  return String(result);
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
      return `<option value="${escapeHtml(id)}" ${id === currentPlayer ? "selected" : ""}>${escapeHtml(label)}</option>`;
    }),
  ].join("");

  const npcOptions = [
    `<option value="">(None — unmapped)</option>`,
    ...npcs.map((n) => {
      const id = n.id;
      const label = n.name || id;
      return `<option value="${escapeHtml(id)}" ${id === currentNpc ? "selected" : ""}>${escapeHtml(label)}</option>`;
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
      <p><strong>Actor:</strong> ${escapeHtml(actor.name)}</p>
      ${canEditParty ? `
      <div class="form-group">
        <label>Party member (who speaks)</label>
        <select name="party" id="npc-narrator-party-map">${partyOptions}</select>
        <p class="notes">${partyStoreNote}</p>
      </div>` : ""}
      ${canEditNpc ? `
      <div class="form-group">
        <label>Narrator NPC (token target)</label>
        <select name="npcMap" id="npc-narrator-npc-map">${npcOptions}</select>
        <p class="notes">Used when chatting with this actor’s token. Leave blank to rely on name match.</p>
      </div>` : `
      <p class="notes">Ask a GM to map Narrator NPC targets.</p>`}
    </div>`;

  const result = await dialogWait({
    title: "NPC Narrator — Actor mapping",
    content,
    buttons: [
      {
        action: "save",
        label: "Save",
        icon: "fas fa-save",
        default: true,
        callback: (_event, button) => {
          const partyEl =
            button.form?.elements?.party || button.form?.querySelector?.("#npc-narrator-party-map");
          const npcEl =
            button.form?.elements?.npcMap || button.form?.querySelector?.("#npc-narrator-npc-map");
          return {
            partyId: String(partyEl?.value || "").trim(),
            npcId: String(npcEl?.value || "").trim(),
          };
        },
      },
      { action: "cancel", label: "Cancel" },
    ],
  });

  if (!result || result === "cancel" || typeof result !== "object") return;
  try {
    if (canEditParty) {
      await savePartyMap(actor.id, result.partyId || null);
    }
    if (canEditNpc) {
      await setNpcOverride(actor.id, result.npcId || null);
    }
    ui.notifications.info(`NPC Narrator mapping saved for ${actor.name}.`);
  } catch (err) {
    console.error(`${MODULE_ID} actor mapping failed`, err);
    ui.notifications.error(err.message || String(err));
  }
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
  if (game.user.isGM) {
    buttons.unshift({
      label: "Create Narrator NPC",
      class: "npc-narrator-create-npc",
      icon: "fas fa-wand-magic-sparkles",
      onclick: () => {
        void openCreateNarratorNpcFromActor(actor);
      },
    });
  }
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
  if (game.user.isGM) {
    controls.push({
      icon: "fa-solid fa-wand-magic-sparkles",
      label: "Create Narrator NPC",
      onClick: () => {
        void openCreateNarratorNpcFromActor(actor);
      },
    });
  }
}

function addSceneNarratorCreateControl(controls, scene) {
  if (!scene || !game.user.isGM) return;
  controls.push({
    icon: "fa-solid fa-map-location-dot",
    label: "Create Narrator Location",
    onClick: () => {
      void openCreateNarratorLocationFromScene(scene);
    },
  });
}

async function openBindDialog() {
  if (!game.user?.isGM) {
    ui.notifications.error("Only the GM can bind or unbind NPC Narrator.");
    return;
  }

  const session = getSession();
  const status = session
    ? `Bound to campaign <code>${escapeHtml(session.campaignId)}</code>`
    : "Not bound.";
  const currentUrl = editorBaseUrl();
  const currentCode = savedPairingCode();

  const result = await dialogWait({
    title: "NPC Narrator — Bind world",
    content: `
      <div class="npc-narrator-dialog">
        <p class="npc-narrator-status ${session ? "ok" : ""}">${status}</p>
        <p>Uses the Yaml Editor URL and pairing code from module settings (you can edit them here).</p>
        <div class="form-group">
          <label>Yaml Editor base URL</label>
          <input type="text" name="editorUrl" id="npc-narrator-url" style="width:100%" value="${escapeHtml(currentUrl)}" placeholder="https://editor.example.com" />
        </div>
        <div class="form-group">
          <label>Pairing code</label>
          <input type="text" name="pairingCode" id="npc-narrator-pairing" style="width:100%" value="${escapeHtml(currentCode)}" placeholder="Paste pairing code" autocomplete="off" />
        </div>
      </div>`,
    buttons: [
      {
        action: "bind",
        label: "Bind",
        icon: "fas fa-link",
        default: true,
        callback: (_event, button) => {
          const urlEl =
            button.form?.elements?.editorUrl || button.form?.querySelector?.("#npc-narrator-url");
          const codeEl =
            button.form?.elements?.pairingCode || button.form?.querySelector?.("#npc-narrator-pairing");
          return {
            action: "bind",
            url: String(urlEl?.value || "").trim().replace(/\/+$/, ""),
            code: String(codeEl?.value || "").trim() || savedPairingCode(),
          };
        },
      },
      {
        action: "unbind",
        label: "Unbind",
        callback: () => ({ action: "unbind" }),
      },
      { action: "cancel", label: "Close" },
    ],
  });

  if (!result || result === "cancel") return;
  if (result === "unbind" || result?.action === "unbind") {
    await unbindSession();
    return;
  }
  if (result?.action === "bind" || typeof result === "object") {
    const url = result.url;
    const code = result.code;
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
  }
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

  game.settings.register(MODULE_ID, "locationMaps", {
    name: "Scene → Narrator Location maps",
    hint: "Keyed by Foundry scene id after Create Narrator Location wizard.",
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
    bind: () => {
      if (!game.user.isGM) {
        ui.notifications.error("Only the GM can bind NPC Narrator.");
        return;
      }
      return openBindDialog();
    },
    mapCharacter: openCharacterMapping,
    mapActor: openActorNarratorMapping,
    createNpcFromActor: openCreateNarratorNpcFromActor,
    createLocationFromScene: openCreateNarratorLocationFromScene,
    chat: () => promptMessageForTargetedNpc("chat"),
    whisper: () => promptMessageForTargetedNpc("whisper"),
    refresh: refreshCatalogs,
    unbind: () => unbindSession(),
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

  installPlayerTokenRightClickMenu();
});

Hooks.on("canvasReady", () => {
  installPlayerTokenRightClickMenu();
});

// System-agnostic sheet entry points (do not inject into system sheet templates).
Hooks.on("getActorSheetHeaderButtons", (sheet, buttons) => {
  addActorSheetNarratorButton(buttons, sheet.actor || sheet.document);
});

Hooks.on("getHeaderControlsApplicationV2", (app, controls) => {
  const doc = app.document;
  if (!doc) return;
  if (doc.documentName === "Actor") {
    addActorSheetV2NarratorControl(controls, doc);
    return;
  }
  if (doc.documentName === "Scene") {
    addSceneNarratorCreateControl(controls, doc);
  }
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
  options.push({
    name: "NPC Narrator: Create NPC…",
    icon: '<i class="fas fa-wand-magic-sparkles"></i>',
    condition: (li) => {
      if (!game.user.isGM) return false;
      const actorId = li.data("documentId") || li.data("entryId") || li.attr("data-document-id");
      return Boolean(game.actors.get(actorId));
    },
    callback: async (li) => {
      const actorId = li.data("documentId") || li.data("entryId") || li.attr("data-document-id");
      const actor = game.actors.get(actorId);
      if (actor) await openCreateNarratorNpcFromActor(actor);
    },
  });
});

Hooks.on("getSceneDirectoryEntryContext", (_html, options) => {
  options.push({
    name: "NPC Narrator: Create Location…",
    icon: '<i class="fas fa-map-location-dot"></i>',
    condition: () => game.user.isGM,
    callback: async (li) => {
      const sceneId = li.data("documentId") || li.data("entryId") || li.attr("data-document-id");
      const scene = game.scenes.get(sceneId);
      if (scene) await openCreateNarratorLocationFromScene(scene);
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
        ? `NPC Narrator bound to <code>${escapeHtml(s.campaignId)}</code>`
        : "NPC Narrator is not bound.",
      whisper: [game.user.id],
    });
    return false;
  }
  return true;
});

console.log(`${MODULE_ID} | Loaded`);

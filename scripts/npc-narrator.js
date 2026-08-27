/**
 * NPC Narrator — Foundry VTT module (v13–v14)
 * Talks only to the Yaml Editor edge (never middleware directly).
 */

import { runLocationAuthoringWizard, runNpcAuthoringWizard } from "./narrator-wizard.js";
import {
  bestNameMatch as bestNameMatchPure,
  chatAlreadyPosted as chatAlreadyPostedPure,
  chatFingerprintAlreadyPosted as chatFingerprintAlreadyPostedPure,
  chatLineFingerprint,
  escapeHtml,
  plainTextSeed,
  applyChatPortraitSrc,
  findActorForNpc,
  NARRATOR_CHAT_PORTRAIT,
  NARRATOR_PORTRAIT_UPLOAD_DIR,
  actorPortraitTokenUpdate,
  isFilePickerDirectoryExistsError,
  portraitFileExtension,
  portraitUploadDirSegments,
  portraitUploadFileStem,
  resolveChatPortraitSrc,
  shouldAcceptCampaignText,
  shouldMirrorCampaignTextToFoundryChat,
  shouldOwnFoundryHub,
  whisperTargets as whisperTargetsPure,
} from "./narrator-pure.js";

const MODULE_ID = "npc-narrator";
const FLAG_SCOPE = MODULE_ID;
const DEFAULT_EDITOR_BASE_URL = "https://www.npcnarrator.com";

/** @type {import("@microsoft/signalr").HubConnection | null} */
let hubConnection = null;
let heartbeatTimer = null;
let partyCharactersCache = null;
let npcsCache = null;
/** @type {Array<{id:string,name:string}>|null} */
let locationsCache = null;

function bestNameMatch(name, items, nameKey = "name") {
  return bestNameMatchPure(name, items, nameKey);
}

function editorBaseUrl() {
  const configured = String(game.settings.get(MODULE_ID, "editorBaseUrl") || "")
    .trim()
    .replace(/\/+$/, "");
  return configured || DEFAULT_EDITOR_BASE_URL;
}

function getSession() {
  const session = game.settings.get(MODULE_ID, "session");
  if (!session || typeof session !== "object" || !session.sessionToken) return null;
  return session;
}

async function setSession(session) {
  await game.settings.set(MODULE_ID, "session", session || {});
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

/** Binary GET for Foundry portrait sync (Bearer session). */
async function apiFetchBinary(path) {
  const base = editorBaseUrl();
  if (!base) throw new Error("Set the Yaml Editor base URL in module settings.");
  const response = await fetch(`${base}${path}`, {
    headers: {
      Accept: "image/*,application/octet-stream",
      ...authHeaders(),
    },
  });
  const contentType = response.headers.get("Content-Type") || "";
  if (!response.ok) {
    let detail = "";
    try {
      const text = await response.text();
      try {
        const json = JSON.parse(text);
        detail = json.error || json.detail || text;
      } catch {
        detail = text;
      }
    } catch {
      detail = response.statusText;
    }
    const err = new Error(detail || `Portrait download failed (${response.status})`);
    err.status = response.status;
    throw err;
  }
  const blob = await response.blob();
  return { response, blob, contentType };
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
  // Co-GMs must not JoinAsFoundry — only Foundry's activeGM owns the presence slot.
  if (!shouldOwnFoundryHub(game.user, game.users?.activeGM)) {
    return;
  }

  await ensureSignalR();
  await stopHub();

  hubConnection = new signalR.HubConnectionBuilder()
    .withUrl(`${base}/hubs/campaign-audio`, {
      accessTokenFactory: () => session.sessionToken,
      // Bearer token auth — do not send cookies. Credentials + ACAO:* is blocked by browsers
      // when Foundry (e.g. http://localhost:30000) talks to the Yaml Editor origin.
      withCredentials: false,
      // Match the Discord bot: allow LongPolling when WebSockets are blocked (common behind
      // reverse proxies / mixed content), so JoinAsFoundry presence still registers.
      transport: signalR.HttpTransportType.WebSockets | signalR.HttpTransportType.LongPolling,
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

/**
 * Ensure only the active GM client holds JoinAsFoundry for this world session.
 * Call on ready, after bind, and when GM connectivity changes.
 */
async function reconcileFoundryHub() {
  const session = getSession();
  if (!session?.sessionToken) {
    await stopHub();
    return;
  }
  if (shouldOwnFoundryHub(game.user, game.users?.activeGM)) {
    if (!hubConnection) {
      await startHub();
    }
    return;
  }
  await stopHub();
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

/** Strip simple HTML and collapse whitespace for wizard prefill — see narrator-pure.js. */

function actorBiographySeed(actor) {
  const sys = actor?.system || {};
  // Prefer string fields only — never fall through to parent objects (avoids "[object Object]").
  const candidates = [
    sys.details?.biography?.value,
    sys.details?.biography?.public,
    sys.biography?.value,
    sys.biography?.public,
    sys.description?.value,
    typeof sys.details?.biography === "string" ? sys.details.biography : null,
    typeof sys.biography === "string" ? sys.biography : null,
    typeof sys.description === "string" ? sys.description : null,
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
    if (!journalId) return "";
    const journal = game.journal.get(journalId);
    if (!journal) return "";

    // Prefer the scene's linked page when set (not always contents[0]).
    const pageId = scene.journalEntryPage || scene.journalPageId || null;
    let page = null;
    if (pageId) {
      page = journal.pages?.get?.(pageId) || null;
      if (!page && journal.pages?.contents) {
        page = journal.pages.contents.find((p) => p.id === pageId) || null;
      }
    }
    if (!page) {
      page = journal.pages?.contents?.[0] || null;
    }

    const html = page?.text?.content || "";
    return plainTextSeed(html, 2000);
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
  return whisperTargetsPure(foundryUserId, game.users);
}

function chatAlreadyPosted(requestId, role) {
  return chatAlreadyPostedPure(requestId, role, game.messages?.contents, MODULE_ID);
}

function chatFingerprintPosted(fingerprint, requestId) {
  return chatFingerprintAlreadyPostedPure(fingerprint, game.messages?.contents, MODULE_ID, {
    authorId: game.user?.id,
    requestId,
  });
}

function resolveActorForNpcChat(npcId, npcName) {
  return findActorForNpc(npcId, npcName, getNpcOverrides(), game.actors?.contents || []);
}

function buildChatSpeaker(alias, actor) {
  if (actor && typeof ChatMessage?.getSpeaker === "function") {
    try {
      const speaker = ChatMessage.getSpeaker({ actor });
      return { ...speaker, alias: alias || speaker.alias || actor.name };
    } catch {
      // fall through
    }
  }
  if (actor?.id) {
    return { alias: alias || actor.name || "NPC", actor: actor.id };
  }
  return { alias: alias || "NPC" };
}

function applyNarratorChatPortrait(message, root) {
  const role = message?.getFlag?.(MODULE_ID, "role");
  if (!role || (role !== "narrator" && role !== "npc")) return;
  const flagged = message?.getFlag?.(MODULE_ID, "portraitSrc");
  let src = flagged || null;
  if (!src && role === "narrator") {
    src = NARRATOR_CHAT_PORTRAIT;
  }
  if (!src && role === "npc") {
    const actor =
      message?.speakerActor
      || (message?.speaker?.actor ? game.actors.get(message.speaker.actor) : null);
    src = resolveChatPortraitSrc("npc", actor);
  }
  if (!applyChatPortraitSrc(root, src)) {
    // Foundry may finish painting the avatar after the render hook; retry once.
    requestAnimationFrame(() => applyChatPortraitSrc(root, src));
  }
}

async function postChatLine({ content, alias, role, visibility, foundryUserId, requestId, npcId, npcName }) {
  if (!content?.trim()) return;
  if (requestId && role && chatAlreadyPosted(requestId, role)) return;
  const fingerprint = chatLineFingerprint(role, content);
  if (fingerprint && chatFingerprintPosted(fingerprint, requestId)) return;

  const isWhisper = visibility === "whisper";
  let body = escapeHtml(content.trim());
  if (role === "narrator") {
    // Narration reads as stage direction in chat.
    body = `<em class="npc-narrator-narration">${body}</em>`;
  }

  const actor = role === "npc" ? resolveActorForNpcChat(npcId, npcName || alias) : null;
  const portraitSrc = resolveChatPortraitSrc(role, actor) || (role === "narrator" ? NARRATOR_CHAT_PORTRAIT : null);
  const speakerAlias = alias || (role === "narrator" ? "Narrator" : actor?.name || "NPC");

  const data = {
    content: body,
    speaker: buildChatSpeaker(speakerAlias, actor),
    flags: {
      [MODULE_ID]: {
        role: role || "other",
        requestId: requestId || null,
        portraitSrc: portraitSrc || null,
        npcId: npcId || null,
        fingerprint: fingerprint || null,
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
  const npcId = String(data.npc_id || "").trim() || null;

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
      npcId,
      npcName,
    });
  }
}

async function handleCampaignText(payload) {
  if (!payload) return;
  if (!shouldAcceptCampaignText(payload, getSession())) {
    return;
  }
  // Local sendNpcTurn already wrote these lines from the /npc-turn response.
  if (!shouldMirrorCampaignTextToFoundryChat(payload)) {
    return;
  }
  const visibility = payload.visibility || "chat";
  const foundryUserId = payload.foundry_user_id || null;
  const requestId = payload.request_id || null;
  const npcId = payload.npc_id || null;
  const npcName = payload.npc_name || null;

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
      npcId,
      npcName,
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
      npcId,
      npcName,
    });
  } else if (payload.npc_text && !payload.narration_text) {
    await postChatLine({
      content: payload.npc_text,
      alias: payload.npc_name || "NPC",
      role: "npc",
      visibility,
      foundryUserId,
      requestId,
      npcId,
      npcName,
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

  try {
    await refreshCatalogs();
  } catch (err) {
    console.warn(`${MODULE_ID} catalog refresh after bind failed`, err);
  }

  try {
    await reconcileFoundryHub();
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
  locationsCache = null;
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

  // Post the question first so chat order is player → narrator → NPC (SignalR captions
  // for foundry_npc_turn are ignored; replies come from the HTTP JSON below).
  await postChatLine({
    content: text,
    alias: game.user.character?.name || game.user.name,
    role: "player",
    visibility,
    foundryUserId: game.user.id,
    requestId,
  });

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

/** Resolve directory entry id from ApplicationV2 HTMLElement (or legacy jQuery). */
function directoryEntryId(target) {
  const el = target?.dataset ? target : target?.[0];
  if (!el) return null;
  const ds = el.dataset || {};
  return (
    ds.documentId ||
    ds.entryId ||
    el.getAttribute?.("data-document-id") ||
    el.getAttribute?.("data-entry-id") ||
    null
  );
}

function addActorDirectoryNarratorOptions(menuItems) {
  menuItems.push(
    {
      name: "NPC Narrator: Map actor",
      icon: '<i class="fas fa-theater-masks"></i>',
      condition: (target) => {
        const actor = game.actors.get(directoryEntryId(target));
        return Boolean(actor && (actor.isOwner || game.user.isGM));
      },
      callback: async (target) => {
        const actor = game.actors.get(directoryEntryId(target));
        if (actor) await openActorNarratorMapping(actor);
      },
    },
    {
      name: "NPC Narrator: Create NPC…",
      icon: '<i class="fas fa-wand-magic-sparkles"></i>',
      condition: (target) => {
        if (!game.user.isGM) return false;
        return Boolean(game.actors.get(directoryEntryId(target)));
      },
      callback: async (target) => {
        const actor = game.actors.get(directoryEntryId(target));
        if (actor) await openCreateNarratorNpcFromActor(actor);
      },
    },
  );
}

function addSceneDirectoryNarratorOptions(menuItems) {
  menuItems.push({
    name: "NPC Narrator: Create Location…",
    icon: '<i class="fas fa-map-location-dot"></i>',
    condition: (target) => game.user.isGM && Boolean(game.scenes.get(directoryEntryId(target))),
    callback: async (target) => {
      const scene = game.scenes.get(directoryEntryId(target));
      if (scene) await openCreateNarratorLocationFromScene(scene);
    },
  });
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
      </div>
      <p class="notes">After saving a Narrator NPC map, use <strong>Sync Narrator portrait</strong> on the actor sheet to copy the closed-mouth still onto the sheet and prototype token.</p>` : `
      <p class="notes">Ask a GM to map Narrator NPC targets.</p>`}
    </div>`;

  const buttons = [
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
          action: "save",
          partyId: String(partyEl?.value || "").trim(),
          npcId: String(npcEl?.value || "").trim(),
        };
      },
    },
  ];
  if (canEditNpc && currentNpc) {
    buttons.push({
      action: "syncPortrait",
      label: "Sync portrait",
      icon: "fas fa-image",
      callback: (_event, button) => {
        const npcEl =
          button.form?.elements?.npcMap || button.form?.querySelector?.("#npc-narrator-npc-map");
        return {
          action: "syncPortrait",
          npcId: String(npcEl?.value || currentNpc || "").trim(),
        };
      },
    });
  }
  buttons.push({ action: "cancel", label: "Cancel" });

  const result = await dialogWait({
    title: "NPC Narrator — Actor mapping",
    content,
    buttons,
  });

  if (!result || result === "cancel" || typeof result !== "object") return;

  if (result.action === "syncPortrait") {
    try {
      await syncNarratorPortraitToActor(actor, result.npcId || currentNpc || null);
    } catch (err) {
      console.error(`${MODULE_ID} portrait sync failed`, err);
      ui.notifications.error(err.message || String(err));
    }
    return;
  }

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

/**
 * Download Narrator still portrait and apply as Foundry actor img + prototype token.
 * @param {Actor} actor
 * @param {string|null|undefined} npcIdOverride
 */
async function syncNarratorPortraitToActor(actor, npcIdOverride = null) {
  if (!game.user?.isGM) {
    throw new Error("Only a GM can sync Narrator portraits onto actors.");
  }
  if (!actor) {
    throw new Error("Open an Actor sheet (or select a token) first.");
  }
  if (!getSession()?.sessionToken) {
    throw new Error("Bind the Foundry world to NPC Narrator before syncing portraits.");
  }

  const npcId = String(npcIdOverride || resolveNpcIdForActor(actor) || "").trim();
  if (!npcId) {
    throw new Error("Map this actor to a Narrator NPC first.");
  }

  ui.notifications.info(`Downloading Narrator portrait for ${npcId}…`);
  const { blob, contentType } = await apiFetchBinary(
    `/api/foundry/npc-portrait?npc_id=${encodeURIComponent(npcId)}`,
  );
  if (!blob || blob.size < 8) {
    throw new Error("Portrait download was empty.");
  }

  const ext = portraitFileExtension(contentType || blob.type, ".png");
  const filename = `${portraitUploadFileStem(npcId)}${ext}`;
  const file = new File([blob], filename, { type: contentType || blob.type || "image/png" });

  await ensurePortraitUploadDirs();

  const uploaded = await FilePicker.upload(
    "data",
    NARRATOR_PORTRAIT_UPLOAD_DIR,
    file,
    {},
    { notify: false },
  );
  const path = String(uploaded?.path || uploaded || "").trim();
  if (!path) {
    throw new Error("Foundry file upload did not return a path.");
  }

  const update = actorPortraitTokenUpdate(path);
  await actor.update(update);

  // linked=false so unlinked NPC tokens on the current scene are included.
  const tokens = typeof actor.getActiveTokens === "function" ? actor.getActiveTokens(false) : [];
  let placedUpdated = 0;
  for (const token of tokens || []) {
    try {
      await token.document.update({ "texture.src": path });
      placedUpdated += 1;
    } catch (err) {
      console.warn(`${MODULE_ID} placed token portrait update skipped`, err);
    }
  }

  if (placedUpdated > 0) {
    ui.notifications.info(
      `Synced Narrator portrait onto ${actor.name} (sheet, prototype token, and ${placedUpdated} placed token${placedUpdated === 1 ? "" : "s"}).`,
    );
  } else {
    ui.notifications.info(
      `Synced Narrator portrait onto ${actor.name} (sheet + prototype token). No placed tokens on this scene were updated.`,
    );
  }
  return path;
}

/** Create npc-narrator then npc-narrator/portraits; Foundry does not mkdir -p. */
async function ensurePortraitUploadDirs() {
  for (const path of portraitUploadDirSegments(NARRATOR_PORTRAIT_UPLOAD_DIR)) {
    try {
      await FilePicker.createDirectory("data", path);
    } catch (err) {
      if (isFilePickerDirectoryExistsError(err)) continue;
      throw new Error(`Could not create upload folder "${path}": ${err?.message || err}`);
    }
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
    if (getNpcOverrides()[actor.id] || guessNpcId(actor)) {
      buttons.unshift({
        label: "Sync Narrator portrait",
        class: "npc-narrator-sync-portrait",
        icon: "fas fa-image",
        onclick: () => {
          void syncNarratorPortraitToActor(actor).catch((err) => {
            console.error(`${MODULE_ID} portrait sync failed`, err);
            ui.notifications.error(err.message || String(err));
          });
        },
      });
    }
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
    if (getNpcOverrides()[actor.id] || guessNpcId(actor)) {
      controls.push({
        icon: "fa-solid fa-image",
        label: "Sync Narrator portrait",
        onClick: () => {
          void syncNarratorPortraitToActor(actor).catch((err) => {
            console.error(`${MODULE_ID} portrait sync failed`, err);
            ui.notifications.error(err.message || String(err));
          });
        },
      });
    }
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
  const baseUrl = editorBaseUrl();

  const result = await dialogWait({
    title: "NPC Narrator — Bind world",
    content: `
      <div class="npc-narrator-dialog">
        <p class="npc-narrator-status ${session ? "ok" : ""}">${status}</p>
        <p class="notes">Editor: <code>${escapeHtml(baseUrl)}</code> (change under Module Settings if needed)</p>
        <div class="form-group">
          <label>Pairing code</label>
          <input type="text" name="pairingCode" id="npc-narrator-pairing" style="width:100%" value="" placeholder="Paste pairing code from DM console" autocomplete="off" />
        </div>
      </div>`,
    buttons: [
      {
        action: "bind",
        label: "Bind",
        icon: "fas fa-link",
        default: true,
        callback: (_event, button) => {
          const codeEl =
            button.form?.elements?.pairingCode || button.form?.querySelector?.("#npc-narrator-pairing");
          return {
            action: "bind",
            code: String(codeEl?.value || "").trim(),
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
    const code = result.code;
    if (!code) {
      ui.notifications.error("Paste a pairing code to bind.");
      return;
    }
    try {
      await bindWithPairingCode(code, { baseUrl: editorBaseUrl(), persistUrl: false });
      ui.notifications.info("NPC Narrator: world bound.");
    } catch (err) {
      console.error(`${MODULE_ID} bind failed`, err);
      ui.notifications.error(err.message || String(err));
    }
  }
}

/**
 * Configure Settings → Bind / Unbind — opens the pairing-code dialog.
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
      closeOnSubmit: true,
      submitOnChange: false,
    });
  }

  /** @override Open the bind dialog instead of a settings form. */
  async render(_force, _options = {}) {
    await openBindDialog();
    return this;
  }
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "editorBaseUrl", {
    name: "Yaml Editor base URL",
    hint: "HTTPS origin of NPC Narrator (no trailing slash). Defaults to https://www.npcnarrator.com.",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_EDITOR_BASE_URL,
    restricted: true,
  });

  game.settings.registerMenu(MODULE_ID, "pairingMenu", {
    name: "Campaign pairing",
    label: "Bind / Unbind",
    hint: "Paste a one-time pairing code from the DM console to bind this world (or unbind).",
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
    syncPortrait: syncNarratorPortraitToActor,
    createNpcFromActor: openCreateNarratorNpcFromActor,
    createLocationFromScene: openCreateNarratorLocationFromScene,
    chat: () => promptMessageForTargetedNpc("chat"),
    whisper: () => promptMessageForTargetedNpc("whisper"),
    refresh: refreshCatalogs,
    unbind: () => unbindSession(),
  };

  const session = getSession();
  // Only Foundry's activeGM joins SignalR so co-GMs cannot flap the foundry presence slot.
  // Players (and other GMs) still send HTTP turns; chat syncs via Foundry ChatMessage.
  if (session?.sessionToken) {
    try {
      await refreshCatalogs();
      await reconcileFoundryHub();
    } catch (err) {
      console.warn(`${MODULE_ID} reconnect failed`, err);
      ui.notifications.warn("NPC Narrator: could not reconnect. Re-bind if the session expired.");
    }
  }

  Hooks.on("userConnected", () => {
    void reconcileFoundryHub().catch((err) => {
      console.warn(`${MODULE_ID} hub reconcile after userConnected failed`, err);
    });
  });

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

Hooks.on("getActorContextOptions", (_application, menuItems) => {
  addActorDirectoryNarratorOptions(menuItems);
});

Hooks.on("getSceneContextOptions", (_application, menuItems) => {
  addSceneDirectoryNarratorOptions(menuItems);
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

// Swap Narrator/NPC chat avatars off the speaking player's portrait.
Hooks.on("renderChatMessageHTML", (message, html) => {
  applyNarratorChatPortrait(message, html);
});
// Legacy hook still used by some systems / older builds.
Hooks.on("renderChatMessage", (message, html) => {
  const root = html?.[0] || html;
  applyNarratorChatPortrait(message, root);
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

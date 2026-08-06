/** Pure helpers extracted from npc-narrator.js for unit testing (no Foundry `game` dependency). */

export function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function nameMatchScore(a, b) {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) return 0;
  if (left === right) return 100;
  if (left.includes(right) || right.includes(left)) return 80;
  return 0;
}

export function bestNameMatch(name, items, nameKey = "name") {
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

/** Strip simple HTML and collapse whitespace for wizard prefill. Non-strings are ignored. */
export function plainTextSeed(value, maxLen = 500) {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @param {string|null|undefined} foundryUserId
 * @param {Iterable<{id:string,isGM?:boolean}>} users
 */
export function whisperTargets(foundryUserId, users) {
  const ids = new Set();
  if (foundryUserId) ids.add(foundryUserId);
  for (const user of users || []) {
    if (user?.isGM) ids.add(user.id);
  }
  return [...ids];
}

/**
 * @param {string|null|undefined} requestId
 * @param {string|null|undefined} role
 * @param {{getFlag?: Function}[]} messages
 * @param {string} moduleId
 */
export function chatAlreadyPosted(requestId, role, messages, moduleId) {
  if (!requestId || !role || !messages) return false;
  return messages.some(
    (m) => m.getFlag?.(moduleId, "requestId") === requestId && m.getFlag?.(moduleId, "role") === role,
  );
}

/**
 * Defense-in-depth: ignore SignalR captions that are not for this world's bound campaign.
 * @param {{campaign_id?: string|null}|null|undefined} payload
 * @param {{campaignId?: string|null}|null|undefined} session
 */
export function shouldAcceptCampaignText(payload, session) {
  const bound = String(session?.campaignId || "").trim();
  if (!bound) return false;
  const incoming = String(payload?.campaign_id || "").trim();
  // Missing campaign_id on legacy payloads: allow only when we have a bound session
  // and treat empty as "same channel" (server always joins the session campaign).
  if (!incoming) return true;
  return incoming.toLowerCase() === bound.toLowerCase();
}

/**
 * Foundry `/npc-turn` already posts player + narrator + NPC lines from the HTTP JSON.
 * SignalR still fans those captions out (for Discord/browser), but Foundry must not
 * ChatMessage.create them again or the table sees replies twice (often GM first, then player).
 *
 * @param {{source?: string|null, foundry_user_id?: string|null}|null|undefined} payload
 */
export function shouldMirrorCampaignTextToFoundryChat(payload) {
  const source = String(payload?.source || "").trim().toLowerCase();
  if (source.startsWith("foundry_")) return false;
  // Foundry-originated turns always carry foundry_user_id from the editor.
  if (String(payload?.foundry_user_id || "").trim()) return false;
  return true;
}

/**
 * Fingerprint for near-term duplicate suppression (SignalR vs HTTP race).
 * Role+text only — must be paired with a short time window, never whole-log scan.
 *
 * @param {string|null|undefined} role
 * @param {string|null|undefined} content
 */
export function chatLineFingerprint(role, content) {
  const r = String(role || "").trim().toLowerCase();
  const text = String(content || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!r || !text) return "";
  return `${r}::${text}`;
}

/** Default window for fingerprint dedupe — covers SignalR/HTTP races, not session history. */
export const CHAT_FINGERPRINT_MAX_AGE_MS = 20_000;

/**
 * True only if the same fingerprint was posted recently (not anywhere in world history).
 *
 * @param {string|null|undefined} fingerprint
 * @param {{getFlag?: Function, timestamp?: number}[]} messages
 * @param {string} moduleId
 * @param {{ nowMs?: number, maxAgeMs?: number }} [options]
 */
export function chatFingerprintAlreadyPosted(fingerprint, messages, moduleId, options = {}) {
  if (!fingerprint || !messages) return false;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : CHAT_FINGERPRINT_MAX_AGE_MS;
  const oldest = nowMs - maxAgeMs;
  return messages.some((m) => {
    if (m.getFlag?.(moduleId, "fingerprint") !== fingerprint) return false;
    const ts = Number(m.timestamp);
    // Missing/invalid timestamps are ignored so ancient undated lines cannot block forever.
    if (!Number.isFinite(ts)) return false;
    return ts >= oldest && ts <= nowMs + 1000;
  });
}

/**
 * Exactly one Foundry client may JoinAsFoundry. Prefer Foundry's activeGM so co-GMs
 * do not flap the single foundry presence slot or double-post captions.
 *
 * @param {{id?: string, isGM?: boolean}|null|undefined} localUser
 * @param {{id?: string}|null|undefined} activeGm game.users.activeGM
 */
export function shouldOwnFoundryHub(localUser, activeGm) {
  if (!localUser?.isGM) return false;
  const localId = String(localUser.id || "").trim();
  if (!localId) return false;
  const activeId = String(activeGm?.id || "").trim();
  // No activeGM yet (rare race during ready): allow only if we are a GM and nothing else is designated.
  if (!activeId) return true;
  return localId === activeId;
}

/** Foundry core icon used for Narrator chat lines (not the speaking player's avatar). */
export const NARRATOR_CHAT_PORTRAIT = "icons/svg/book.svg";

/**
 * Resolve which Foundry actor should speak for an NPC catalog id / name.
 * Prefers explicit actor→npc overrides, then name match.
 *
 * @param {string|null|undefined} npcId
 * @param {string|null|undefined} npcName
 * @param {Record<string,string>|null|undefined} actorIdToNpcId
 * @param {Iterable<{id:string,name?:string,img?:string}>} actors
 */
export function findActorForNpc(npcId, npcName, actorIdToNpcId, actors) {
  const wanted = String(npcId || "").trim();
  const map = actorIdToNpcId || {};
  if (wanted) {
    for (const [actorId, mapped] of Object.entries(map)) {
      if (String(mapped || "").trim() === wanted) {
        const hit = [...(actors || [])].find((a) => a?.id === actorId);
        if (hit) return hit;
      }
    }
  }
  if (npcName) {
    return bestNameMatch(npcName, actors || [], "name");
  }
  return null;
}

/**
 * Portrait URL for a chat line. NPC → actor/token img; narrator → system default.
 *
 * @param {"narrator"|"npc"|string} role
 * @param {{img?: string, prototypeToken?: {texture?: {src?: string}}}|null|undefined} actor
 */
export function resolveChatPortraitSrc(role, actor) {
  if (role === "narrator") {
    return NARRATOR_CHAT_PORTRAIT;
  }
  if (role === "npc" && actor) {
    const tokenSrc = actor.prototypeToken?.texture?.src;
    const img = String(actor.img || tokenSrc || "").trim();
    if (img) return img;
  }
  return null;
}

/**
 * Apply a portrait URL onto a rendered Foundry chat message header.
 * @param {ParentNode|JQuery|null|undefined} root
 * @param {string|null|undefined} src
 */
export function applyChatPortraitSrc(root, src) {
  const url = String(src || "").trim();
  if (!root || !url) return false;
  const el = root?.jquery ? root[0] : root?.[0] || root;
  if (!el?.querySelector) return false;

  const img =
    el.querySelector("img.avatar")
    || el.querySelector("a.avatar img")
    || el.querySelector(".message-header img")
    || el.querySelector(".message-sender img")
    || el.querySelector("header.message-header img")
    || el.querySelector(".chat-message img");
  if (img) {
    img.setAttribute("src", url);
    img.removeAttribute("srcset");
    return true;
  }
  const avatar = el.querySelector("a.avatar, .avatar, .message-header .avatar");
  if (avatar) {
    avatar.style.backgroundImage = `url("${url}")`;
    return true;
  }
  return false;
}

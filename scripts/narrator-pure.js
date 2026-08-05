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

/** Pure VTT world-bundle helpers for Foundry harvest (no `game` dependency). */

export const REFERENCE_FOLDER_PATTERN =
  /\b(compendium|srd|phb|dmg|mm\b|monster|monsters|reference|rules|sourcebook|sourcebooks|bestiary|items?|spells?)\b/i;

export const DEFAULT_PER_DOC_CHARS = 8_000;
export const DEFAULT_GLOBAL_BUDGET = 120_000;
export const ADAPTER_VERSION = "0.3.0";

/**
 * @param {string|null|undefined} folderName
 */
export function isReferenceFolderName(folderName) {
  const name = String(folderName || "").trim();
  if (!name) return false;
  return REFERENCE_FOLDER_PATTERN.test(name);
}

/**
 * @param {string|null|undefined} value
 * @param {number} [maxLen]
 */
export function plainTextForImport(value, maxLen = DEFAULT_PER_DOC_CHARS) {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}…`;
}

/**
 * @param {{id?: string, name?: string, folder?: string|null, type?: string}[]} folders
 * @param {"JournalEntry"|"Actor"} documentType
 * @param {{id?: string, folder?: string|null, pack?: string|null}[]} docs
 */
export function buildFolderChecklist(folders, documentType, docs) {
  const byId = new Map();
  for (const f of folders || []) {
    if (!f?.id) continue;
    if (f.type && f.type !== documentType) continue;
    byId.set(f.id, {
      id: f.id,
      name: f.name || f.id,
      documentType,
      count: 0,
      defaultIncluded: !isReferenceFolderName(f.name),
    });
  }

  const root = {
    id: `__root_${documentType}`,
    name: `(No folder)`,
    documentType,
    count: 0,
    defaultIncluded: true,
  };

  for (const doc of docs || []) {
    if (doc?.pack) continue;
    const folderId = doc.folder || null;
    if (folderId && byId.has(folderId)) {
      byId.get(folderId).count += 1;
    } else {
      root.count += 1;
    }
  }

  const list = [...byId.values()].filter((f) => f.count > 0);
  if (root.count > 0) list.unshift(root);
  list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return list;
}

/**
 * @param {string|null|undefined} folderId
 * @param {Set<string>} includedFolderIds
 * @param {string} documentType
 */
export function isFolderIncluded(folderId, includedFolderIds, documentType) {
  const key = folderId || `__root_${documentType}`;
  return includedFolderIds.has(key);
}

/**
 * Actor inclusion: on a scene OR in an included folder.
 * @param {{folder?: string|null, onScene?: boolean}} actor
 * @param {Set<string>} includedFolderIds
 */
export function shouldIncludeActor(actor, includedFolderIds) {
  if (actor?.onScene) return true;
  return isFolderIncluded(actor?.folder, includedFolderIds, "Actor");
}

/**
 * @param {object} opts
 * @param {string} opts.worldId
 * @param {string} opts.worldLabel
 * @param {"create_new"|"existing"} opts.destination
 * @param {string|null} [opts.campaignId]
 * @param {string|null} [opts.campaignName]
 * @param {object[]} opts.journals
 * @param {object[]} opts.actors
 * @param {object[]} opts.scenes
 * @param {string[]} [opts.excludedFolderIds]
 * @param {number} [opts.globalBudget]
 * @param {number} [opts.perDocChars]
 */
export function assembleVttWorldBundle(opts) {
  const globalBudget = opts.globalBudget ?? DEFAULT_GLOBAL_BUDGET;
  const perDoc = opts.perDocChars ?? DEFAULT_PER_DOC_CHARS;
  const warnings = [];
  let used = 0;

  const journals = [];
  for (const j of opts.journals || []) {
    const pages = [];
    for (const p of j.pages || []) {
      const text = plainTextForImport(p.text, perDoc);
      if (!text) continue;
      if (used + text.length > globalBudget) {
        warnings.push("Global character budget reached; remaining journal pages were truncated.");
        break;
      }
      used += text.length;
      pages.push({
        id: p.id || null,
        title: p.title || "Page",
        text,
      });
    }
    if (pages.length === 0) continue;
    journals.push({
      id: j.id,
      name: j.name || j.id,
      folder_id: j.folderId || null,
      folder_path: j.folderPath || "",
      pages,
    });
    if (warnings.some((w) => w.includes("Global character budget"))) break;
  }

  const actors = [];
  for (const a of opts.actors || []) {
    let bio = plainTextForImport(a.biography, perDoc);
    if (!bio && !a.name) continue;
    if (used + bio.length > globalBudget) {
      warnings.push("Global character budget reached; remaining actors were skipped.");
      break;
    }
    used += bio.length;
    actors.push({
      id: a.id,
      name: a.name || a.id,
      folder_id: a.folderId || null,
      folder_path: a.folderPath || "",
      type: a.type || null,
      biography: bio,
      on_scene: Boolean(a.onScene),
    });
  }

  const scenes = [];
  for (const s of opts.scenes || []) {
    const notes = plainTextForImport(s.notes, Math.min(perDoc, 2000));
    if (used + notes.length > globalBudget) {
      warnings.push("Global character budget reached; remaining scenes were skipped.");
      break;
    }
    used += notes.length;
    scenes.push({
      id: s.id,
      name: s.name || s.id,
      journal_id: s.journalId || null,
      notes: notes || null,
    });
  }

  return {
    schema_version: 1,
    provider: "foundry",
    adapter_version: ADAPTER_VERSION,
    world_id: opts.worldId || "",
    world_label: opts.worldLabel || "",
    destination: opts.destination === "existing" ? "existing" : "create_new",
    campaign_id: opts.campaignId || null,
    campaign_name: opts.campaignName || null,
    source_kind: "vtt_world",
    journals,
    actors,
    scenes,
    meta: {
      excluded_folder_ids: opts.excludedFolderIds || [],
      journal_count: journals.length,
      actor_count: actors.length,
      scene_count: scenes.length,
      char_count: used,
      warnings,
    },
  };
}

/**
 * Resolve folder path string from folder id chain.
 * @param {string|null|undefined} folderId
 * @param {Map<string, {id: string, name: string, folder?: string|null}>} folderById
 */
export function folderPathFor(folderId, folderById) {
  if (!folderId || !folderById) return "";
  const parts = [];
  let cur = folderId;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const f = folderById.get(cur);
    if (!f) break;
    parts.unshift(f.name || cur);
    cur = f.folder || null;
  }
  return parts.join("/");
}

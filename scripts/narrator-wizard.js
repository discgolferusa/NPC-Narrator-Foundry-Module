/**
 * Multi-step Foundry DialogV2 wizards that POST Narrator-shaped YAML create payloads.
 * TTS voice sample step is intentionally omitted (template defaults on the server).
 */

import {
  CURRENT_EVENT_PROMPTS,
  KNOWN_FACT_PROMPTS,
  LOCAL_TONE_SUGGESTIONS,
  LOCATION_TYPES,
  PERSONALITY_SUGGESTIONS,
  PUBLIC_FACT_PROMPTS,
  RUMOR_PROMPTS,
  SECRET_PROMPTS,
  VOICE_SUGGESTIONS,
  buildLocationKnowledgeRules,
  buildNpcLlmRules,
  pronounsForGender,
} from "./narrator-wizard-data.js";

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const raw of values || []) {
    const text = String(raw ?? "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function chipHtml(group, suggestions, selected) {
  const sel = new Set((selected || []).map((v) => String(v).toLowerCase()));
  return `
    <div class="npc-narrator-chips" data-chip-group="${group}">
      ${suggestions
        .map((label) => {
          const checked = sel.has(label.toLowerCase()) ? "checked" : "";
          return `<label class="npc-narrator-chip"><input type="checkbox" value="${escapeAttr(label)}" ${checked}/><span>${escapeHtml(label)}</span></label>`;
        })
        .join("")}
    </div>
    <div class="form-group npc-narrator-add-row">
      <label>Add your own</label>
      <div class="npc-narrator-inline">
        <input type="text" name="customChip" data-custom-for="${group}" placeholder="Custom entry…" />
      </div>
    </div>`;
}

function promptHtml(field, prompts, answers) {
  return prompts
    .map(
      (p) => `
      <div class="form-group">
        <label>${escapeHtml(p.label)}</label>
        <input type="text" name="${field}__${p.id}" value="${escapeAttr(answers?.[p.id] || "")}" placeholder="${escapeAttr(p.placeholder)}" />
      </div>`,
    )
    .join("");
}

function readChips(root, group) {
  const checked = [...(root?.querySelectorAll?.(`.npc-narrator-chips[data-chip-group="${group}"] input:checked`) || [])]
    .map((el) => el.value);
  const custom = String(root?.querySelector?.(`[data-custom-for="${group}"]`)?.value || "").trim();
  return uniqueStrings([...checked, custom]);
}

function readPrompts(root, field, prompts) {
  const values = [];
  for (const p of prompts) {
    const v = String(root?.querySelector?.(`[name="${field}__${p.id}"]`)?.value || "").trim();
    if (v) values.push(v);
  }
  return uniqueStrings(values);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

/**
 * @param {{ dialogWait: Function, title: string, steps: Array<{id:string,title:string,description:string,render:(draft:any)=>string,collect:(root:Element,draft:any)=>string|null}> }} options
 * @returns {Promise<object|null>}
 */
async function runSteps({ dialogWait, title, steps, draft }) {
  let index = 0;
  while (index >= 0 && index < steps.length) {
    const step = steps[index];
    const isFirst = index === 0;
    const isLast = index === steps.length - 1;
    const content = `
      <div class="npc-narrator-wizard">
        <p class="npc-narrator-wizard-step">Step ${index + 1} of ${steps.length}: ${escapeHtml(step.title)}</p>
        <p class="npc-narrator-wizard-desc">${escapeHtml(step.description)}</p>
        ${step.render(draft)}
        <p class="npc-narrator-wizard-error" data-wizard-error hidden></p>
      </div>`;

    const buttons = [];
    if (!isFirst) {
      buttons.push({
        action: "back",
        label: "Back",
        callback: (_e, button) => {
          step.collect?.(button?.form?.querySelector?.(".npc-narrator-wizard") || button?.form, draft);
          return "back";
        },
      });
    }
    if (!isFirst && !isLast) {
      buttons.push({
        action: "skip",
        label: "Skip",
        callback: () => "skip",
      });
    }
    buttons.push({
      action: isLast ? "finish" : "next",
      label: isLast ? "Create" : "Next",
      icon: isLast ? "fas fa-check" : "fas fa-arrow-right",
      default: true,
      callback: (_e, button) => {
        const root =
          button?.form?.querySelector?.(".npc-narrator-wizard") ||
          button?.form?.querySelector?.("form") ||
          button?.form;
        const err = step.collect?.(root, draft);
        if (err) {
          ui.notifications.warn(err);
          return "invalid";
        }
        return isLast ? "finish" : "next";
      },
    });
    buttons.push({ action: "cancel", label: "Cancel" });

    let result = await dialogWait({
      title: `${title} — ${step.title}`,
      content,
      buttons,
    });
    // Re-prompt same step after validation failure (dialog closes on button click).
    while (result === "invalid") {
      result = await dialogWait({
        title: `${title} — ${step.title}`,
        content: `
          <div class="npc-narrator-wizard">
            <p class="npc-narrator-wizard-step">Step ${index + 1} of ${steps.length}: ${escapeHtml(step.title)}</p>
            <p class="npc-narrator-wizard-desc">${escapeHtml(step.description)}</p>
            ${step.render(draft)}
          </div>`,
        buttons,
      });
    }
    if (result == null || result === "cancel") return null;
    if (result === "back") {
      index = Math.max(0, index - 1);
      continue;
    }
    if (result === "skip" || result === "next") {
      index += 1;
      continue;
    }
    if (result === "finish") return draft;
  }
  return null;
}

function locationOptionsHtml(locations, selectedId) {
  const opts = [`<option value="">— None —</option>`];
  for (const loc of locations || []) {
    const sel = loc.id === selectedId ? " selected" : "";
    opts.push(
      `<option value="${escapeAttr(loc.id)}"${sel}>${escapeHtml(loc.name || loc.id)} (${escapeHtml(loc.id)})</option>`,
    );
  }
  return opts.join("");
}

/**
 * @param {{ dialogWait: Function, apiFetch: Function, locations: Array<{id:string,name:string}>, seed?: object, sourceLabel?: string }} deps
 */
export async function runNpcAuthoringWizard(deps) {
  const { dialogWait, apiFetch, locations = [], seed = {}, sourceLabel = "" } = deps;
  const draft = {
    name: seed.name || "New NPC",
    role: seed.role || "",
    race: seed.race || "",
    gender: seed.gender || "male",
    location_id: seed.location_id || "",
    voice: [...(seed.voice || [])],
    personality: [...(seed.personality || [])],
    public_facts: [...(seed.public_facts || [])],
    known_facts: [...(seed.known_facts || [])],
    secrets: [...(seed.secrets || [])],
    _promptAnswers: {
      public_facts: {},
      known_facts: {},
      secrets: {},
    },
    probes: {
      stayInCharacter: true,
      firstPerson: true,
      reveal: "guarded",
      combat: "reluctant",
      forbidden: "",
      mannerism: "",
      customRules: [],
    },
  };

  const steps = [
    {
      id: "basics",
      title: "Basics",
      description: "Who they are and where they usually are.",
      render: (d) => `
        <div class="form-group"><label>Name</label><input type="text" name="name" value="${escapeAttr(d.name)}" required /></div>
        <div class="form-group"><label>Role</label><input type="text" name="role" value="${escapeAttr(d.role)}" placeholder="e.g. Innkeeper" /></div>
        <div class="form-group"><label>Race</label><input type="text" name="race" value="${escapeAttr(d.race)}" /></div>
        <div class="form-group"><label>Gender</label>
          <select name="gender">
            <option value="male" ${d.gender === "male" ? "selected" : ""}>Male</option>
            <option value="female" ${d.gender === "female" ? "selected" : ""}>Female</option>
            <option value="they" ${d.gender === "they" ? "selected" : ""}>Non-binary / they</option>
          </select>
        </div>
        <div class="form-group"><label>Location</label><select name="location_id">${locationOptionsHtml(locations, d.location_id)}</select></div>`,
      collect: (root, d) => {
        d.name = String(root?.querySelector?.("[name='name']")?.value || "").trim();
        if (!d.name) return "Name is required.";
        d.role = String(root?.querySelector?.("[name='role']")?.value || "").trim();
        d.race = String(root?.querySelector?.("[name='race']")?.value || "").trim();
        d.gender = String(root?.querySelector?.("[name='gender']")?.value || "male");
        d.location_id = String(root?.querySelector?.("[name='location_id']")?.value || "").trim();
        return null;
      },
    },
    {
      id: "voice",
      title: "Speaking style",
      description: "How they sound in text — tone and diction (separate from TTS voice).",
      render: (d) => chipHtml("voice", VOICE_SUGGESTIONS, d.voice),
      collect: (root, d) => {
        d.voice = readChips(root, "voice");
        return null;
      },
    },
    {
      id: "personality",
      title: "Personality",
      description: "Traits that drive attitude and choices.",
      render: (d) => chipHtml("personality", PERSONALITY_SUGGESTIONS, d.personality),
      collect: (root, d) => {
        d.personality = readChips(root, "personality");
        return null;
      },
    },
    {
      id: "public_facts",
      title: "Public facts",
      description: "Things other NPCs know about them.",
      render: (d) => promptHtml("public_facts", PUBLIC_FACT_PROMPTS, d._promptAnswers.public_facts),
      collect: (root, d) => {
        const answers = {};
        for (const p of PUBLIC_FACT_PROMPTS) {
          answers[p.id] = String(root?.querySelector?.(`[name="public_facts__${p.id}"]`)?.value || "").trim();
        }
        d._promptAnswers.public_facts = answers;
        d.public_facts = uniqueStrings(Object.values(answers).filter(Boolean));
        return null;
      },
    },
    {
      id: "known_facts",
      title: "Known facts",
      description: "Things this NPC knows that are not necessarily public.",
      render: (d) => promptHtml("known_facts", KNOWN_FACT_PROMPTS, d._promptAnswers.known_facts),
      collect: (root, d) => {
        const answers = {};
        for (const p of KNOWN_FACT_PROMPTS) {
          answers[p.id] = String(root?.querySelector?.(`[name="known_facts__${p.id}"]`)?.value || "").trim();
        }
        d._promptAnswers.known_facts = answers;
        d.known_facts = uniqueStrings(Object.values(answers).filter(Boolean));
        return null;
      },
    },
    {
      id: "secrets",
      title: "Secrets",
      description: "Private knowledge they should not volunteer.",
      render: (d) => promptHtml("secrets", SECRET_PROMPTS, d._promptAnswers.secrets),
      collect: (root, d) => {
        const answers = {};
        for (const p of SECRET_PROMPTS) {
          answers[p.id] = String(root?.querySelector?.(`[name="secrets__${p.id}"]`)?.value || "").trim();
        }
        d._promptAnswers.secrets = answers;
        d.secrets = uniqueStrings(Object.values(answers).filter(Boolean));
        return null;
      },
    },
    {
      id: "llm_rules",
      title: "Behavior rules",
      description: "Hard instructions for the model. Voice TTS uses editor defaults (tune later in Campaign Editor).",
      render: (d) => `
        <label class="npc-narrator-check"><input type="checkbox" name="stay" ${d.probes.stayInCharacter ? "checked" : ""}/> Stay in character always?</label>
        <label class="npc-narrator-check"><input type="checkbox" name="first" ${d.probes.firstPerson ? "checked" : ""}/> Speak in first person only?</label>
        <fieldset class="npc-narrator-fieldset"><legend>How much do they reveal?</legend>
          <label><input type="radio" name="reveal" value="open" ${d.probes.reveal === "open" ? "checked" : ""}/> Open</label>
          <label><input type="radio" name="reveal" value="guarded" ${d.probes.reveal === "guarded" ? "checked" : ""}/> Guarded</label>
          <label><input type="radio" name="reveal" value="secretive" ${d.probes.reveal === "secretive" ? "checked" : ""}/> Secretive</label>
        </fieldset>
        <fieldset class="npc-narrator-fieldset"><legend>Combat / danger attitude?</legend>
          <label><input type="radio" name="combat" value="eager" ${d.probes.combat === "eager" ? "checked" : ""}/> Eager</label>
          <label><input type="radio" name="combat" value="reluctant" ${d.probes.combat === "reluctant" ? "checked" : ""}/> Reluctant</label>
          <label><input type="radio" name="combat" value="flee" ${d.probes.combat === "flee" ? "checked" : ""}/> Flee</label>
        </fieldset>
        <div class="form-group"><label>Forbidden topics</label><input type="text" name="forbidden" value="${escapeAttr(d.probes.forbidden)}" /></div>
        <div class="form-group"><label>Catchphrase / mannerism</label><input type="text" name="mannerism" value="${escapeAttr(d.probes.mannerism)}" /></div>
        <div class="form-group"><label>Extra rule</label><input type="text" name="customRule" placeholder="Optional custom rule" /></div>`,
      collect: (root, d) => {
        d.probes.stayInCharacter = Boolean(root?.querySelector?.("[name='stay']")?.checked);
        d.probes.firstPerson = Boolean(root?.querySelector?.("[name='first']")?.checked);
        d.probes.reveal = String(root?.querySelector?.("[name='reveal']:checked")?.value || "guarded");
        d.probes.combat = String(root?.querySelector?.("[name='combat']:checked")?.value || "reluctant");
        d.probes.forbidden = String(root?.querySelector?.("[name='forbidden']")?.value || "").trim();
        d.probes.mannerism = String(root?.querySelector?.("[name='mannerism']")?.value || "").trim();
        const custom = String(root?.querySelector?.("[name='customRule']")?.value || "").trim();
        d.probes.customRules = custom ? [custom] : [];
        return null;
      },
    },
    {
      id: "review",
      title: "Review",
      description: "Create this NPC in your NPC Narrator campaign.",
      render: (d) => `
        <div class="npc-narrator-review">
          <p><strong>Name:</strong> ${escapeHtml(d.name)}</p>
          <p><strong>Role:</strong> ${escapeHtml(d.role || "—")}</p>
          <p><strong>Location:</strong> ${escapeHtml(d.location_id || "—")}</p>
          <p><strong>Voice:</strong> ${escapeHtml(d.voice.join("; ") || "—")}</p>
          <p><strong>Personality:</strong> ${escapeHtml(d.personality.join("; ") || "—")}</p>
          <p><strong>Public facts:</strong> ${escapeHtml(d.public_facts.join("; ") || "—")}</p>
          <p><strong>Known facts:</strong> ${escapeHtml(d.known_facts.join("; ") || "—")}</p>
          <p><strong>Secrets:</strong> ${escapeHtml(d.secrets.join("; ") || "—")}</p>
          <p><em>TTS uses campaign editor defaults (no voice sample in Foundry).</em></p>
        </div>`,
      collect: () => null,
    },
  ];

  const finished = await runSteps({
    dialogWait,
    title: "Create Narrator NPC",
    steps,
    draft,
  });
  if (!finished) return null;

  const body = {
    name: finished.name,
    role: finished.role,
    race: finished.race,
    gender: finished.gender,
    pronouns: pronounsForGender(finished.gender),
    location_id: finished.location_id,
    voice: finished.voice,
    personality: finished.personality,
    public_facts: finished.public_facts,
    known_facts: finished.known_facts,
    secrets: finished.secrets,
    llm_rules: buildNpcLlmRules(finished.probes),
    source_label: sourceLabel || undefined,
  };

  const { response, data } = await apiFetch("/api/foundry/npcs", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(data?.error || data?.detail || "Could not create NPC.");
  }
  return data;
}

/**
 * @param {{ dialogWait: Function, apiFetch: Function, seed?: object, sourceLabel?: string }} deps
 */
export async function runLocationAuthoringWizard(deps) {
  const { dialogWait, apiFetch, seed = {}, sourceLabel = "" } = deps;
  const draft = {
    name: seed.name || "New Location",
    type: seed.type || "city",
    summary: seed.summary || "",
    local_tone: [...(seed.local_tone || [])],
    current_events: [...(seed.current_events || [])],
    important_locations: [...(seed.important_locations || [])],
    rumors: [...(seed.rumors || [])],
    _promptAnswers: {
      current_events: {},
      rumors: {},
    },
    probes: {
      strangers: "guarded",
      rumors: "locals",
      forbidden: "",
      localsKnow: "",
      customRules: [],
    },
  };

  const steps = [
    {
      id: "basics",
      title: "Basics",
      description: "What this place is. Id is assigned from the name on the server.",
      render: (d) => `
        <div class="form-group"><label>Name</label><input type="text" name="name" value="${escapeAttr(d.name)}" required /></div>
        <div class="form-group"><label>Type</label>
          <select name="type">${LOCATION_TYPES.map((t) => `<option value="${t}" ${d.type === t ? "selected" : ""}>${t}</option>`).join("")}</select>
        </div>`,
      collect: (root, d) => {
        d.name = String(root?.querySelector?.("[name='name']")?.value || "").trim();
        if (!d.name) return "Name is required.";
        d.type = String(root?.querySelector?.("[name='type']")?.value || "city");
        return null;
      },
    },
    {
      id: "summary",
      title: "Summary",
      description: "Short overview for the model and DM.",
      render: (d) => `<div class="form-group"><label>Summary</label><textarea name="summary" rows="6">${escapeHtml(d.summary)}</textarea></div>`,
      collect: (root, d) => {
        d.summary = String(root?.querySelector?.("[name='summary']")?.value || "").trim();
        return null;
      },
    },
    {
      id: "local_tone",
      title: "Local tone",
      description: "Mood and atmosphere.",
      render: (d) => chipHtml("local_tone", LOCAL_TONE_SUGGESTIONS, d.local_tone),
      collect: (root, d) => {
        d.local_tone = readChips(root, "local_tone");
        return null;
      },
    },
    {
      id: "current_events",
      title: "Current events",
      description: "Ongoing situations NPCs might mention.",
      render: (d) => promptHtml("current_events", CURRENT_EVENT_PROMPTS, d._promptAnswers.current_events),
      collect: (root, d) => {
        const answers = {};
        for (const p of CURRENT_EVENT_PROMPTS) {
          answers[p.id] = String(root?.querySelector?.(`[name="current_events__${p.id}"]`)?.value || "").trim();
        }
        d._promptAnswers.current_events = answers;
        d.current_events = uniqueStrings(Object.values(answers).filter(Boolean));
        return null;
      },
    },
    {
      id: "subplaces",
      title: "Sub-places",
      description: "Named spots inside this location (name + short description). Public knowledge can be filled later in the editor.",
      render: (d) => {
        const rows = d.important_locations.length
          ? d.important_locations
          : [{ name: "", description: "" }, { name: "", description: "" }];
        return rows
          .map(
            (row, i) => `
            <div class="npc-narrator-subplace">
              <div class="form-group"><label>Sub-place ${i + 1} name</label><input type="text" name="sp_name_${i}" value="${escapeAttr(row.name || "")}" /></div>
              <div class="form-group"><label>Short description</label><input type="text" name="sp_desc_${i}" value="${escapeAttr(row.description || "")}" /></div>
            </div>`,
          )
          .join("") +
          `<p class="notes">Leave unused rows blank. Add more later in the Campaign Editor.</p>`;
      },
      collect: (root, d) => {
        const list = [];
        for (let i = 0; i < 8; i++) {
          const name = String(root?.querySelector?.(`[name='sp_name_${i}']`)?.value || "").trim();
          const description = String(root?.querySelector?.(`[name='sp_desc_${i}']`)?.value || "").trim();
          if (!name) continue;
          list.push({ name, description, public_knowledge: "" });
        }
        d.important_locations = list;
        return null;
      },
    },
    {
      id: "rumors",
      title: "Rumors",
      description: "Gossip and uncertain talk — not confirmed facts.",
      render: (d) => promptHtml("rumors", RUMOR_PROMPTS, d._promptAnswers.rumors),
      collect: (root, d) => {
        const answers = {};
        for (const p of RUMOR_PROMPTS) {
          answers[p.id] = String(root?.querySelector?.(`[name="rumors__${p.id}"]`)?.value || "").trim();
        }
        d._promptAnswers.rumors = answers;
        d.rumors = uniqueStrings(Object.values(answers).filter(Boolean));
        return null;
      },
    },
    {
      id: "knowledge",
      title: "Knowledge rules",
      description: "What locals know or must not discuss.",
      render: (d) => `
        <fieldset class="npc-narrator-fieldset"><legend>Are locals open with strangers?</legend>
          <label><input type="radio" name="strangers" value="open" ${d.probes.strangers === "open" ? "checked" : ""}/> Open</label>
          <label><input type="radio" name="strangers" value="guarded" ${d.probes.strangers === "guarded" ? "checked" : ""}/> Guarded</label>
          <label><input type="radio" name="strangers" value="hostile" ${d.probes.strangers === "hostile" ? "checked" : ""}/> Hostile</label>
        </fieldset>
        <fieldset class="npc-narrator-fieldset"><legend>Do they share rumors freely?</legend>
          <label><input type="radio" name="rumorShare" value="yes" ${d.probes.rumors === "yes" ? "checked" : ""}/> Yes</label>
          <label><input type="radio" name="rumorShare" value="locals" ${d.probes.rumors === "locals" ? "checked" : ""}/> Only among locals</label>
          <label><input type="radio" name="rumorShare" value="rarely" ${d.probes.rumors === "rarely" ? "checked" : ""}/> Rarely</label>
        </fieldset>
        <div class="form-group"><label>Forbidden topics</label><input type="text" name="forbidden" value="${escapeAttr(d.probes.forbidden)}" /></div>
        <div class="form-group"><label>What every local knows</label><input type="text" name="localsKnow" value="${escapeAttr(d.probes.localsKnow)}" /></div>
        <div class="form-group"><label>Extra rule</label><input type="text" name="customRule" /></div>`,
      collect: (root, d) => {
        d.probes.strangers = String(root?.querySelector?.("[name='strangers']:checked")?.value || "guarded");
        d.probes.rumors = String(root?.querySelector?.("[name='rumorShare']:checked")?.value || "locals");
        d.probes.forbidden = String(root?.querySelector?.("[name='forbidden']")?.value || "").trim();
        d.probes.localsKnow = String(root?.querySelector?.("[name='localsKnow']")?.value || "").trim();
        const custom = String(root?.querySelector?.("[name='customRule']")?.value || "").trim();
        d.probes.customRules = custom ? [custom] : [];
        return null;
      },
    },
    {
      id: "review",
      title: "Review",
      description: "Create this location in your NPC Narrator campaign.",
      render: (d) => `
        <div class="npc-narrator-review">
          <p><strong>Name:</strong> ${escapeHtml(d.name)}</p>
          <p><strong>Type:</strong> ${escapeHtml(d.type)}</p>
          <p><strong>Summary:</strong> ${escapeHtml(d.summary || "—")}</p>
          <p><strong>Tone:</strong> ${escapeHtml(d.local_tone.join("; ") || "—")}</p>
          <p><strong>Sub-places:</strong> ${escapeHtml(d.important_locations.map((p) => p.name).join("; ") || "—")}</p>
        </div>`,
      collect: () => null,
    },
  ];

  const finished = await runSteps({
    dialogWait,
    title: "Create Narrator Location",
    steps,
    draft,
  });
  if (!finished) return null;

  const body = {
    name: finished.name,
    type: finished.type,
    summary: finished.summary,
    local_tone: finished.local_tone,
    current_events: finished.current_events,
    important_locations: finished.important_locations,
    rumors: finished.rumors,
    knowledge_rules: buildLocationKnowledgeRules(finished.probes),
    source_label: sourceLabel || undefined,
  };

  const { response, data } = await apiFetch("/api/foundry/locations", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(data?.error || data?.detail || "Could not create location.");
  }
  return data;
}

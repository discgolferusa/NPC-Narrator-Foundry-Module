/** Chip lists and probe maps shared conceptually with the Yaml Editor wizards. */

export const VOICE_SUGGESTIONS = [
  "terse and blunt",
  "warm and folksy",
  "formal and precise",
  "wry / sarcastic",
  "nervous and rambling",
  "theatrical",
  "soft-spoken",
  "uses short sentences",
  "drops into dialect/slang",
  "never swears",
];

export const PERSONALITY_SUGGESTIONS = [
  "loyal",
  "curious",
  "greedy",
  "cautious",
  "hot-tempered",
  "kind-hearted",
  "secretive",
  "ambitious",
  "world-weary",
  "playful",
  "proud",
  "cowardly",
];

export const PUBLIC_FACT_PROMPTS = [
  { id: "occupation", label: "Occupation or role", placeholder: "e.g. Town blacksmith" },
  { id: "home", label: "Where they live or work", placeholder: "e.g. Keeps a stall near the north gate" },
  { id: "boss", label: "Who they answer to", placeholder: "e.g. Reports to the guildmaster" },
  { id: "allies", label: "Known allies or rivals", placeholder: "e.g. Feuds with the harbormaster" },
  { id: "reputation", label: "Public reputation", placeholder: "e.g. Respected but tight-lipped" },
];

export const KNOWN_FACT_PROMPTS = [
  { id: "goal", label: "Personal goal", placeholder: "e.g. Wants enough coin to leave town" },
  { id: "contacts", label: "Useful contacts", placeholder: "e.g. Owes a favor to a smuggler" },
  { id: "events", label: "Recent events they witnessed", placeholder: "e.g. Saw strangers near the ruins" },
  { id: "skills", label: "Skills or expertise", placeholder: "e.g. Expert tracker and herbalist" },
];

export const SECRET_PROMPTS = [
  { id: "allegiance", label: "Hidden allegiance", placeholder: "e.g. Quietly serves a rival lord" },
  { id: "debt", label: "Crime or debt", placeholder: "e.g. Embezzled from the temple coffers" },
  { id: "forbidden", label: "Forbidden knowledge", placeholder: "e.g. Knows where the relic is buried" },
  { id: "opinion", label: "True opinion of the party", placeholder: "e.g. Distrusts adventurers deeply" },
];

export const LOCAL_TONE_SUGGESTIONS = [
  "bustling",
  "quiet",
  "festive",
  "tense",
  "oppressive",
  "welcoming",
  "secretive",
  "rundown",
  "prosperous",
  "dangerous after dark",
  "sacred",
  "lawless",
];

export const CURRENT_EVENT_PROMPTS = [
  { id: "festival", label: "Festival or gathering", placeholder: "e.g. Midsummer market starts tomorrow" },
  { id: "conflict", label: "Conflict or dispute", placeholder: "e.g. Two guilds feud over dock fees" },
  { id: "arrival", label: "Recent arrival or departure", placeholder: "e.g. A caravan from the south arrived yesterday" },
  { id: "economy", label: "Shortage or boom", placeholder: "e.g. Grain prices have spiked" },
  { id: "mystery", label: "Mysterious occurrence", placeholder: "e.g. Lights seen in the old tower at night" },
];

export const RUMOR_PROMPTS = [
  { id: "hidden", label: "Something hidden nearby", placeholder: "e.g. A smuggler's tunnel under the quay" },
  { id: "power", label: "Who really runs things", placeholder: "e.g. The mayor answers to a crime boss" },
  { id: "danger", label: "A danger outsiders underestimate", placeholder: "e.g. The woods aren't safe after dusk" },
  { id: "curse", label: "A blessing or curse people whisper about", placeholder: "e.g. The well grants wishes — for a price" },
];

export const LOCATION_TYPES = [
  "city",
  "town",
  "dungeon",
  "forest",
  "building",
  "ship",
  "region",
  "other",
];

export const PRONOUN_PRESETS = {
  male: {
    subject: "he",
    object: "him",
    possessive_adjective: "his",
    possessive_pronoun: "his",
    reflexive: "himself",
  },
  female: {
    subject: "she",
    object: "her",
    possessive_adjective: "her",
    possessive_pronoun: "hers",
    reflexive: "herself",
  },
  they: {
    subject: "they",
    object: "them",
    possessive_adjective: "their",
    possessive_pronoun: "theirs",
    reflexive: "themselves",
  },
};

export function pronounsForGender(gender) {
  const key = String(gender || "male").toLowerCase();
  if (key === "female" || key === "woman" || key === "she") return { ...PRONOUN_PRESETS.female };
  if (key === "they" || key === "nonbinary" || key === "non-binary" || key === "nb") {
    return { ...PRONOUN_PRESETS.they };
  }
  return { ...PRONOUN_PRESETS.male };
}

export function buildNpcLlmRules(probes) {
  const rules = [];
  if (probes.stayInCharacter) {
    rules.push("Always stay in character; never mention being an AI or breaking the fourth wall.");
  }
  if (probes.firstPerson) {
    rules.push("Speak in first person as this character.");
  }
  if (probes.reveal === "open") {
    rules.push("Be forthcoming: volunteer relevant information when asked politely.");
  } else if (probes.reveal === "secretive") {
    rules.push("Be secretive: refuse to discuss secrets and answer personal questions briefly or evasively.");
  } else {
    rules.push("Be guarded: answer briefly and do not volunteer secrets or private plans.");
  }
  if (probes.combat === "eager") {
    rules.push("In danger or combat, act eager and confrontational.");
  } else if (probes.combat === "flee") {
    rules.push("In danger or combat, prefer to flee or de-escalate rather than fight.");
  } else {
    rules.push("In danger or combat, act reluctant and prefer negotiation when possible.");
  }
  if (probes.forbidden) rules.push(`Never discuss: ${probes.forbidden}`);
  if (probes.mannerism) rules.push(`Occasionally use this mannerism: ${probes.mannerism}`);
  for (const custom of probes.customRules || []) {
    const text = String(custom || "").trim();
    if (text) rules.push(text);
  }
  return [...new Set(rules)];
}

export function buildLocationKnowledgeRules(probes) {
  const rules = [];
  if (probes.strangers === "open") {
    rules.push("Locals are open with strangers and generally willing to answer questions.");
  } else if (probes.strangers === "hostile") {
    rules.push("Locals are hostile or cold toward strangers and answer reluctantly.");
  } else {
    rules.push("Locals are guarded with strangers and answer briefly.");
  }
  if (probes.rumors === "yes") {
    rules.push("Locals share rumors freely, even with outsiders.");
  } else if (probes.rumors === "rarely") {
    rules.push("Locals rarely share rumors; gossip stays closely held.");
  } else {
    rules.push("Locals share rumors mainly among themselves, not freely with outsiders.");
  }
  if (probes.forbidden) rules.push(`Never discuss: ${probes.forbidden}`);
  if (probes.localsKnow) rules.push(`Locals generally know: ${probes.localsKnow}`);
  for (const custom of probes.customRules || []) {
    const text = String(custom || "").trim();
    if (text) rules.push(text);
  }
  return [...new Set(rules)];
}

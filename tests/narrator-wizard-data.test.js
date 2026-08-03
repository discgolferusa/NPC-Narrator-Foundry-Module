import { describe, expect, it } from "vitest";
import {
  buildLocationKnowledgeRules,
  buildNpcLlmRules,
  pronounsForGender,
} from "../scripts/narrator-wizard-data.js";

describe("pronounsForGender", () => {
  it("maps aliases", () => {
    expect(pronounsForGender("female").subject).toBe("she");
    expect(pronounsForGender("nonbinary").subject).toBe("they");
    expect(pronounsForGender("male").object).toBe("him");
  });
});

describe("buildNpcLlmRules", () => {
  it("includes reveal/combat defaults and dedupes customs", () => {
    const rules = buildNpcLlmRules({
      stayInCharacter: true,
      firstPerson: true,
      reveal: "secretive",
      combat: "flee",
      forbidden: "the vault",
      customRules: ["Be brief", "Be brief", ""],
    });

    expect(rules).toContain("Always stay in character; never mention being an AI or breaking the fourth wall.");
    expect(rules).toContain("Speak in first person as this character.");
    expect(rules.some((r) => r.includes("secretive"))).toBe(true);
    expect(rules.some((r) => r.includes("flee"))).toBe(true);
    expect(rules).toContain("Never discuss: the vault");
    expect(rules.filter((r) => r === "Be brief")).toHaveLength(1);
  });
});

describe("buildLocationKnowledgeRules", () => {
  it("covers stranger and rumor tones", () => {
    const rules = buildLocationKnowledgeRules({
      strangers: "hostile",
      rumors: "rarely",
      localsKnow: "the well is cursed",
    });

    expect(rules.some((r) => r.toLowerCase().includes("hostile"))).toBe(true);
    expect(rules.some((r) => r.toLowerCase().includes("rarely"))).toBe(true);
    expect(rules).toContain("Locals generally know: the well is cursed");
  });
});

import { describe, expect, it } from "vitest";
import {
  bestNameMatch,
  chatAlreadyPosted,
  escapeHtml,
  nameMatchScore,
  normalizeName,
  plainTextSeed,
  shouldAcceptCampaignText,
  shouldOwnFoundryHub,
  whisperTargets,
} from "../scripts/narrator-pure.js";

describe("normalizeName / nameMatchScore / bestNameMatch", () => {
  it("normalizes punctuation and case", () => {
    expect(normalizeName("  Captain-Varra! ")).toBe("captain varra");
  });

  it("scores exact and substring matches", () => {
    expect(nameMatchScore("Captain Varra", "captain varra")).toBe(100);
    expect(nameMatchScore("Varra", "Captain Varra")).toBe(80);
    expect(nameMatchScore("Bob", "Alice")).toBe(0);
  });

  it("returns best match at threshold 80+", () => {
    const items = [
      { id: "a", name: "Alice" },
      { id: "v", name: "Captain Varra" },
    ];
    expect(bestNameMatch("Varra", items)?.id).toBe("v");
    expect(bestNameMatch("Nobody", items)).toBeNull();
  });
});

describe("plainTextSeed / escapeHtml", () => {
  it("strips html and truncates", () => {
    expect(plainTextSeed("<p>Hello   world</p>")).toBe("Hello world");
    expect(plainTextSeed("abcdefghij", 5)).toBe("abcde…");
    expect(plainTextSeed(null)).toBe("");
  });

  it("escapes html entities", () => {
    expect(escapeHtml(`<a href="x">&</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });
});

describe("whisperTargets / chatAlreadyPosted", () => {
  it("includes player and all GMs", () => {
    const targets = whisperTargets("player-1", [
      { id: "player-1", isGM: false },
      { id: "gm-1", isGM: true },
      { id: "player-2", isGM: false },
    ]);
    expect(targets.sort()).toEqual(["gm-1", "player-1"]);
  });

  it("detects duplicate chat flags", () => {
    const messages = [
      {
        getFlag(moduleId, key) {
          if (moduleId !== "npc-narrator") return null;
          if (key === "requestId") return "req-1";
          if (key === "role") return "npc";
          return null;
        },
      },
    ];
    expect(chatAlreadyPosted("req-1", "npc", messages, "npc-narrator")).toBe(true);
    expect(chatAlreadyPosted("req-1", "narrator", messages, "npc-narrator")).toBe(false);
    expect(chatAlreadyPosted("", "npc", messages, "npc-narrator")).toBe(false);
  });
});

describe("shouldAcceptCampaignText", () => {
  it("rejects other campaigns and unbound sessions", () => {
    expect(shouldAcceptCampaignText({ campaign_id: "a" }, null)).toBe(false);
    expect(shouldAcceptCampaignText({ campaign_id: "other" }, { campaignId: "bound" })).toBe(false);
    expect(shouldAcceptCampaignText({ campaign_id: "Bound" }, { campaignId: "bound" })).toBe(true);
    expect(shouldAcceptCampaignText({ campaign_id: "Bound" }, { campaignId: "bound" })).toBe(true);
    expect(shouldAcceptCampaignText({}, { campaignId: "bound" })).toBe(true);
  });
});

describe("shouldOwnFoundryHub", () => {
  it("allows only the active GM among co-GMs", () => {
    expect(shouldOwnFoundryHub({ id: "p1", isGM: false }, { id: "gm1" })).toBe(false);
    expect(shouldOwnFoundryHub({ id: "gm2", isGM: true }, { id: "gm1" })).toBe(false);
    expect(shouldOwnFoundryHub({ id: "gm1", isGM: true }, { id: "gm1" })).toBe(true);
    expect(shouldOwnFoundryHub({ id: "gm1", isGM: true }, null)).toBe(true);
  });
});

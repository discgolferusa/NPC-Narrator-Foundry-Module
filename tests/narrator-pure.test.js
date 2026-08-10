import { describe, expect, it } from "vitest";
import {
  bestNameMatch,
  chatAlreadyPosted,
  chatFingerprintAlreadyPosted,
  chatLineFingerprint,
  escapeHtml,
  nameMatchScore,
  normalizeName,
  plainTextSeed,
  applyChatPortraitSrc,
  findActorForNpc,
  NARRATOR_CHAT_PORTRAIT,
  NARRATOR_PORTRAIT_UPLOAD_DIR,
  actorPortraitTokenUpdate,
  portraitFileExtension,
  portraitUploadFileStem,
  resolveChatPortraitSrc,
  shouldAcceptCampaignText,
  shouldMirrorCampaignTextToFoundryChat,
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

describe("shouldMirrorCampaignTextToFoundryChat", () => {
  it("skips foundry_* captions and any payload with foundry_user_id", () => {
    expect(shouldMirrorCampaignTextToFoundryChat({ source: "foundry_npc_turn" })).toBe(false);
    expect(shouldMirrorCampaignTextToFoundryChat({ source: "FOUNDRY_NPC_TURN" })).toBe(false);
    expect(shouldMirrorCampaignTextToFoundryChat({ source: "foundry_other" })).toBe(false);
    expect(
      shouldMirrorCampaignTextToFoundryChat({ source: "mystery", foundry_user_id: "u1" }),
    ).toBe(false);
  });

  it("still mirrors Discord/browser/other caption sources into Foundry chat", () => {
    expect(shouldMirrorCampaignTextToFoundryChat({ source: "discord_npc_turn" })).toBe(true);
    expect(shouldMirrorCampaignTextToFoundryChat({ source: "dm_voice_turn" })).toBe(true);
    expect(shouldMirrorCampaignTextToFoundryChat({})).toBe(true);
  });
});

describe("chatLineFingerprint", () => {
  it("dedupes identical role+content ignoring html/whitespace", () => {
    const a = chatLineFingerprint("narrator", "<em>Hello   world</em>");
    const b = chatLineFingerprint("narrator", "Hello world");
    expect(a).toBe(b);
    expect(chatLineFingerprint("npc", "Hello world")).not.toBe(a);
  });

  it("treats another author's recent matching fingerprint as a cross-client duplicate", () => {
    const fp = chatLineFingerprint("npc", "Crisis on our hands");
    const gmLine = {
      author: { id: "gm1" },
      getFlag(moduleId, key) {
        if (moduleId === "npc-narrator" && key === "fingerprint") return fp;
        if (moduleId === "npc-narrator" && key === "requestId") return null;
        return null;
      },
    };
    expect(
      chatFingerprintAlreadyPosted(fp, [gmLine], "npc-narrator", {
        authorId: "player2",
        requestId: "req-foundry-1",
      }),
    ).toBe(true);
  });

  it("does not skip a new requestId when a Discord/browser line reused the same wording", () => {
    const fp = chatLineFingerprint("narrator", "The door creaks open.");
    const discordMirror = {
      author: { id: "gm1" },
      getFlag(moduleId, key) {
        if (moduleId !== "npc-narrator") return null;
        if (key === "fingerprint") return fp;
        if (key === "requestId") return "req-discord-1";
        return null;
      },
    };
    expect(
      chatFingerprintAlreadyPosted(fp, [discordMirror], "npc-narrator", {
        authorId: "player2",
        requestId: "req-foundry-2",
      }),
    ).toBe(false);
  });

  it("still collapses the same requestId across authors when one side echoed the id", () => {
    const fp = chatLineFingerprint("npc", "Crisis on our hands");
    const gmLine = {
      author: { id: "gm1" },
      getFlag(moduleId, key) {
        if (moduleId !== "npc-narrator") return null;
        if (key === "fingerprint") return fp;
        if (key === "requestId") return "req-shared";
        return null;
      },
    };
    expect(
      chatFingerprintAlreadyPosted(fp, [gmLine], "npc-narrator", {
        authorId: "player2",
        requestId: "req-shared",
      }),
    ).toBe(true);
  });

  it("allows the same author to repeat the same wording later", () => {
    const fp = chatLineFingerprint("narrator", "The door creaks open.");
    const prior = {
      author: { id: "player2" },
      getFlag(moduleId, key) {
        if (moduleId === "npc-narrator" && key === "fingerprint") return fp;
        return null;
      },
    };
    expect(
      chatFingerprintAlreadyPosted(fp, [prior], "npc-narrator", { authorId: "player2" }),
    ).toBe(false);
  });

  it("only scans a trailing lookback so ancient matches do not block forever", () => {
    const fp = chatLineFingerprint("npc", "Hello again");
    const ancient = {
      author: { id: "gm1" },
      getFlag(moduleId, key) {
        if (moduleId === "npc-narrator" && key === "fingerprint") return fp;
        return null;
      },
    };
    const filler = Array.from({ length: 5 }, (_, i) => ({
      author: { id: "u" },
      getFlag: () => null,
      id: `m${i}`,
    }));
    expect(
      chatFingerprintAlreadyPosted(fp, [ancient, ...filler], "npc-narrator", {
        authorId: "player2",
        lookback: 5,
      }),
    ).toBe(false);
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

describe("chat portraits", () => {
  it("finds actor by override then name", () => {
    const actors = [
      { id: "a1", name: "Innkeeper Marta", img: "actors/marta.webp" },
      { id: "a2", name: "Guard", img: "actors/guard.webp" },
    ];
    expect(findActorForNpc("inn_1", null, { a1: "inn_1" }, actors)?.id).toBe("a1");
    expect(findActorForNpc(null, "Guard", {}, actors)?.id).toBe("a2");
  });

  it("uses system narrator icon and actor img for npc", () => {
    expect(resolveChatPortraitSrc("narrator", null)).toBe(NARRATOR_CHAT_PORTRAIT);
    expect(resolveChatPortraitSrc("npc", { img: "path/npc.webp" })).toBe("path/npc.webp");
    expect(resolveChatPortraitSrc("npc", { prototypeToken: { texture: { src: "tok.webp" } } })).toBe(
      "tok.webp",
    );
  });

  it("applies portrait src onto chat header img", () => {
    const img = {
      _src: null,
      setAttribute(k, v) {
        if (k === "src") this._src = v;
      },
      removeAttribute() {},
    };
    const root = {
      querySelector(sel) {
        if (sel.includes("img")) return img;
        return null;
      },
    };
    expect(applyChatPortraitSrc(root, "icons/svg/book.svg")).toBe(true);
    expect(img._src).toBe("icons/svg/book.svg");
  });
});

describe("portrait sync helpers", () => {
  it("sanitizes npc ids into upload stems", () => {
    expect(portraitUploadFileStem("Captain Vex!")).toBe("captain-vex");
    expect(portraitUploadFileStem("")).toBe("npc");
  });

  it("builds actor img + prototype token update", () => {
    expect(actorPortraitTokenUpdate("npc-narrator/portraits/a.png")).toEqual({
      img: "npc-narrator/portraits/a.png",
      "prototypeToken.texture.src": "npc-narrator/portraits/a.png",
    });
    expect(actorPortraitTokenUpdate("")).toBeNull();
  });

  it("maps content-types to file extensions", () => {
    expect(portraitFileExtension("image/jpeg")).toBe(".jpg");
    expect(portraitFileExtension("image/png")).toBe(".png");
    expect(portraitFileExtension("image/webp")).toBe(".webp");
    expect(portraitFileExtension(null)).toBe(".png");
  });

  it("uses a stable upload directory", () => {
    expect(NARRATOR_PORTRAIT_UPLOAD_DIR).toBe("npc-narrator/portraits");
  });
});

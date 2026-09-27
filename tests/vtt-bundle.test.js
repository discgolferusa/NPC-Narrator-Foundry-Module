import { describe, expect, it } from "vitest";
import {
  assembleVttWorldBundle,
  buildFolderChecklist,
  folderPathFor,
  isFolderIncluded,
  isReferenceFolderName,
  plainTextForImport,
  shouldIncludeActor,
} from "../scripts/vtt-bundle.js";

describe("isReferenceFolderName", () => {
  it("flags common sourcebook folder names", () => {
    expect(isReferenceFolderName("SRD Monsters")).toBe(true);
    expect(isReferenceFolderName("PHB Spells")).toBe(true);
    expect(isReferenceFolderName("Rules Reference")).toBe(true);
    expect(isReferenceFolderName("Adventures")).toBe(false);
    expect(isReferenceFolderName("Rivers End")).toBe(false);
  });
});

describe("plainTextForImport", () => {
  it("strips html and respects max length", () => {
    expect(plainTextForImport("<p>Hello&nbsp;<b>world</b></p>")).toBe("Hello world");
    expect(plainTextForImport("abcdefghij", 5)).toBe("abcde…");
  });
});

describe("buildFolderChecklist / inclusion", () => {
  it("counts world docs and defaults reference folders off", () => {
    const folders = [
      { id: "f1", name: "Adventures", type: "JournalEntry" },
      { id: "f2", name: "SRD Reference", type: "JournalEntry" },
    ];
    const docs = [
      { id: "j1", folder: "f1", pack: null },
      { id: "j2", folder: "f2", pack: null },
      { id: "j3", folder: null, pack: null },
      { id: "packDoc", folder: null, pack: "world.srd" },
    ];
    const list = buildFolderChecklist(folders, "JournalEntry", docs);
    expect(list.find((f) => f.id === "f1")?.defaultIncluded).toBe(true);
    expect(list.find((f) => f.id === "f2")?.defaultIncluded).toBe(false);
    expect(list.find((f) => f.id === "__root_JournalEntry")?.count).toBe(1);
  });

  it("includes on-scene actors even when folder excluded", () => {
    const included = new Set(["__root_Actor"]);
    expect(shouldIncludeActor({ folder: "other", onScene: true }, included)).toBe(true);
    expect(shouldIncludeActor({ folder: "other", onScene: false }, included)).toBe(false);
    expect(isFolderIncluded(null, included, "Actor")).toBe(true);
  });
});

describe("assembleVttWorldBundle", () => {
  it("builds a portable foundry bundle and skips packs via caller filters", () => {
    const bundle = assembleVttWorldBundle({
      worldId: "w1",
      worldLabel: "Greyhaven",
      destination: "create_new",
      campaignName: "Greyhaven Import",
      journals: [
        {
          id: "j1",
          name: "Rivers End",
          folderId: "f1",
          folderPath: "Adventures",
          pages: [{ id: "p1", title: "Overview", text: "<p>A riverside town.</p>" }],
        },
      ],
      actors: [
        {
          id: "a1",
          name: "Varra",
          biography: "<p>Captain</p>",
          onScene: true,
        },
      ],
      scenes: [{ id: "s1", name: "Docks", journalId: "j1", notes: "Fog" }],
      excludedFolderIds: ["f2"],
    });

    expect(bundle.provider).toBe("foundry");
    expect(bundle.source_kind).toBe("vtt_world");
    expect(bundle.journals[0].pages[0].text).toBe("A riverside town.");
    expect(bundle.actors[0].on_scene).toBe(true);
    expect(bundle.meta.scene_count).toBe(1);
    expect(bundle.meta.excluded_folder_ids).toEqual(["f2"]);
    expect(bundle.meta.char_count).toBeGreaterThan(10);
  });

  it("resolves folder paths", () => {
    const map = new Map([
      ["child", { id: "child", name: "Rivers", folder: "parent" }],
      ["parent", { id: "parent", name: "Adventures", folder: null }],
    ]);
    expect(folderPathFor("child", map)).toBe("Adventures/Rivers");
  });
});

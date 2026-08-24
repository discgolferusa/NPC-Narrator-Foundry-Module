import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  PACKAGE_DIRS,
  PACKAGE_ROOT_FILES,
  listPackageRelativePaths,
  packageModule,
  readModuleId,
  stagePackage,
  writeReleaseManifest,
} from "../tools/package-module.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npc-narrator-pkg-"));
  tempDirs.push(dir);
  return dir;
}

describe("package-module (unit)", () => {
  it("reads module id from module.json", () => {
    expect(readModuleId(REPO_ROOT)).toBe("npc-narrator");
  });

  it("lists expected root files and runtime dirs", () => {
    expect(PACKAGE_ROOT_FILES).toEqual(["module.json", "README.md"]);
    expect(PACKAGE_DIRS).toEqual(["scripts", "styles", "templates"]);
  });

  it("lists relative paths under package dirs and excludes tests/tools", () => {
    const paths = listPackageRelativePaths(REPO_ROOT);
    expect(paths).toContain("module.json");
    expect(paths).toContain("README.md");
    expect(paths).toContain("scripts/npc-narrator.js");
    expect(paths).toContain("styles/npc-narrator.css");
    expect(paths).toContain("templates/pairing.hbs");
    expect(paths.every((p) => !p.startsWith("tests/"))).toBe(true);
    expect(paths.every((p) => !p.startsWith("tools/"))).toBe(true);
    expect(paths.every((p) => !p.includes("node_modules"))).toBe(true);
  });

  it("writes release manifest with stable latest download URLs", () => {
    const out = path.join(makeTempDir(), "module.json");
    const manifest = writeReleaseManifest(REPO_ROOT, out, {
      repository: "discgolferusa/NPC-Narrator-Foundry-Module",
      zipName: "npc-narrator.zip",
    });
    expect(manifest.manifest).toBe(
      "https://github.com/discgolferusa/NPC-Narrator-Foundry-Module/releases/latest/download/module.json",
    );
    expect(manifest.download).toBe(
      "https://github.com/discgolferusa/NPC-Narrator-Foundry-Module/releases/latest/download/npc-narrator.zip",
    );
    expect(JSON.parse(fs.readFileSync(out, "utf8")).download).toBe(manifest.download);
  });
});

describe("package-module (functional)", () => {
  it("stages a Foundry-ready folder named after module id", () => {
    const staging = makeTempDir();
    const { moduleId, moduleDir } = stagePackage(REPO_ROOT, staging);
    expect(moduleId).toBe("npc-narrator");
    expect(path.basename(moduleDir)).toBe("npc-narrator");
    expect(fs.existsSync(path.join(moduleDir, "module.json"))).toBe(true);
    expect(fs.existsSync(path.join(moduleDir, "scripts", "npc-narrator.js"))).toBe(true);
    expect(fs.existsSync(path.join(moduleDir, "styles", "npc-narrator.css"))).toBe(true);
    expect(fs.existsSync(path.join(moduleDir, "templates", "pairing.hbs"))).toBe(true);
    expect(fs.existsSync(path.join(moduleDir, "tests"))).toBe(false);
    expect(fs.existsSync(path.join(moduleDir, "tools"))).toBe(false);
    expect(fs.existsSync(path.join(moduleDir, "package.json"))).toBe(false);
  });

  it("builds zip and release manifest under an output directory", () => {
    const outDir = makeTempDir();
    const result = packageModule({ repoRoot: REPO_ROOT, outDir });
    expect(result.moduleId).toBe("npc-narrator");
    expect(fs.existsSync(result.zipPath)).toBe(true);
    expect(fs.statSync(result.zipPath).size).toBeGreaterThan(100);
    expect(fs.existsSync(result.manifestPath)).toBe(true);
    const released = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
    expect(released.id).toBe("npc-narrator");
    expect(released.download).toContain("/releases/latest/download/npc-narrator.zip");
  });
});

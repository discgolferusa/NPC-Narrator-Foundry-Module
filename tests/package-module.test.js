import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  PACKAGE_DIRS,
  PACKAGE_ROOT_FILES,
  ZIP_NAME,
  listPackageRelativePaths,
  packageModule,
  readModuleId,
  readModuleVersion,
  releaseTagForVersion,
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
  it("reads module id and version from module.json", () => {
    expect(readModuleId(REPO_ROOT)).toBe("npc-narrator");
    expect(readModuleVersion(REPO_ROOT)).toMatch(/^\d+\.\d+\.\d+/);
    expect(releaseTagForVersion("0.2.9")).toBe("v0.2.9");
  });

  it("lists expected root files and runtime dirs", () => {
    expect(PACKAGE_ROOT_FILES).toEqual(["module.json", "README.md", "LICENSE", "CHANGELOG.md"]);
    expect(PACKAGE_DIRS).toEqual(["scripts", "styles", "templates", "lib"]);
    expect(ZIP_NAME).toBe("module.zip");
  });

  it("lists relative paths under package dirs and excludes tests/tools", () => {
    const paths = listPackageRelativePaths(REPO_ROOT);
    expect(paths).toContain("module.json");
    expect(paths).toContain("LICENSE");
    expect(paths).toContain("scripts/npc-narrator.js");
    expect(paths).toContain("styles/npc-narrator.css");
    expect(paths).toContain("templates/pairing.hbs");
    expect(paths).toContain("lib/signalr.min.js");
    expect(paths.every((p) => !p.startsWith("tests/"))).toBe(true);
    expect(paths.every((p) => !p.startsWith("tools/"))).toBe(true);
    expect(paths.every((p) => !p.includes("node_modules"))).toBe(true);
  });

  it("writes Foundry-compatible latest manifest + versioned download URLs", () => {
    const out = path.join(makeTempDir(), "module.json");
    const manifest = writeReleaseManifest(REPO_ROOT, out, {
      repository: "discgolferusa/NPC-Narrator-Foundry-Module",
      version: "0.2.9",
      zipName: "module.zip",
    });
    expect(manifest.manifest).toBe(
      "https://github.com/discgolferusa/NPC-Narrator-Foundry-Module/releases/latest/download/module.json",
    );
    expect(manifest.download).toBe(
      "https://github.com/discgolferusa/NPC-Narrator-Foundry-Module/releases/download/v0.2.9/module.zip",
    );
    expect(manifest.license).toBe("LICENSE");
    expect(JSON.parse(fs.readFileSync(out, "utf8")).download).toBe(manifest.download);
  });
});

describe("module.json Foundry compliance (unit)", () => {
  it("has required install/update fields and matching id", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "module.json"), "utf8"));
    expect(manifest.id).toBe("npc-narrator");
    expect(manifest.title).toBeTruthy();
    expect(manifest.description).toBeTruthy();
    expect(manifest.version).toBeTruthy();
    expect(manifest.compatibility?.minimum).toBeTruthy();
    expect(manifest.compatibility?.verified).toBeTruthy();
    expect(manifest.esmodules).toContain("scripts/npc-narrator.js");
    expect(manifest.styles).toContain("styles/npc-narrator.css");
    expect(manifest.manifest).toMatch(/\/releases\/latest\/download\/module\.json$/);
    expect(manifest.download).toMatch(/\/releases\/download\/v[\d.]+\/module\.zip$/);
    expect(manifest.bugs).toMatch(/\/issues$/);
    expect(manifest.changelog).toMatch(/\/releases$/);
    expect(manifest.license).toBe("LICENSE");
    expect(fs.existsSync(path.join(REPO_ROOT, "LICENSE"))).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, "lib", "signalr.min.js"))).toBe(true);
  });
});

describe("package-module (functional)", () => {
  it("stages a Foundry-ready folder named after module id including SignalR", () => {
    const staging = makeTempDir();
    const { moduleId, moduleDir } = stagePackage(REPO_ROOT, staging);
    expect(moduleId).toBe("npc-narrator");
    expect(path.basename(moduleDir)).toBe("npc-narrator");
    expect(fs.existsSync(path.join(moduleDir, "module.json"))).toBe(true);
    expect(fs.existsSync(path.join(moduleDir, "LICENSE"))).toBe(true);
    expect(fs.existsSync(path.join(moduleDir, "scripts", "npc-narrator.js"))).toBe(true);
    expect(fs.existsSync(path.join(moduleDir, "lib", "signalr.min.js"))).toBe(true);
    expect(fs.existsSync(path.join(moduleDir, "styles", "npc-narrator.css"))).toBe(true);
    expect(fs.existsSync(path.join(moduleDir, "templates", "pairing.hbs"))).toBe(true);
    expect(fs.existsSync(path.join(moduleDir, "tests"))).toBe(false);
    expect(fs.existsSync(path.join(moduleDir, "tools"))).toBe(false);
    expect(fs.existsSync(path.join(moduleDir, "package.json"))).toBe(false);
  });

  it("builds module.zip with matching release manifest URLs", () => {
    const outDir = makeTempDir();
    const result = packageModule({
      repoRoot: REPO_ROOT,
      outDir,
      version: "0.2.9",
    });
    expect(result.moduleId).toBe("npc-narrator");
    expect(result.tag).toBe("v0.2.9");
    expect(path.basename(result.zipPath)).toBe("module.zip");
    expect(fs.existsSync(result.zipPath)).toBe(true);
    expect(fs.statSync(result.zipPath).size).toBeGreaterThan(1000);
    expect(fs.existsSync(result.manifestPath)).toBe(true);
    const released = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
    const staged = JSON.parse(
      fs.readFileSync(path.join(outDir, "npc-narrator", "module.json"), "utf8"),
    );
    expect(released).toEqual(staged);
    expect(released.download).toBe(
      "https://github.com/discgolferusa/NPC-Narrator-Foundry-Module/releases/download/v0.2.9/module.zip",
    );
    expect(released.manifest).toContain("/releases/latest/download/module.json");
  });
});

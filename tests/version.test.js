import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  bumpPatch,
  compareSemver,
  computeNextReleaseVersion,
  highestSemver,
  parseSemver,
  writeModuleVersion,
} from "../tools/version.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeTempRepo({ version = "0.2.9", tags = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npc-narrator-ver-"));
  tempDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "module.json"),
    `${JSON.stringify(
      {
        id: "npc-narrator",
        title: "NPC Narrator",
        version,
        compatibility: { minimum: "13", verified: "14" },
      },
      null,
      2,
    )}\n`,
  );
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["add", "module.json"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  for (const tag of tags) {
    execFileSync("git", ["tag", tag.startsWith("v") ? tag : `v${tag}`], {
      cwd: dir,
      stdio: "ignore",
    });
  }
  return dir;
}

describe("version helpers (unit)", () => {
  it("parses and compares semver", () => {
    expect(parseSemver("v0.2.9").raw).toBe("0.2.9");
    expect(compareSemver("0.2.10", "0.2.9")).toBeGreaterThan(0);
    expect(bumpPatch("0.2.9")).toBe("0.2.10");
    expect(highestSemver(["0.2.8", "0.2.10", "0.2.9"])).toBe("0.2.10");
  });

  it("uses module.json version when no release tags exist", () => {
    const repo = makeTempRepo({ version: "0.2.9", tags: [] });
    expect(computeNextReleaseVersion(repo)).toBe("0.2.9");
  });

  it("bumps patch from the highest release tag", () => {
    const repo = makeTempRepo({ version: "0.2.9", tags: ["v0.2.8", "v0.2.9"] });
    expect(computeNextReleaseVersion(repo)).toBe("0.2.10");
  });

  it("keeps a manual major/minor jump ahead of tags", () => {
    const repo = makeTempRepo({ version: "1.0.0", tags: ["v0.2.15"] });
    expect(computeNextReleaseVersion(repo)).toBe("1.0.0");
  });

  it("writes version and versioned download URL into module.json", () => {
    const repo = makeTempRepo({ version: "0.2.9" });
    const written = writeModuleVersion("0.2.10", repo, {
      repository: "discgolferusa/NPC-Narrator-Foundry-Module",
    });
    expect(written.version).toBe("0.2.10");
    expect(written.download).toBe(
      "https://github.com/discgolferusa/NPC-Narrator-Foundry-Module/releases/download/v0.2.10/module.zip",
    );
    const onDisk = JSON.parse(fs.readFileSync(path.join(repo, "module.json"), "utf8"));
    expect(onDisk.version).toBe("0.2.10");
  });
});

describe("repo module.json seed version", () => {
  it("has a parseable semver", () => {
    const version = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "module.json"), "utf8")).version;
    expect(parseSemver(version).raw).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

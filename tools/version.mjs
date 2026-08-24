/**
 * Semver helpers for automatic Foundry module releases.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  REPO_ROOT,
  ZIP_NAME,
  readModuleManifest,
  readModuleVersion,
  releaseTagForVersion,
} from "./package-module.mjs";

export function parseSemver(version) {
  const cleaned = String(version ?? "")
    .trim()
    .replace(/^v/i, "");
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) {
    throw new Error(`Invalid semver version: ${version}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: `${match[1]}.${match[2]}.${match[3]}`,
  };
}

export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

export function bumpPatch(version) {
  const parsed = parseSemver(version);
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

export function highestSemver(versions) {
  const normalized = versions.map((v) => parseSemver(v).raw);
  if (!normalized.length) return null;
  return normalized.sort(compareSemver).at(-1);
}

export function listVersionTags(repoRoot = REPO_ROOT) {
  try {
    const out = execFileSync("git", ["tag", "--list", "v*.*.*"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((tag) => tag.replace(/^v/i, ""));
  } catch {
    return [];
  }
}

/**
 * Next release version:
 * - No release tags yet → use module.json version (first publish)
 * - module.json is ahead of tags (manual major/minor bump) → use module.json
 * - Otherwise → patch+1 from the highest release tag
 */
export function computeNextReleaseVersion(repoRoot = REPO_ROOT) {
  const current = parseSemver(readModuleVersion(repoRoot)).raw;
  const highestTag = highestSemver(listVersionTags(repoRoot));
  if (!highestTag) return current;
  if (compareSemver(current, highestTag) > 0) return current;
  return bumpPatch(highestTag);
}

export function writeModuleVersion(
  version,
  repoRoot = REPO_ROOT,
  { repository = "discgolferusa/NPC-Narrator-Foundry-Module" } = {},
) {
  const parsed = parseSemver(version);
  const manifestPath = path.join(repoRoot, "module.json");
  const manifest = readModuleManifest(repoRoot);
  const tag = releaseTagForVersion(parsed.raw);
  manifest.version = parsed.raw;
  manifest.manifest = `https://github.com/${repository}/releases/latest/download/module.json`;
  manifest.download = `https://github.com/${repository}/releases/download/${tag}/${ZIP_NAME}`;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const repository = process.env.GITHUB_REPOSITORY || "discgolferusa/NPC-Narrator-Foundry-Module";
  const next = args.find((a) => !a.startsWith("-")) || computeNextReleaseVersion();
  if (args.includes("--write")) {
    writeModuleVersion(next, REPO_ROOT, { repository });
  }
  process.stdout.write(`${parseSemver(next).raw}\n`);
}

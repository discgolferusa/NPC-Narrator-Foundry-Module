/**
 * Stages and zips the Foundry module for Data/modules/ install.
 * Output: dist/module.zip with top-level folder matching module.json id.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

/** Files and directories included in the installable package (relative to repo root). */
export const PACKAGE_ROOT_FILES = ["module.json", "README.md", "LICENSE", "CHANGELOG.md"];
export const PACKAGE_DIRS = ["scripts", "styles", "templates", "lib"];
export const ZIP_NAME = "module.zip";

export function readModuleManifest(repoRoot = REPO_ROOT) {
  const manifestPath = path.join(repoRoot, "module.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest.id || typeof manifest.id !== "string") {
    throw new Error("module.json is missing a string id");
  }
  if (!manifest.version || typeof manifest.version !== "string") {
    throw new Error("module.json is missing a string version");
  }
  return manifest;
}

export function readModuleId(repoRoot = REPO_ROOT) {
  return readModuleManifest(repoRoot).id;
}

export function readModuleVersion(repoRoot = REPO_ROOT) {
  return readModuleManifest(repoRoot).version;
}

export function releaseTagForVersion(version) {
  return version.startsWith("v") ? version : `v${version}`;
}

export function listPackageRelativePaths(repoRoot = REPO_ROOT) {
  const paths = [...PACKAGE_ROOT_FILES];
  for (const dir of PACKAGE_DIRS) {
    const abs = path.join(repoRoot, dir);
    if (!fs.existsSync(abs)) {
      throw new Error(`Missing package directory: ${dir}`);
    }
    collectFiles(abs, dir, paths);
  }
  return paths.sort();
}

function collectFiles(absDir, relDir, out) {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const rel = path.posix.join(relDir.replaceAll("\\", "/"), entry.name);
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(abs, rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

/**
 * Copy package files into stagingRoot/<moduleId>/ and return that folder path.
 */
export function stagePackage(repoRoot = REPO_ROOT, stagingRoot = path.join(REPO_ROOT, "dist")) {
  const moduleId = readModuleId(repoRoot);
  const moduleDir = path.join(stagingRoot, moduleId);

  fs.rmSync(moduleDir, { recursive: true, force: true });
  fs.mkdirSync(moduleDir, { recursive: true });

  for (const file of PACKAGE_ROOT_FILES) {
    const src = path.join(repoRoot, file);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing package file: ${file}`);
    }
    fs.copyFileSync(src, path.join(moduleDir, file));
  }

  for (const dir of PACKAGE_DIRS) {
    copyDir(path.join(repoRoot, dir), path.join(moduleDir, dir));
  }

  return { moduleId, moduleDir, stagingRoot };
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

/**
 * Write a release copy of module.json with Foundry-compatible URLs:
 * - manifest: stable /releases/latest/download/module.json (update checks)
 * - download: version-specific zip for this release
 */
export function writeReleaseManifest(
  repoRoot = REPO_ROOT,
  outPath,
  {
    repository = "discgolferusa/NPC-Narrator-Foundry-Module",
    version = readModuleVersion(repoRoot),
    zipName = ZIP_NAME,
  } = {},
) {
  const manifest = readModuleManifest(repoRoot);
  const tag = releaseTagForVersion(version);
  const latestBase = `https://github.com/${repository}/releases/latest/download`;
  const versionBase = `https://github.com/${repository}/releases/download/${tag}`;
  manifest.version = version;
  manifest.manifest = `${latestBase}/module.json`;
  manifest.download = `${versionBase}/${zipName}`;
  manifest.bugs = manifest.bugs || `https://github.com/${repository}/issues`;
  manifest.changelog = manifest.changelog || `https://github.com/${repository}/releases`;
  manifest.license = "LICENSE";
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export function createZipFromStaging(moduleId, stagingRoot, zipPath) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
  }

  const zipName = path.basename(zipPath);
  const absZip = path.resolve(zipPath);

  try {
    execFileSync("zip", ["-r", absZip, moduleId], {
      cwd: stagingRoot,
      stdio: "inherit",
    });
  } catch {
    // Windows / environments without Info-ZIP: PowerShell Compress-Archive
    const ps = [
      `$ErrorActionPreference = 'Stop'`,
      `Compress-Archive -Path (Join-Path '${stagingRoot.replace(/'/g, "''")}' '${moduleId}') -DestinationPath '${absZip.replace(/'/g, "''")}' -Force`,
    ].join("; ");
    execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], {
      stdio: "inherit",
    });
  }

  if (!fs.existsSync(absZip)) {
    throw new Error(`Zip was not created: ${zipName}`);
  }
  return absZip;
}

/**
 * After staging, overwrite the staged module.json with release URLs so the zip
 * and the standalone release manifest stay identical (Foundry best practice).
 */
export function packageModule({
  repoRoot = REPO_ROOT,
  outDir = path.join(REPO_ROOT, "dist"),
  repository = process.env.GITHUB_REPOSITORY || "discgolferusa/NPC-Narrator-Foundry-Module",
  version = process.env.MODULE_VERSION || readModuleVersion(repoRoot),
} = {}) {
  const { moduleId, moduleDir, stagingRoot } = stagePackage(repoRoot, outDir);
  const releaseManifest = writeReleaseManifest(repoRoot, path.join(moduleDir, "module.json"), {
    repository,
    version,
    zipName: ZIP_NAME,
  });
  const zipPath = path.join(outDir, ZIP_NAME);
  createZipFromStaging(moduleId, stagingRoot, zipPath);
  const manifestPath = path.join(outDir, "module.json");
  fs.copyFileSync(path.join(moduleDir, "module.json"), manifestPath);
  return {
    moduleId,
    version: releaseManifest.version,
    tag: releaseTagForVersion(releaseManifest.version),
    zipPath,
    manifestPath,
    stagingRoot,
    download: releaseManifest.download,
    manifest: releaseManifest.manifest,
  };
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const result = packageModule();
  console.log(`Packaged ${result.moduleId}@${result.version} -> ${result.zipPath}`);
  console.log(`Release tag: ${result.tag}`);
  console.log(`Release manifest -> ${result.manifestPath}`);
  console.log(`download: ${result.download}`);
}

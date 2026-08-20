import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch as osArch, tmpdir } from "node:os";
import { join, basename } from "node:path";

export const DEFAULT_BASE_URL = "https://soloist-builds.spotifycdn.com";
export const DEFAULT_CACHE_DIR = "./.soloist-cache";
export const MAX_AGE_DAYS = 60; // vendor builds hard-expire at 90 days; re-download well before then

const ARCH_MAP: Record<string, string> = {
  x64: "x86_64",
  arm64: "arm64",
  arm: "arm32",
};

export const TARBALLS: Record<string, string> = {
  x86_64: "soloist_release_x86_64.tar.gz",
  arm64: "soloist_release_arm64.tar.gz",
  arm32: "soloist_release_arm32.tar.gz",
};

export class AcquisitionError extends Error {}

export function detectArch(machine: string = osArch()): string {
  const arch = ARCH_MAP[machine];
  if (!arch) throw new AcquisitionError(`unsupported architecture: ${machine}`);
  return arch;
}

export function tarballUrl(arch: string, baseUrl?: string): string {
  const base = baseUrl || process.env.SOLOIST_DOWNLOAD_BASE || DEFAULT_BASE_URL;
  return `${base.replace(/\/+$/, "")}/${TARBALLS[arch]}`;
}

function defaultCacheDir(): string {
  return process.env.SOLOIST_CACHE_DIR || DEFAULT_CACHE_DIR;
}

export function binaryIsFresh(path: string, maxAgeDays = MAX_AGE_DAYS): boolean {
  try {
    const st = statSync(path);
    if (!st.isFile()) return false;
    const ageDays = (Date.now() - st.mtimeMs) / 86_400_000;
    return ageDays <= maxAgeDays;
  } catch {
    return false;
  }
}

export function validateBinary(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
  } catch {
    return false;
  }
  const r = spawnSync(path, ["--version"], { timeout: 15_000 });
  return r.status === 0;
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new AcquisitionError(`download ${url} failed: HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function downloadAndExtract(arch: string, cache: string): Promise<string> {
  const url = tarballUrl(arch);
  const binary = join(cache, "soloist");
  const work = mkdtempSync(join(tmpdir(), "soloist-"));
  const tarball = join(work, "soloist.tar.gz");
  try {
    await download(url, tarball);
    const r = spawnSync("tar", ["-xzf", tarball, "-C", work], { timeout: 60_000 });
    if (r.status !== 0) {
      throw new AcquisitionError(`failed to extract ${url}: ${r.stderr?.toString() ?? "tar error"}`);
    }
    const found = findFile(work, "soloist");
    if (!found) throw new AcquisitionError(`no 'soloist' binary in tarball from ${url}`);
    copyFileSync(found, binary);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  chmodSync(binary, 0o755);
  return binary;
}

function findFile(dir: string, name: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry.isFile() && basename(entry.name) === name) {
      return full;
    }
  }
  return null;
}

export interface AcquireOptions {
  force?: boolean;
}

export async function acquireSoloist(cacheDir?: string, opts: AcquireOptions = {}): Promise<string> {
  const { force = false } = opts;
  const cache = cacheDir || defaultCacheDir();
  let binary = join(cache, "soloist");

  if (!force && binaryIsFresh(binary) && validateBinary(binary)) {
    return binary;
  }

  mkdirSync(cache, { recursive: true });
  binary = await downloadAndExtract(detectArch(), cache);
  if (!validateBinary(binary)) {
    throw new AcquisitionError(`downloaded binary failed 'soloist --version' at ${binary}`);
  }
  return binary;
}

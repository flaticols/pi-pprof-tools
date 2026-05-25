import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ProfileKind } from "./types";
import { PROFILE_KINDS } from "./types";

export function profileFileName(kind: ProfileKind): string {
  return `${kind}.out`;
}

export function matchesKind(file: string, kind: ProfileKind): boolean {
  if (!/(\.out|\.pb\.gz|\.prof|\.pprof)$/i.test(file)) return false;
  if (kind === "cpu") return /^cpu/i.test(file) || /profile/i.test(file);
  if (kind === "goroutine") return /^goroutine/i.test(file) || /^goroutines/i.test(file);
  return file.toLowerCase().startsWith(kind.toLowerCase());
}

export async function discoverProfiles(dir: string): Promise<{
  available: Partial<Record<ProfileKind, string[]>>;
  selected: Partial<Record<ProfileKind, string>>;
}> {
  const entries = await readdir(dir).catch(() => []);
  const available: Partial<Record<ProfileKind, string[]>> = {};
  const selected: Partial<Record<ProfileKind, string>> = {};

  for (const kind of PROFILE_KINDS) {
    const files = entries.filter((file) => matchesKind(file, kind)).map((file) => path.join(dir, file)).sort();
    if (files.length === 0) continue;

    available[kind] = files;
    const exact = files.find((file) => path.basename(file) === profileFileName(kind));
    if (exact) {
      selected[kind] = exact;
      continue;
    }

    const withMtime = await Promise.all(files.map(async (file) => ({ file, mtime: (await stat(file)).mtimeMs })));
    selected[kind] = withMtime.sort((a, b) => b.mtime - a.mtime)[0].file;
  }

  return { available, selected };
}

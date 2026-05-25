import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { discoverProfiles, profileFileName } from "./files";
import { categoryId, parseTop, sampleIndices } from "./parser";
import { DEFAULT_BASE_URL, PROFILE_KINDS, RESULT_ROOT } from "./types";
import type { CaptureKind, ProfileKind, RunSummary, TopCategory } from "./types";

function slug(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

function nowDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function endpoint(kind: ProfileKind, seconds: number): string {
  if (kind === "cpu") return `/debug/pprof/profile?seconds=${seconds}`;
  return `/debug/pprof/${kind}`;
}

async function fetchProfile(baseUrl: string, kind: ProfileKind, seconds: number, signal?: AbortSignal): Promise<Buffer> {
  const res = await fetch(`${baseUrl}${endpoint(kind, seconds)}`, { signal });
  if (!res.ok) throw new Error(`GET ${endpoint(kind, seconds)} failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function runTop(
  pi: ExtensionAPI,
  kind: ProfileKind,
  file: string,
  topN: number,
  signal?: AbortSignal,
  sampleIndex?: string,
): Promise<TopCategory> {
  const args = ["tool", "pprof", "-top", `-nodecount=${topN}`];
  if (sampleIndex) args.push(`-sample_index=${sampleIndex}`);
  args.push(file);

  const result = await pi.exec("go", args, { signal, timeout: 60_000 });
  const rawTop = `${result.stdout || ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
  const parsed = parseTop(rawTop, topN);

  return {
    id: categoryId(kind, sampleIndex),
    kind,
    sampleIndex,
    file,
    type: parsed.type,
    total: parsed.total,
    rows: parsed.rows,
    rawTop,
  };
}

async function topCategories(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  selected: Partial<Record<ProfileKind, string>>,
  topN: number,
): Promise<TopCategory[]> {
  const categories: TopCategory[] = [];

  for (const kind of PROFILE_KINDS) {
    const file = selected[kind];
    if (!file) continue;

    for (const sampleIndex of sampleIndices(kind)) {
      try {
        const cat = await runTop(pi, kind, file, topN, ctx.signal, sampleIndex);
        if (cat.rows.length === 0 && /unrecognized|invalid|sample_index/i.test(cat.rawTop ?? "")) continue;

        cat.topFile = path.join(
          path.dirname(file),
          `${path.basename(file).replace(/\.(out|pb\.gz|prof|pprof)$/i, "")}.${cat.id.replace(":", "_")}.top.txt`,
        );
        await writeFile(cat.topFile, (cat.rawTop ?? "") + "\n");
        categories.push(cat);
      } catch {
        // Some profiles are absent/empty or do not support every sample index; keep analysis best-effort.
      }
    }
  }

  return categories;
}

export async function captureProfiles(pi: ExtensionAPI, ctx: ExtensionContext, params: any): Promise<RunSummary> {
  const kind = (params.kind ?? "all") as CaptureKind;
  const kinds: ProfileKind[] = kind === "all" ? [...PROFILE_KINDS] : [kind as ProfileKind];
  const seconds = Number(params.seconds ?? 15);
  const topN = Number(params.topN ?? 10);
  const baseUrl = params.baseUrl ?? DEFAULT_BASE_URL;
  const name = slug(params.name ?? `${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const dir = path.join(ctx.cwd, RESULT_ROOT, `pprof-${nowDate()}-${name}`);
  await mkdir(dir, { recursive: true });

  const selectedFiles: Partial<Record<ProfileKind, string>> = {};
  const availableFiles: Partial<Record<ProfileKind, string[]>> = {};

  for (const profileKind of kinds) {
    try {
      const file = path.join(dir, profileFileName(profileKind));
      await writeFile(file, await fetchProfile(baseUrl, profileKind, seconds, ctx.signal));
      selectedFiles[profileKind] = file;
      availableFiles[profileKind] = [file];
    } catch {
      // mutex/block/threadcreate may be unavailable depending on runtime settings; skip but keep CPU/heap/etc.
    }
  }

  const categories = await topCategories(pi, ctx, selectedFiles, topN);
  const summary: RunSummary = { dir, capturedAt: new Date().toISOString(), baseUrl, selectedFiles, availableFiles, categories };

  await writeFile(
    path.join(dir, "metadata.json"),
    JSON.stringify(
      { ...summary, categories: summary.categories.map((category) => ({ ...category, rawTop: undefined, rows: category.rows.slice(0, topN) })) },
      null,
      2,
    ) + "\n",
  );

  return summary;
}

export async function analyzeDir(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  dirInput: string,
  topN: number,
  allFiles = false,
): Promise<RunSummary> {
  const dir = path.isAbsolute(dirInput) ? dirInput : path.join(ctx.cwd, dirInput);
  if (!existsSync(dir)) throw new Error(`Directory not found: ${dir}`);

  const discovered = await discoverProfiles(dir);
  let categories: TopCategory[] = [];

  if (allFiles) {
    for (const kind of PROFILE_KINDS) {
      for (const file of discovered.available[kind] ?? []) {
        categories.push(...(await topCategories(pi, ctx, { [kind]: file }, topN)));
      }
    }
  } else {
    categories = await topCategories(pi, ctx, discovered.selected, topN);
  }

  return {
    dir,
    capturedAt: new Date().toISOString(),
    baseUrl: "local-files",
    selectedFiles: discovered.selected,
    availableFiles: discovered.available,
    categories,
  };
}

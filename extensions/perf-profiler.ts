import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const DEFAULT_BASE_URL = "http://localhost:6060";
const RESULT_ROOT = "pprof-data";

const PROFILE_KINDS = ["cpu", "heap", "allocs", "goroutine", "mutex", "block", "threadcreate"] as const;
type ProfileKind = (typeof PROFILE_KINDS)[number];
type CaptureKind = ProfileKind | "all";

type TopRow = { flat: string; flatPct: number; sumPct: number; cum: string; cumPct: number; name: string };
type TopCategory = {
  id: string;
  kind: ProfileKind;
  sampleIndex?: string;
  file: string;
  topFile?: string;
  type?: string;
  total?: string;
  rows: TopRow[];
  rawTop?: string;
};
type RunSummary = {
  dir: string;
  capturedAt: string;
  baseUrl: string;
  selectedFiles: Partial<Record<ProfileKind, string>>;
  availableFiles: Partial<Record<ProfileKind, string[]>>;
  categories: TopCategory[];
};

const KindType = Type.Union([Type.Literal("all"), ...PROFILE_KINDS.map((k) => Type.Literal(k))] as any);
const CaptureParams = Type.Object({
  kind: Type.Optional(KindType),
  name: Type.Optional(Type.String({ description: "Run name suffix used in pprof-data/pprof-<date>-<name>." })),
  seconds: Type.Optional(Type.Number({ description: "CPU profile duration in seconds.", default: 15 })),
  topN: Type.Optional(Type.Number({ description: "Rows per top table/category.", default: 10 })),
  baseUrl: Type.Optional(Type.String({ description: "pprof base URL.", default: DEFAULT_BASE_URL })),
});
const AnalyzeParams = Type.Object({
  dir: Type.String({ description: "Directory containing pprof files, e.g. pprof-data/pprof-..." }),
  topN: Type.Optional(Type.Number({ description: "Rows per top table/category.", default: 10 })),
  allFiles: Type.Optional(
    Type.Boolean({ description: "Analyze every matching pprof file instead of selected/latest per kind.", default: false }),
  ),
});
const CompareParams = Type.Object({
  baselineDir: Type.String({ description: "Baseline profile directory." }),
  candidateDir: Type.String({ description: "Candidate profile directory." }),
  category: Type.Optional(Type.String({ description: "Category id to compare, e.g. allocs:alloc_space, heap:inuse_space, cpu." })),
  topN: Type.Optional(Type.Number({ description: "Rows to show.", default: 15 })),
});

function slug(input: string): string {
  return (
    input
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "run"
  );
}
function nowDate(): string {
  return new Date().toISOString().slice(0, 10);
}
function pct(input: string): number {
  return Number(input.replace("%", "")) || 0;
}
function rel(ctx: ExtensionContext, p: string): string {
  return path.relative(ctx.cwd, p) || ".";
}

function parseTop(text: string, topN: number): { rows: TopRow[]; type?: string; total?: string } {
  const rows: TopRow[] = [];
  const type = text.match(/^Type:\s*(.+)$/m)?.[1]?.trim();
  const total = text.match(/of\s+(.+?)\s+total/m)?.[1]?.trim();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\S+)\s+([\d.]+%)\s+([\d.]+%)\s+(\S+)\s+([\d.]+%)\s+(.+?)\s*$/);
    if (!m) continue;
    rows.push({ flat: m[1], flatPct: pct(m[2]), sumPct: pct(m[3]), cum: m[4], cumPct: pct(m[5]), name: m[6] });
    if (rows.length >= topN) break;
  }
  return { rows, type, total };
}

function endpoint(kind: ProfileKind, seconds: number): string {
  if (kind === "cpu") return `/debug/pprof/profile?seconds=${seconds}`;
  return `/debug/pprof/${kind}`;
}
function fileName(kind: ProfileKind): string {
  return `${kind}.out`;
}
function matchesKind(file: string, kind: ProfileKind): boolean {
  if (!/(\.out|\.pb\.gz|\.prof|\.pprof)$/i.test(file)) return false;
  if (kind === "cpu") return /^cpu/i.test(file) || /profile/i.test(file);
  if (kind === "goroutine") return /^goroutine/i.test(file) || /^goroutines/i.test(file);
  return file.toLowerCase().startsWith(kind.toLowerCase());
}
function sampleIndices(kind: ProfileKind): (string | undefined)[] {
  switch (kind) {
    case "heap":
      return ["inuse_space", "inuse_objects", "alloc_space", "alloc_objects"];
    case "allocs":
      return ["alloc_space", "alloc_objects"];
    case "mutex":
      return ["delay", "contentions"];
    case "block":
      return ["delay", "contentions"];
    default:
      return [undefined];
  }
}
function categoryId(kind: ProfileKind, sampleIndex?: string): string {
  return sampleIndex ? `${kind}:${sampleIndex}` : kind;
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
  return { id: categoryId(kind, sampleIndex), kind, sampleIndex, file, type: parsed.type, total: parsed.total, rows: parsed.rows, rawTop };
}

async function fetchProfile(baseUrl: string, kind: ProfileKind, seconds: number, signal?: AbortSignal): Promise<Buffer> {
  const res = await fetch(`${baseUrl}${endpoint(kind, seconds)}`, { signal });
  if (!res.ok) throw new Error(`GET ${endpoint(kind, seconds)} failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function discover(
  dir: string,
): Promise<{ available: Partial<Record<ProfileKind, string[]>>; selected: Partial<Record<ProfileKind, string>> }> {
  const entries = await readdir(dir).catch(() => []);
  const available: Partial<Record<ProfileKind, string[]>> = {};
  const selected: Partial<Record<ProfileKind, string>> = {};
  for (const kind of PROFILE_KINDS) {
    const files = entries.filter((f) => matchesKind(f, kind)).map((f) => path.join(dir, f));
    files.sort();
    if (files.length) {
      available[kind] = files;
      const exact = files.find((f) => path.basename(f) === fileName(kind));
      if (exact) selected[kind] = exact;
      else {
        const withMtime = await Promise.all(files.map(async (f) => ({ f, m: (await stat(f)).mtimeMs })));
        selected[kind] = withMtime.sort((a, b) => b.m - a.m)[0].f;
      }
    }
  }
  return { available, selected };
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
      } catch (err) {
        // Some profiles are absent/empty or do not support every sample index; keep analysis best-effort.
      }
    }
  }
  return categories;
}

async function captureProfiles(pi: ExtensionAPI, ctx: ExtensionContext, params: any): Promise<RunSummary> {
  const kind = (params.kind ?? "all") as CaptureKind;
  const kinds: ProfileKind[] = kind === "all" ? [...PROFILE_KINDS] : [kind as ProfileKind];
  const seconds = Number(params.seconds ?? 15);
  const topN = Number(params.topN ?? 10);
  const baseUrl = params.baseUrl ?? DEFAULT_BASE_URL;
  const name = slug(params.name ?? `${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const dir = path.join(ctx.cwd, RESULT_ROOT, `pprof-${nowDate()}-${name}`);
  await mkdir(dir, { recursive: true });

  const selected: Partial<Record<ProfileKind, string>> = {};
  const available: Partial<Record<ProfileKind, string[]>> = {};
  for (const k of kinds) {
    try {
      const file = path.join(dir, fileName(k));
      await writeFile(file, await fetchProfile(baseUrl, k, seconds, ctx.signal));
      selected[k] = file;
      available[k] = [file];
    } catch (e) {
      // mutex/block/threadcreate may be unavailable depending on runtime settings; skip but keep CPU/heap/etc.
    }
  }
  const categories = await topCategories(pi, ctx, selected, topN);
  const summary: RunSummary = {
    dir,
    capturedAt: new Date().toISOString(),
    baseUrl,
    selectedFiles: selected,
    availableFiles: available,
    categories,
  };
  await writeFile(
    path.join(dir, "metadata.json"),
    JSON.stringify(
      { ...summary, categories: summary.categories.map((c) => ({ ...c, rawTop: undefined, rows: c.rows.slice(0, topN) })) },
      null,
      2,
    ) + "\n",
  );
  return summary;
}

async function analyzeDir(pi: ExtensionAPI, ctx: ExtensionContext, dirInput: string, topN: number, allFiles = false): Promise<RunSummary> {
  const dir = path.isAbsolute(dirInput) ? dirInput : path.join(ctx.cwd, dirInput);
  if (!existsSync(dir)) throw new Error(`Directory not found: ${dir}`);
  const d = await discover(dir);
  let categories: TopCategory[] = [];
  if (allFiles) {
    for (const kind of PROFILE_KINDS) {
      for (const file of d.available[kind] ?? []) categories.push(...(await topCategories(pi, ctx, { [kind]: file }, topN)));
    }
  } else {
    categories = await topCategories(pi, ctx, d.selected, topN);
  }
  return {
    dir,
    capturedAt: new Date().toISOString(),
    baseUrl: "local-files",
    selectedFiles: d.selected,
    availableFiles: d.available,
    categories,
  };
}

function markdownForSummary(ctx: ExtensionContext, s: RunSummary, topN: number): string {
  const out: string[] = [`pprof summary: \`${rel(ctx, s.dir)}\``, ""];
  out.push("Selected files:", "", "| Kind | File | Available files |", "|---|---|---:|");
  for (const k of PROFILE_KINDS)
    if (s.selectedFiles[k] || s.availableFiles[k]?.length)
      out.push(`| ${k} | \`${s.selectedFiles[k] ? rel(ctx, s.selectedFiles[k]!) : "-"}\` | ${s.availableFiles[k]?.length ?? 0} |`);
  out.push("");
  for (const c of s.categories) {
    out.push(
      `### ${c.id} top ${Math.min(topN, c.rows.length)}${c.total ? ` (${c.total} total)` : ""}`,
      "",
      "| # | Flat | Flat % | Cum | Cum % | Function |",
      "|---:|---:|---:|---:|---:|---|",
    );
    c.rows
      .slice(0, topN)
      .forEach((r, i) =>
        out.push(`| ${i + 1} | ${r.flat} | ${r.flatPct.toFixed(2)}% | ${r.cum} | ${r.cumPct.toFixed(2)}% | \`${r.name}\` |`),
      );
    out.push("");
  }
  return out.join("\n");
}
function widgetLines(s: RunSummary, topN: number): string[] {
  const lines = [`pprof: ${path.basename(s.dir)}`];
  for (const c of s.categories.slice(0, 8)) {
    lines.push(`${c.id.toUpperCase()}${c.total ? ` (${c.total})` : ""}`);
    for (const r of c.rows.slice(0, topN)) lines.push(`  ${r.cumPct.toFixed(1).padStart(5)}% cum  ${r.name.slice(0, 72)}`);
  }
  return lines.slice(0, 60);
}
function setWidget(ctx: ExtensionContext, s: RunSummary, topN: number) {
  ctx.ui.setWidget("pprof-top", widgetLines(s, topN));
}
function clearWidget(ctx: ExtensionContext) {
  ctx.ui.setWidget("pprof-top", undefined);
}

async function loadCategory(ctx: ExtensionContext, dirInput: string, category: string, topN: number): Promise<TopRow[]> {
  const dir = path.isAbsolute(dirInput) ? dirInput : path.join(ctx.cwd, dirInput);
  const files = (await readdir(dir)).filter((f) => f.includes(category.replace(":", "_")) && f.endsWith(".top.txt"));
  if (files.length === 0) return [];
  return parseTop(await readFile(path.join(dir, files.sort()[files.length - 1]), "utf8"), topN * 3).rows;
}
function compareRows(base: TopRow[], cand: TopRow[], topN: number): string {
  const byName = new Map<string, { base?: TopRow; cand?: TopRow }>();
  for (const r of base) byName.set(r.name, { ...(byName.get(r.name) ?? {}), base: r });
  for (const r of cand) byName.set(r.name, { ...(byName.get(r.name) ?? {}), cand: r });
  const rows = [...byName.entries()]
    .map(([name, v]) => ({
      name,
      base: v.base?.cumPct ?? 0,
      cand: v.cand?.cumPct ?? 0,
      delta: (v.cand?.cumPct ?? 0) - (v.base?.cumPct ?? 0),
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, topN);
  return [
    "| Function | Baseline cum % | Candidate cum % | Delta |",
    "|---|---:|---:|---:|",
    ...rows.map(
      (r) => `| \`${r.name}\` | ${r.base.toFixed(2)}% | ${r.cand.toFixed(2)}% | ${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(2)}pp |`,
    ),
  ].join("\n");
}

export default function perfProfilerExtension(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => ctx.ui.setStatus("pprof", "pprof: ready"));

  pi.registerTool({
    name: "pprof_capture",
    label: "Capture pprof",
    description:
      "Capture all/selected Go pprof profiles, run go tool pprof for every useful sample index, save top files, and show a top-N widget.",
    promptSnippet: "Capture and summarize Go pprof profiles from the local perf-test pod port-forward.",
    promptGuidelines: [
      "Use pprof_capture when the user asks to collect pprof data from the perf-test run; it returns structured tables so the LLM should not parse raw profile bytes.",
    ],
    parameters: CaptureParams,
    async execute(_id, params, _signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "Capturing pprof profiles and generating top tables..." }] });
      const topN = Number(params.topN ?? 10);
      const s = await captureProfiles(pi, ctx, params);
      setWidget(ctx, s, Math.min(5, topN));
      return { content: [{ type: "text", text: markdownForSummary(ctx, s, topN) }], details: s };
    },
  });

  pi.registerTool({
    name: "pprof_analyze",
    label: "Analyze pprof directory",
    description:
      "Discover pprof files in a pprof-data directory, select latest/canonical files, run top for all supported sample indices, and return structured tables.",
    promptSnippet: "Analyze saved Go pprof .out/.pb.gz files and produce top-N tables for all sample indices.",
    promptGuidelines: [
      "Use pprof_analyze for existing pprof-data/pprof-* directories; do not ask the LLM to parse pprof files manually.",
    ],
    parameters: AnalyzeParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const topN = Number(params.topN ?? 10);
      const s = await analyzeDir(pi, ctx, params.dir, topN, Boolean(params.allFiles));
      setWidget(ctx, s, Math.min(5, topN));
      return { content: [{ type: "text", text: markdownForSummary(ctx, s, topN) }], details: s };
    },
  });

  pi.registerTool({
    name: "pprof_compare",
    label: "Compare pprof directories",
    description: "Compare generated top tables between two directories by cumulative percentage delta.",
    promptSnippet: "Compare two saved pprof runs and show cumulative percentage deltas.",
    promptGuidelines: ["Use pprof_compare after pprof_analyze/capture generated *.top.txt files; default category is allocs:alloc_space."],
    parameters: CompareParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const topN = Number(params.topN ?? 15);
      const category = params.category ?? "allocs:alloc_space";
      const base = await loadCategory(ctx, params.baselineDir, category, topN);
      const cand = await loadCategory(ctx, params.candidateDir, category, topN);
      if (!base.length || !cand.length) throw new Error(`Missing top files for ${category}. Run pprof_analyze on both directories first.`);
      return {
        content: [{ type: "text", text: `### ${category} comparison\n\n${compareRows(base, cand, topN)}` }],
        details: { category, baselineDir: params.baselineDir, candidateDir: params.candidateDir },
      };
    },
  });

  pi.registerCommand("pprof-capture", {
    description: "Capture all pprof profiles: /pprof-capture [name]",
    handler: async (args, ctx) => {
      const s = await captureProfiles(pi, ctx, { kind: "all", name: args.trim() || undefined, seconds: 15, topN: 10 });
      setWidget(ctx, s, 5);
      pi.sendMessage({ customType: "pprof-summary", content: markdownForSummary(ctx, s, 10), display: true, details: s });
    },
  });
  pi.registerCommand("pprof-analyze", {
    description: "Analyze pprof directory, or clear widget: /pprof-analyze <dir>|off",
    handler: async (args, ctx) => {
      const value = args.trim();
      if (["off", "clear", "hide"].includes(value.toLowerCase())) {
        clearWidget(ctx);
        ctx.ui.notify("pprof widget hidden", "info");
        return;
      }
      if (!value) return ctx.ui.notify("Usage: /pprof-analyze <dir> or /pprof-analyze off", "warning");
      const s = await analyzeDir(pi, ctx, value, 10);
      setWidget(ctx, s, 5);
      pi.sendMessage({ customType: "pprof-summary", content: markdownForSummary(ctx, s, 10), display: true, details: s });
    },
  });
  pi.registerCommand("pprof-widget", {
    description: "Control pprof widget: /pprof-widget off",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (!value || ["off", "clear", "hide"].includes(value)) {
        clearWidget(ctx);
        ctx.ui.notify("pprof widget hidden", "info");
        return;
      }
      ctx.ui.notify("Usage: /pprof-widget off", "warning");
    },
  });
}

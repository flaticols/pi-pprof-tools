import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseTop } from "./parser";
import type { TopRow } from "./types";

export async function loadCategory(ctx: ExtensionContext, dirInput: string, category: string, topN: number): Promise<TopRow[]> {
  const dir = path.isAbsolute(dirInput) ? dirInput : path.join(ctx.cwd, dirInput);
  const files = (await readdir(dir)).filter((file) => file.includes(category.replace(":", "_")) && file.endsWith(".top.txt"));
  if (files.length === 0) return [];
  return parseTop(await readFile(path.join(dir, files.sort()[files.length - 1]), "utf8"), topN * 3).rows;
}

export function compareRows(base: TopRow[], candidate: TopRow[], topN: number): string {
  const byName = new Map<string, { base?: TopRow; candidate?: TopRow }>();
  for (const row of base) byName.set(row.name, { ...(byName.get(row.name) ?? {}), base: row });
  for (const row of candidate) byName.set(row.name, { ...(byName.get(row.name) ?? {}), candidate: row });

  const rows = [...byName.entries()]
    .map(([name, value]) => ({
      name,
      base: value.base?.cumPct ?? 0,
      candidate: value.candidate?.cumPct ?? 0,
      delta: (value.candidate?.cumPct ?? 0) - (value.base?.cumPct ?? 0),
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, topN);

  return [
    "| Function | Baseline cum % | Candidate cum % | Delta |",
    "|---|---:|---:|---:|",
    ...rows.map(
      (row) =>
        `| \`${row.name}\` | ${row.base.toFixed(2)}% | ${row.candidate.toFixed(2)}% | ${row.delta >= 0 ? "+" : ""}${row.delta.toFixed(2)}pp |`,
    ),
  ].join("\n");
}

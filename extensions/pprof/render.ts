import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { PROFILE_KINDS } from "./types";
import type { RunSummary } from "./types";

function rel(ctx: ExtensionContext, file: string): string {
  return path.relative(ctx.cwd, file) || ".";
}

export function markdownForSummary(ctx: ExtensionContext, summary: RunSummary, topN: number): string {
  const out: string[] = [`pprof summary: \`${rel(ctx, summary.dir)}\``, ""];
  out.push("Selected files:", "", "| Kind | File | Available files |", "|---|---|---:|");

  for (const kind of PROFILE_KINDS) {
    if (!summary.selectedFiles[kind] && !summary.availableFiles[kind]?.length) continue;
    out.push(
      `| ${kind} | \`${summary.selectedFiles[kind] ? rel(ctx, summary.selectedFiles[kind]!) : "-"}\` | ${summary.availableFiles[kind]?.length ?? 0} |`,
    );
  }

  out.push("");
  for (const category of summary.categories) {
    out.push(
      `### ${category.id} top ${Math.min(topN, category.rows.length)}${category.total ? ` (${category.total} total)` : ""}`,
      "",
      "| # | Flat | Flat % | Cum | Cum % | Function |",
      "|---:|---:|---:|---:|---:|---|",
    );
    category.rows.slice(0, topN).forEach((row, index) => {
      out.push(`| ${index + 1} | ${row.flat} | ${row.flatPct.toFixed(2)}% | ${row.cum} | ${row.cumPct.toFixed(2)}% | \`${row.name}\` |`);
    });
    out.push("");
  }

  return out.join("\n");
}

export function clearWidget(ctx: ExtensionContext) {
  ctx.ui.setWidget("pprof-top", undefined);
}

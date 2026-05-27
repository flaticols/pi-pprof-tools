import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AnalyzeParams, CaptureParams, CompareParams } from "./pprof/schemas";
import { compareRows, loadCategory } from "./pprof/compare";
import { analyzeDir, captureProfiles } from "./pprof/pprof";
import { clearWidget, markdownForSummary } from "./pprof/render";
import type { RunSummary } from "./pprof/types";

export default function perfProfilerExtension(pi: ExtensionAPI) {
  let latestPprofContext: string | undefined;

  function clearLegacyUi(ctx: ExtensionContext): void {
    clearWidget(ctx);
    ctx.ui.setWidget("perf-metrics", undefined);
    ctx.ui.setStatus("pprof", undefined);
  }

  pi.on("session_start", (_event, ctx) => clearLegacyUi(ctx));

  function remember(ctx: ExtensionContext, summary: RunSummary, topN: number): string {
    const markdown = markdownForSummary(ctx, summary, topN);
    latestPprofContext = `Latest pprof tables for the current session:\n\n${markdown}`;
    return markdown;
  }

  pi.on("before_agent_start", async () => {
    if (!latestPprofContext) return;
    return {
      message: {
        customType: "pprof-summary",
        display: false,
        content: latestPprofContext,
      },
    };
  });

  pi.registerTool({
    name: "pprof_capture",
    label: "Capture pprof",
    description:
      "Capture all/selected Go pprof profiles, run go tool pprof for every supported sample index, save top files, and return markdown tables plus structured data.",
    promptSnippet: "Capture and summarize Go pprof profiles from the local pprof port-forward.",
    promptGuidelines: [
      "Use pprof_capture when the user asks to collect pprof data; it returns markdown tables and structured details so the LLM should not parse raw profile bytes.",
    ],
    parameters: CaptureParams,
    async execute(_id, params, _signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "Capturing pprof profiles and generating top tables..." }] });
      const topN = Number(params.topN ?? 10);
      const summary = await captureProfiles(pi, ctx, params);
      return { content: [{ type: "text", text: remember(ctx, summary, topN) }], details: summary };
    },
  });

  pi.registerTool({
    name: "pprof_analyze",
    label: "Analyze pprof directory",
    description:
      "Discover pprof files in a pprof-data directory, select latest/canonical files, run top for all supported sample indices, and return markdown tables plus structured data.",
    promptSnippet: "Analyze saved Go pprof .out/.pb.gz files and produce top-N tables for all sample indices.",
    promptGuidelines: ["Use pprof_analyze for existing pprof-data/pprof-* directories; do not ask the LLM to parse pprof files manually."],
    parameters: AnalyzeParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const topN = Number(params.topN ?? 10);
      const summary = await analyzeDir(pi, ctx, params.dir, topN, Boolean(params.allFiles));
      return { content: [{ type: "text", text: remember(ctx, summary, topN) }], details: summary };
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
      const candidate = await loadCategory(ctx, params.candidateDir, category, topN);
      if (!base.length || !candidate.length) throw new Error(`Missing top files for ${category}. Run pprof_analyze on both directories first.`);
      return {
        content: [{ type: "text", text: `### ${category} comparison\n\n${compareRows(base, candidate, topN)}` }],
        details: { category, baselineDir: params.baselineDir, candidateDir: params.candidateDir },
      };
    },
  });

  pi.registerCommand("pprof-capture", {
    description: "Capture all pprof profiles and render tables: /pprof-capture [name]",
    handler: async (args, ctx) => {
      const summary = await captureProfiles(pi, ctx, { kind: "all", name: args.trim() || undefined, seconds: 15, topN: 10 });
      pi.sendMessage({ customType: "pprof-summary", content: remember(ctx, summary, 10), display: true, details: summary });
    },
  });

  pi.registerCommand("pprof-analyze", {
    description: "Analyze pprof directory and render tables, or clear legacy widget: /pprof-analyze <dir>|off",
    handler: async (args, ctx) => {
      const value = args.trim();
      if (["off", "clear", "hide"].includes(value.toLowerCase())) {
        clearLegacyUi(ctx);
        ctx.ui.notify("pprof widgets are disabled; rendering is table-only", "info");
        return;
      }
      if (!value) return ctx.ui.notify("Usage: /pprof-analyze <dir> or /pprof-analyze off", "warning");

      const summary = await analyzeDir(pi, ctx, value, 10);
      pi.sendMessage({ customType: "pprof-summary", content: remember(ctx, summary, 10), display: true, details: summary });
    },
  });

  pi.registerCommand("pprof-widget", {
    description: "Clear any legacy pprof widget: /pprof-widget off",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (!value || ["off", "clear", "hide"].includes(value)) {
        clearLegacyUi(ctx);
        ctx.ui.notify("pprof widgets are disabled; rendering is table-only", "info");
        return;
      }
      ctx.ui.notify("Usage: /pprof-widget off", "warning");
    },
  });
}

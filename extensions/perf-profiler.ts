import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AnalyzeParams, CaptureParams, CompareParams } from "./pprof/schemas";
import { compareRows, loadCategory } from "./pprof/compare";
import { analyzeDir, captureProfiles } from "./pprof/pprof";
import { clearWidget, markdownForSummary, setWidget } from "./pprof/render";

export default function perfProfilerExtension(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => ctx.ui.setStatus("pprof", "pprof: ready"));

  pi.registerTool({
    name: "pprof_capture",
    label: "Capture pprof",
    description:
      "Capture all/selected Go pprof profiles, run go tool pprof for every useful sample index, save top files, and show a top-N widget.",
    promptSnippet: "Capture and summarize Go pprof profiles from the local pprof port-forward.",
    promptGuidelines: [
      "Use pprof_capture when the user asks to collect pprof data; it returns structured tables so the LLM should not parse raw profile bytes.",
    ],
    parameters: CaptureParams,
    async execute(_id, params, _signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "Capturing pprof profiles and generating top tables..." }] });
      const topN = Number(params.topN ?? 10);
      const summary = await captureProfiles(pi, ctx, params);
      setWidget(ctx, summary, Math.min(5, topN));
      return { content: [{ type: "text", text: markdownForSummary(ctx, summary, topN) }], details: summary };
    },
  });

  pi.registerTool({
    name: "pprof_analyze",
    label: "Analyze pprof directory",
    description:
      "Discover pprof files in a pprof-data directory, select latest/canonical files, run top for all supported sample indices, and return structured tables.",
    promptSnippet: "Analyze saved Go pprof .out/.pb.gz files and produce top-N tables for all sample indices.",
    promptGuidelines: ["Use pprof_analyze for existing pprof-data/pprof-* directories; do not ask the LLM to parse pprof files manually."],
    parameters: AnalyzeParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const topN = Number(params.topN ?? 10);
      const summary = await analyzeDir(pi, ctx, params.dir, topN, Boolean(params.allFiles));
      setWidget(ctx, summary, Math.min(5, topN));
      return { content: [{ type: "text", text: markdownForSummary(ctx, summary, topN) }], details: summary };
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
    description: "Capture all pprof profiles: /pprof-capture [name]",
    handler: async (args, ctx) => {
      const summary = await captureProfiles(pi, ctx, { kind: "all", name: args.trim() || undefined, seconds: 15, topN: 10 });
      setWidget(ctx, summary, 5);
      pi.sendMessage({ customType: "pprof-summary", content: markdownForSummary(ctx, summary, 10), display: true, details: summary });
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

      const summary = await analyzeDir(pi, ctx, value, 10);
      setWidget(ctx, summary, 5);
      pi.sendMessage({ customType: "pprof-summary", content: markdownForSummary(ctx, summary, 10), display: true, details: summary });
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

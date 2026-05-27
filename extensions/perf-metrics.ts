import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type HotFunction = { name: string; cpuPercent: number };
type CustomMetric = { name: string; value: number | string; unit?: string; status?: "ok" | "warn" | "bad" };

type PerfSnapshot = {
  source: "mock";
  updatedAt: number;
  cpuPercent: number;
  rssMb: number;
  goroutines: number;
  requestsPerSecond: number;
  latencyMs: { p50: number; p95: number; p99: number };
  allocMbPerSecond: number;
  gcPauseP95Ms: number;
  hotFunctions: HotFunction[];

  // Mock shapes that match common Go/k6/pprof data we can wire to real sources later.
  heap: { allocMb: number; sysMb: number; objectsK: number; nextGcMb: number };
  gc: { cycles: number; pauseP95Ms: number; cpuFractionPercent: number };
  k6: { vus: number; rps: number; failedPct: number; checksPct: number };
  pprof: {
    cpuTop: HotFunction[];
    allocTop: Array<{ name: string; mb: number }>;
    blockTop: Array<{ name: string; ms: number }>;
  };
  customMetrics: CustomMetric[];
};

type PerfState = {
  enabled: boolean;
  intervalMs: number;
  snapshot: PerfSnapshot;
  lastError?: string;
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function jitter(previous: number, min: number, max: number, delta: number): number {
  return Math.round(clamp(previous + (Math.random() * 2 - 1) * delta, min, max));
}

function makeInitialSnapshot(): PerfSnapshot {
  const hotFunctions = [
    { name: "api.(*Handler).ServeHTTP", cpuPercent: 24 },
    { name: "store.(*Repo).FindByID", cpuPercent: 13 },
    { name: "encoding/json.Marshal", cpuPercent: 8 },
  ];

  return {
    source: "mock",
    updatedAt: Date.now(),
    cpuPercent: 38,
    rssMb: 420,
    goroutines: 96,
    requestsPerSecond: 180,
    latencyMs: { p50: 14, p95: 74, p99: 180 },
    allocMbPerSecond: 28,
    gcPauseP95Ms: 2.4,
    hotFunctions,
    heap: { allocMb: 220, sysMb: 640, objectsK: 84, nextGcMb: 420 },
    gc: { cycles: 141, pauseP95Ms: 2.4, cpuFractionPercent: 0.8 },
    k6: { vus: 16, rps: 180, failedPct: 0.1, checksPct: 99.8 },
    pprof: {
      cpuTop: hotFunctions,
      allocTop: [
        { name: "encoding/json.Marshal", mb: 42 },
        { name: "runtime.makeslice", mb: 18 },
      ],
      blockTop: [
        { name: "database/sql.(*DB).conn", ms: 35 },
        { name: "sync.(*Mutex).Lock", ms: 12 },
      ],
    },
    customMetrics: [
      { name: "queue", value: 12, unit: "jobs", status: "ok" },
      { name: "db", value: 8, unit: "conns", status: "ok" },
      { name: "cache", value: 92, unit: "%", status: "ok" },
    ],
  };
}

async function collectMockSnapshot(previous: PerfSnapshot): Promise<PerfSnapshot> {
  const p50 = jitter(previous.latencyMs.p50, 6, 45, 5);
  const p95 = Math.max(p50 + 20, jitter(previous.latencyMs.p95, 35, 220, 18));
  const p99 = Math.max(p95 + 35, jitter(previous.latencyMs.p99, 90, 650, 45));

  const hotCandidates = [
    "api.(*Handler).ServeHTTP",
    "store.(*Repo).FindByID",
    "encoding/json.Marshal",
    "runtime.mallocgc",
    "net/http.(*conn).serve",
    "db.(*Pool).Acquire",
  ];

  const hotFunctions = hotCandidates
    .map((name, index) => ({
      name,
      cpuPercent: clamp(Math.round((previous.hotFunctions[index]?.cpuPercent ?? 6) + (Math.random() * 10 - 4)), 3, index === 0 ? 44 : 24),
    }))
    .sort((a, b) => b.cpuPercent - a.cpuPercent)
    .slice(0, 3);

  const allocMbPerSecond = Math.round(clamp(previous.allocMbPerSecond + (Math.random() * 18 - 8), 1, 260));
  const gcPauseP95Ms = Math.round(clamp(previous.gc.pauseP95Ms + (Math.random() * 1.8 - 0.7), 0.2, 40) * 10) / 10;
  const requestsPerSecond = jitter(previous.requestsPerSecond, 0, 2500, 120);

  return {
    source: "mock",
    updatedAt: Date.now(),
    cpuPercent: jitter(previous.cpuPercent, 5, 96, 12),
    rssMb: jitter(previous.rssMb, 180, 1600, 60),
    goroutines: jitter(previous.goroutines, 20, 900, 35),
    requestsPerSecond,
    latencyMs: { p50, p95, p99 },
    allocMbPerSecond,
    gcPauseP95Ms,
    hotFunctions,
    heap: {
      allocMb: jitter(previous.heap.allocMb, 80, 1400, 55),
      sysMb: jitter(previous.heap.sysMb, 180, 2200, 35),
      objectsK: jitter(previous.heap.objectsK, 10, 900, 45),
      nextGcMb: jitter(previous.heap.nextGcMb, 120, 1800, 40),
    },
    gc: {
      cycles: previous.gc.cycles + Math.round(Math.random() * 2),
      pauseP95Ms: gcPauseP95Ms,
      cpuFractionPercent: Math.round(clamp(previous.gc.cpuFractionPercent + (Math.random() * 0.8 - 0.25), 0.1, 12) * 10) / 10,
    },
    k6: {
      vus: jitter(previous.k6.vus, 1, 300, 8),
      rps: requestsPerSecond,
      failedPct: Math.round(clamp(previous.k6.failedPct + (Math.random() * 0.5 - 0.18), 0, 12) * 10) / 10,
      checksPct: Math.round(clamp(previous.k6.checksPct + (Math.random() * 0.4 - 0.15), 88, 100) * 10) / 10,
    },
    pprof: {
      cpuTop: hotFunctions,
      allocTop: [
        { name: "encoding/json.Marshal", mb: jitter(previous.pprof.allocTop[0]?.mb ?? 42, 4, 260, 18) },
        { name: "runtime.makeslice", mb: jitter(previous.pprof.allocTop[1]?.mb ?? 18, 2, 160, 12) },
      ].sort((a, b) => b.mb - a.mb),
      blockTop: [
        { name: "database/sql.(*DB).conn", ms: jitter(previous.pprof.blockTop[0]?.ms ?? 35, 0, 600, 45) },
        { name: "sync.(*Mutex).Lock", ms: jitter(previous.pprof.blockTop[1]?.ms ?? 12, 0, 220, 20) },
      ].sort((a, b) => b.ms - a.ms),
    },
    customMetrics: [
      { name: "queue", value: jitter(Number(previous.customMetrics[0]?.value ?? 12), 0, 500, 30), unit: "jobs", status: "ok" },
      { name: "db", value: jitter(Number(previous.customMetrics[1]?.value ?? 8), 1, 80, 3), unit: "conns", status: "ok" },
      { name: "cache", value: jitter(Number(previous.customMetrics[2]?.value ?? 92), 50, 100, 5), unit: "%", status: "ok" },
    ],
  };
}

function severity(snapshot: PerfSnapshot): "ok" | "warn" | "bad" {
  if (snapshot.cpuPercent >= 85 || snapshot.latencyMs.p99 >= 450 || snapshot.gc.pauseP95Ms >= 20 || snapshot.k6.failedPct >= 5) return "bad";
  if (snapshot.cpuPercent >= 70 || snapshot.latencyMs.p95 >= 150 || snapshot.gc.pauseP95Ms >= 8 || snapshot.k6.failedPct >= 1) return "warn";
  return "ok";
}

function colorFor(level: "ok" | "warn" | "bad"): "success" | "warning" | "error" {
  return level === "bad" ? "error" : level === "warn" ? "warning" : "success";
}

function padAnsi(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function fit(text: string, width: number): string {
  return padAnsi(truncateToWidth(text, Math.max(1, width)), Math.max(1, width));
}

function metric(label: string, value: string, width: number, theme: ExtensionContext["ui"]["theme"]): string {
  return fit(`${theme.fg("dim", label)} ${theme.fg("text", value)}`, width);
}

function bar(value: number, max: number, width: number, theme: ExtensionContext["ui"]["theme"], color: "success" | "warning" | "error"): string {
  const filled = clamp(Math.round((value / max) * width), 0, width);
  return theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(width - filled));
}

function row(label: string, body: string, theme: ExtensionContext["ui"]["theme"], innerWidth: number): string {
  const labelWidth = 7;
  return fit(theme.fg("muted", label.padEnd(labelWidth)) + body, innerWidth);
}

function boxed(content: string[], title: string, theme: ExtensionContext["ui"]["theme"], width: number): string[] {
  const boxWidth = Math.max(30, Math.min(width, 110));
  const innerWidth = Math.max(1, boxWidth - 4);
  const titleText = ` ${title} `;
  const topRule = "─".repeat(Math.max(0, boxWidth - 3 - visibleWidth(titleText)));
  const border = (text: string) => theme.fg("borderMuted", text);

  return [
    border("╭─") + titleText + border(topRule + "╮"),
    ...content.map((line) => border("│ ") + fit(line, innerWidth) + border(" │")),
    border("╰" + "─".repeat(boxWidth - 2) + "╯"),
  ].map((line) => truncateToWidth(line, Math.max(1, width)));
}

function renderPerfWidget(state: PerfState, theme: ExtensionContext["ui"]["theme"], width: number): string[] {
  const s = state.snapshot;
  const level = severity(s);
  const color = colorFor(level);
  const status = level === "bad" ? "HOT" : level === "warn" ? "WATCH" : "OK";
  const updated = new Date(s.updatedAt).toLocaleTimeString();
  const title = `${theme.fg("accent", "Performance")} ${theme.fg(color, `● ${status}`)} ${theme.fg("dim", `${s.source} ${updated}`)}`;
  const boxWidth = Math.max(30, Math.min(width, 110));
  const innerWidth = Math.max(1, boxWidth - 4);
  const cpuBarWidth = width >= 90 ? 14 : 8;

  const runtime = [
    metric("cpu", `${s.cpuPercent}%`, 8, theme),
    bar(s.cpuPercent, 100, cpuBarWidth, theme, color),
    metric("rss", `${s.rssMb}M`, 10, theme),
    metric("heap", `${s.heap.allocMb}/${s.heap.sysMb}M`, 17, theme),
    metric("gor", String(s.goroutines), 8, theme),
    metric("gc", `${s.gc.pauseP95Ms.toFixed(1)}ms/${s.gc.cpuFractionPercent}%`, 16, theme),
  ].join(" ");

  const traffic = [
    metric("k6", `${s.k6.rps}rps`, 12, theme),
    metric("vus", String(s.k6.vus), 8, theme),
    metric("fail", `${s.k6.failedPct}%`, 10, theme),
    metric("p50", `${s.latencyMs.p50}ms`, 10, theme),
    metric("p95", `${s.latencyMs.p95}ms`, 10, theme),
    metric("p99", `${s.latencyMs.p99}ms`, 10, theme),
    metric("alloc", `${s.allocMbPerSecond}M/s`, 13, theme),
  ].join(" ");

  const cpuTop = s.pprof.cpuTop[0];
  const allocTop = s.pprof.allocTop[0];
  const blockTop = s.pprof.blockTop[0];
  const profiles = [
    cpuTop ? `${theme.fg("dim", "cpu")} ${cpuTop.name} ${theme.fg(color, `${cpuTop.cpuPercent}%`)}` : "",
    allocTop ? `${theme.fg("dim", "alloc")} ${allocTop.name} ${theme.fg("muted", `${allocTop.mb}M`)}` : "",
    blockTop ? `${theme.fg("dim", "block")} ${blockTop.name} ${theme.fg("muted", `${blockTop.ms}ms`)}` : "",
  ].filter(Boolean).join(theme.fg("dim", "  •  "));

  const custom = s.customMetrics
    .map((m) => {
      const mColor = m.status ? colorFor(m.status) : "muted";
      return `${theme.fg("dim", m.name)} ${theme.fg(mColor, `${m.value}${m.unit ?? ""}`)}`;
    })
    .join(theme.fg("dim", "  "));

  const content = [
    row("runtime", runtime, theme, innerWidth),
    row("traffic", traffic, theme, innerWidth),
    row("pprof", profiles, theme, innerWidth),
    row("custom", custom || theme.fg("dim", "no custom metrics"), theme, innerWidth),
  ];

  if (state.lastError) content.splice(1, 0, row("error", theme.fg("error", state.lastError), theme, innerWidth));

  return boxed(content, title, theme, width);
}

function summarizeForAgent(snapshot: PerfSnapshot): string {
  const hot = snapshot.pprof.cpuTop[0];
  const alloc = snapshot.pprof.allocTop[0];
  return [
    `source=${snapshot.source}`,
    `updated=${new Date(snapshot.updatedAt).toISOString()}`,
    `cpu=${snapshot.cpuPercent}%`,
    `rss=${snapshot.rssMb}MB`,
    `heap=${snapshot.heap.allocMb}/${snapshot.heap.sysMb}MB`,
    `goroutines=${snapshot.goroutines}`,
    `k6_rps=${snapshot.k6.rps}`,
    `k6_vus=${snapshot.k6.vus}`,
    `k6_failed=${snapshot.k6.failedPct}%`,
    `latency_ms=p50:${snapshot.latencyMs.p50},p95:${snapshot.latencyMs.p95},p99:${snapshot.latencyMs.p99}`,
    `alloc=${snapshot.allocMbPerSecond}MB/s`,
    `gc_pause_p95=${snapshot.gc.pauseP95Ms}ms`,
    `gc_cpu=${snapshot.gc.cpuFractionPercent}%`,
    hot ? `pprof_cpu_top=${hot.name} (${hot.cpuPercent}% CPU)` : undefined,
    alloc ? `pprof_alloc_top=${alloc.name} (${alloc.mb}MB)` : undefined,
    snapshot.customMetrics.length ? `custom=${snapshot.customMetrics.map((m) => `${m.name}:${m.value}${m.unit ?? ""}`).join(",")}` : undefined,
  ].filter(Boolean).join("; ");
}

export default function perfWidgetExtension(pi: ExtensionAPI) {
  const state: PerfState = { enabled: false, intervalMs: 5_000, snapshot: makeInitialSnapshot() };

  let timer: ReturnType<typeof setInterval> | undefined;
  let activeCtx: ExtensionContext | undefined;
  let collecting = false;

  function paint(ctx = activeCtx): void {
    if (!ctx || !state.enabled) return;
    ctx.ui.setWidget(
      "perf-metrics",
      (_tui, theme) => ({
        render: (width: number) => renderPerfWidget(state, theme, width),
        invalidate: () => {},
      }),
      { placement: "aboveEditor" },
    );
  }

  async function tick(ctx = activeCtx): Promise<void> {
    if (!ctx || !state.enabled || collecting) return;
    collecting = true;
    try {
      state.snapshot = await collectMockSnapshot(state.snapshot);
      state.lastError = undefined;
      paint(ctx);
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      paint(ctx);
    } finally {
      collecting = false;
    }
  }

  function start(ctx: ExtensionContext): void {
    activeCtx = ctx;
    if (timer) clearInterval(timer);
    paint(ctx);
    void tick(ctx);
    timer = setInterval(() => void tick(ctx), state.intervalMs);
  }

  function stop(ctx = activeCtx): void {
    if (timer) clearInterval(timer);
    timer = undefined;
    ctx?.ui.setWidget("perf-metrics", undefined);
  }

  pi.on("session_start", async (_event, ctx) => {
    if (state.enabled) start(ctx);
  });

  pi.on("session_shutdown", async () => stop());

  pi.on("before_agent_start", async () => {
    if (!state.enabled) return;
    return {
      message: {
        customType: "performance-summary",
        display: false,
        content: `Latest performance snapshot: ${summarizeForAgent(state.snapshot)}`,
      },
    };
  });

  pi.registerTool({
    name: "get_performance_snapshot",
    label: "Get Performance Snapshot",
    description: "Return the latest mock performance metrics shown in the performance widget.",
    promptSnippet: "Inspect the latest mock performance metrics from the live Performance widget",
    promptGuidelines: [
      "Use get_performance_snapshot when the user asks about current performance, latency, CPU, memory, heap, goroutines, GC, k6, pprof, RPS, or hot functions.",
    ],
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: `${summarizeForAgent(state.snapshot)}\n\n${JSON.stringify(state.snapshot, null, 2)}` }],
        details: state.snapshot,
      };
    },
  });

  pi.registerCommand("perf-metrics", {
    description: "Control the mock performance metrics widget: on, off, once, status, interval <seconds>",
    handler: async (args, ctx) => {
      const [command, value] = args.trim().split(/\s+/);

      if (!command || command === "status") {
        ctx.ui.notify(`perf-metrics ${state.enabled ? "on" : "off"}, interval ${state.intervalMs / 1000}s, ${summarizeForAgent(state.snapshot)}`, "info");
        return;
      }

      if (command === "on") {
        state.enabled = true;
        start(ctx);
        ctx.ui.notify("Performance widget enabled", "info");
        return;
      }

      if (command === "off") {
        state.enabled = false;
        stop(ctx);
        ctx.ui.notify("Performance widget disabled", "info");
        return;
      }

      if (command === "once") {
        activeCtx = ctx;
        const wasEnabled = state.enabled;
        state.enabled = true;
        await tick(ctx);
        state.enabled = wasEnabled;
        if (!state.enabled) stop(ctx);
        ctx.ui.notify("Performance snapshot refreshed", "info");
        return;
      }

      if (command === "interval") {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds < 1) {
          ctx.ui.notify("Usage: /perf-metrics interval <seconds >= 1>", "error");
          return;
        }
        state.intervalMs = Math.round(seconds * 1000);
        if (state.enabled) start(ctx);
        ctx.ui.notify(`Performance widget interval set to ${seconds}s`, "info");
        return;
      }

      ctx.ui.notify("Usage: /perf-metrics [on|off|once|status|interval <seconds>]", "error");
    },
  });
}

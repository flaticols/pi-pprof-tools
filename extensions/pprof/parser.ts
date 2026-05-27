import type { ProfileKind, TopRow } from "./types";

function pct(input: string): number {
  return Number(input.replace("%", "")) || 0;
}

export function parseTop(text: string, topN: number): { rows: TopRow[]; type?: string; total?: string } {
  const rows: TopRow[] = [];
  const type = text.match(/^Type:\s*(.+)$/m)?.[1]?.trim();
  const total = text.match(/of\s+(.+?)\s+total/m)?.[1]?.trim();

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(\S+)\s+([\d.]+%)\s+([\d.]+%)\s+(\S+)\s+([\d.]+%)\s+(.+?)\s*$/);
    if (!match) continue;
    rows.push({
      flat: match[1],
      flatPct: pct(match[2]),
      sumPct: pct(match[3]),
      cum: match[4],
      cumPct: pct(match[5]),
      name: match[6],
    });
    if (rows.length >= topN) break;
  }

  return { rows, type, total };
}

export function sampleIndices(kind: ProfileKind): string[] {
  switch (kind) {
    case "cpu":
      return ["cpu", "samples"];
    case "heap":
      return ["inuse_space", "inuse_objects", "alloc_space", "alloc_objects"];
    case "allocs":
      return ["alloc_space", "alloc_objects"];
    case "goroutine":
      return ["goroutine"];
    case "mutex":
    case "block":
      return ["delay", "contentions"];
    case "threadcreate":
      return ["threadcreate"];
    default:
      return [kind];
  }
}

export function categoryId(kind: ProfileKind, sampleIndex?: string): string {
  return sampleIndex ? `${kind}:${sampleIndex}` : kind;
}

import { Type } from "typebox";
import { DEFAULT_BASE_URL, PROFILE_KINDS } from "./types";

const KindType = Type.Union([Type.Literal("all"), ...PROFILE_KINDS.map((kind) => Type.Literal(kind))] as any);

export const CaptureParams = Type.Object({
  kind: Type.Optional(KindType),
  name: Type.Optional(Type.String({ description: "Run name suffix used in pprof-data/pprof-<date>-<name>." })),
  seconds: Type.Optional(Type.Number({ description: "CPU profile duration in seconds.", default: 15 })),
  topN: Type.Optional(Type.Number({ description: "Rows per top table/category.", default: 10 })),
  baseUrl: Type.Optional(Type.String({ description: "pprof base URL.", default: DEFAULT_BASE_URL })),
});

export const AnalyzeParams = Type.Object({
  dir: Type.String({ description: "Directory containing pprof files, e.g. pprof-data/pprof-..." }),
  topN: Type.Optional(Type.Number({ description: "Rows per top table/category.", default: 10 })),
  allFiles: Type.Optional(
    Type.Boolean({ description: "Analyze every matching pprof file instead of selected/latest per kind.", default: false }),
  ),
});

export const CompareParams = Type.Object({
  baselineDir: Type.String({ description: "Baseline profile directory." }),
  candidateDir: Type.String({ description: "Candidate profile directory." }),
  category: Type.Optional(Type.String({ description: "Category id to compare, e.g. allocs:alloc_space, heap:inuse_space, cpu." })),
  topN: Type.Optional(Type.Number({ description: "Rows to show.", default: 15 })),
});

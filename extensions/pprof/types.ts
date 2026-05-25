export const DEFAULT_BASE_URL = "http://localhost:6060";
export const RESULT_ROOT = "pprof-data";

export const PROFILE_KINDS = ["cpu", "heap", "allocs", "goroutine", "mutex", "block", "threadcreate"] as const;

export type ProfileKind = (typeof PROFILE_KINDS)[number];
export type CaptureKind = ProfileKind | "all";

export type TopRow = {
  flat: string;
  flatPct: number;
  sumPct: number;
  cum: string;
  cumPct: number;
  name: string;
};

export type TopCategory = {
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

export type RunSummary = {
  dir: string;
  capturedAt: string;
  baseUrl: string;
  selectedFiles: Partial<Record<ProfileKind, string>>;
  availableFiles: Partial<Record<ProfileKind, string[]>>;
  categories: TopCategory[];
};

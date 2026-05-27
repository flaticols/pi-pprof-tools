import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import doExtension from "./do";
import gitExtension from "./git";
import perfProfilerExtension from "./perf-profiler";

export default function piToysExtension(pi: ExtensionAPI) {
  perfProfilerExtension(pi);
  gitExtension(pi);
  doExtension(pi);
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface GitExecOptions {
  cwd: string;
  signal?: AbortSignal;
  timeout?: number;
}

export async function execGit(
  pi: ExtensionAPI,
  args: string[],
  options: GitExecOptions,
): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
  return pi.exec("git", args, {
    cwd: options.cwd,
    signal: options.signal,
    timeout: options.timeout ?? 30_000,
  });
}

export async function gitOk(pi: ExtensionAPI, args: string[], options: GitExecOptions): Promise<boolean> {
  const result = await execGit(pi, args, options);
  return result.code === 0;
}

export async function requireGit(
  pi: ExtensionAPI,
  args: string[],
  options: GitExecOptions,
  description = `git ${args.join(" ")}`,
): Promise<string> {
  const result = await execGit(pi, args, options);
  if (result.code !== 0) {
    throw new Error(`${description} failed\n${result.stderr || result.stdout}`.trim());
  }
  return result.stdout.trim();
}

export async function repoRoot(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<string> {
  return requireGit(pi, ["rev-parse", "--show-toplevel"], { cwd, signal }, "detect git repo root");
}

export async function currentBranch(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<string> {
  return requireGit(pi, ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, signal }, "detect current branch");
}

export async function defaultUpstream(pi: ExtensionAPI, repo: string, signal?: AbortSignal): Promise<string> {
  const originHead = await execGit(pi, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], {
    cwd: repo,
    signal,
  });
  if (originHead.code === 0 && originHead.stdout.trim()) return originHead.stdout.trim();

  const upstream = await execGit(pi, ["rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: repo, signal });
  if (upstream.code === 0 && upstream.stdout.trim()) return upstream.stdout.trim();

  if (await gitOk(pi, ["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"], { cwd: repo, signal })) {
    return "origin/main";
  }
  if (await gitOk(pi, ["show-ref", "--verify", "--quiet", "refs/remotes/origin/master"], { cwd: repo, signal })) {
    return "origin/master";
  }

  throw new Error("Could not detect upstream branch. Expected origin/HEAD, @{upstream}, origin/main, or origin/master.");
}

export async function commandExists(pi: ExtensionAPI, command: string, cwd: string, signal?: AbortSignal): Promise<boolean> {
  const result = await pi.exec("sh", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
    cwd,
    signal,
    timeout: 5_000,
  });
  return result.code === 0;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function trailerBlock(trailers: Record<string, string | undefined>): string {
  return Object.entries(trailers)
    .filter(([, value]) => value && value.trim())
    .map(([key, value]) => `${key}: ${value!.trim()}`)
    .join("\n");
}

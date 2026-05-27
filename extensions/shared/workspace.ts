import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { currentBranch, defaultUpstream, execGit, gitOk, repoRoot, requireGit } from "./git";
import { planFileName, sanitizeBranchName, worktreeDirName } from "./names";
import { setActiveWorkspace, type ActiveWorkspace } from "./state";

export interface PrepareWorkspaceOptions {
  name?: string;
  baseDir?: string;
  upstream?: string;
  createPlan?: boolean;
  setActive?: boolean;
}

export interface PreparedWorkspace extends ActiveWorkspace {
  planPath?: string;
  planRelPath?: string;
  created: boolean;
}

export async function prepareCurrentWorkspace(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  options: { task?: string; upstream?: string; createPlan?: boolean; setActive?: boolean } = {},
): Promise<PreparedWorkspace> {
  const worktreePath = await repoRoot(pi, ctx.cwd, ctx.signal);
  const branch = sanitizeBranchName(await currentBranch(pi, worktreePath, ctx.signal));
  const upstream = options.upstream ?? (await defaultUpstream(pi, worktreePath, ctx.signal));

  let planPath: string | undefined;
  let planRelPath: string | undefined;
  if (options.createPlan) {
    const plan = await createIgnoredPlan(pi, worktreePath, branch, options.task?.trim() || branch, ctx.signal);
    planPath = plan.planPath;
    planRelPath = plan.planRelPath;
  }

  const workspace: PreparedWorkspace = {
    repoRoot: worktreePath,
    worktreePath,
    branch,
    upstream,
    planPath,
    planRelPath,
    created: false,
  };

  if (options.setActive !== false) setActiveWorkspace(workspace);
  return workspace;
}

export async function prepareWorkspace(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  options: PrepareWorkspaceOptions = {},
): Promise<PreparedWorkspace> {
  const sourceRepo = await repoRoot(pi, ctx.cwd, ctx.signal);
  const name = await resolveName(ctx, options.name);
  const branch = sanitizeBranchName(name);
  const baseDir = expandHome(options.baseDir ?? "~/Developer");
  const worktreePath = resolve(baseDir, worktreeDirName(branch));
  const upstream = options.upstream ?? (await defaultUpstream(pi, sourceRepo, ctx.signal));

  await mkdir(baseDir, { recursive: true });
  await fetchIfRemote(pi, sourceRepo, upstream, ctx.signal);

  const exists = await pathExists(worktreePath);
  let created = false;
  if (exists) {
    const isGitWorktree = await gitOk(pi, ["rev-parse", "--is-inside-work-tree"], {
      cwd: worktreePath,
      signal: ctx.signal,
    });
    if (!isGitWorktree) {
      throw new Error(`Target path already exists and is not a git worktree: ${worktreePath}`);
    }
  } else {
    const branchExists = await gitOk(pi, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: sourceRepo,
      signal: ctx.signal,
    });

    const args = branchExists
      ? ["worktree", "add", worktreePath, branch]
      : ["worktree", "add", "-b", branch, worktreePath, upstream];

    const result = await execGit(pi, args, { cwd: sourceRepo, signal: ctx.signal, timeout: 120_000 });
    if (result.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed\n${result.stderr || result.stdout}`.trim());
    }
    created = true;
  }

  let planPath: string | undefined;
  let planRelPath: string | undefined;
  if (options.createPlan) {
    const plan = await createIgnoredPlan(pi, worktreePath, branch, name, ctx.signal);
    planPath = plan.planPath;
    planRelPath = plan.planRelPath;
  }

  const workspace: PreparedWorkspace = {
    repoRoot: sourceRepo,
    worktreePath,
    branch,
    upstream,
    planPath,
    planRelPath,
    created,
  };

  if (options.setActive !== false) setActiveWorkspace(workspace);
  return workspace;
}

async function resolveName(ctx: ExtensionCommandContext, maybeName?: string): Promise<string> {
  if (maybeName?.trim()) return maybeName.trim();
  if (!ctx.hasUI) throw new Error("Workspace name is required in non-interactive mode: /workspace my-task");

  const name = await ctx.ui.input("New workspace", "task or branch name");
  if (!name?.trim()) throw new Error("Workspace creation cancelled: missing name");
  return name.trim();
}

async function fetchIfRemote(pi: ExtensionAPI, sourceRepo: string, upstream: string, signal?: AbortSignal): Promise<void> {
  const remote = upstream.includes("/") ? upstream.split("/")[0] : undefined;
  if (!remote) return;

  const result = await execGit(pi, ["fetch", remote], { cwd: sourceRepo, signal, timeout: 120_000 });
  if (result.code !== 0) {
    throw new Error(`git fetch ${remote} failed\n${result.stderr || result.stdout}`.trim());
  }
}

async function createIgnoredPlan(
  pi: ExtensionAPI,
  worktreePath: string,
  branch: string,
  task: string,
  signal?: AbortSignal,
): Promise<{ planPath: string; planRelPath: string }> {
  const planRelPath = join("docs", "plans", planFileName(branch));
  const planPath = join(worktreePath, planRelPath);

  await mkdir(dirname(planPath), { recursive: true });
  if (!(await pathExists(planPath))) {
    await writeFile(
      planPath,
      `# Plan: ${task}\n\nBranch: \`${branch}\`\n\n- [ ] Brainstorm approach\n- [ ] Inspect relevant code\n- [ ] Break implementation into steps\n- [ ] Define validation/test plan\n`,
      "utf8",
    );
  }

  await excludeFromGitInfo(pi, worktreePath, planRelPath, signal);
  return { planPath, planRelPath };
}

async function excludeFromGitInfo(
  pi: ExtensionAPI,
  worktreePath: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<void> {
  const rawExcludePath = await requireGit(
    pi,
    ["rev-parse", "--git-path", "info/exclude"],
    { cwd: worktreePath, signal },
    "locate git info/exclude",
  );
  const excludePath = isAbsolute(rawExcludePath) ? rawExcludePath : resolve(worktreePath, rawExcludePath);

  await mkdir(dirname(excludePath), { recursive: true });
  let current = "";
  try {
    current = await readFile(excludePath, "utf8");
  } catch {
    current = "";
  }

  const normalized = relativePath.replace(/\\/g, "/");
  const lines = current.split(/\r?\n/).map((line) => line.trim());
  if (!lines.includes(normalized)) {
    await appendFile(excludePath, `${current.endsWith("\n") || current.length === 0 ? "" : "\n"}${normalized}\n`, "utf8");
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

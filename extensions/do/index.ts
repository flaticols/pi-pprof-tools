import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { currentBranch, defaultUpstream, execGit, requireGit } from "../shared/git";
import { sanitizeBranchName } from "../shared/names";
import { prepareCurrentWorkspace, prepareWorkspace, type PreparedWorkspace } from "../shared/workspace";

interface GitContext {
  repoRoot: string;
  branch: string;
  upstream: string;
  isDefaultBranch: boolean;
  isDirty: boolean;
  headMatchesUpstream: boolean;
}

type WorkspaceChoice = "current" | "new" | "cancel";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("do", {
    description: "Use the current task branch or create a styled worktree, then ask Pi to plan first",
    handler: async (args, ctx) => {
      const git = await inspectGitContext(pi, ctx);
      const task = await resolveTask(args.trim(), ctx, git.isDefaultBranch ? undefined : git.branch);
      const choice = await chooseWorkspace(ctx, git);
      if (choice === "cancel") return;

      const workspace =
        choice === "current"
          ? await prepareCurrentWorkspace(pi, ctx, {
              task,
              upstream: git.upstream,
              createPlan: true,
              setActive: true,
            })
          : await prepareWorkspace(pi, ctx, {
              name: await resolveBranchName(pi, ctx, git.repoRoot, task),
              upstream: git.upstream,
              createPlan: true,
              setActive: true,
            });

      startPlanning(pi, ctx, workspace, task);
    },
  });
}

async function inspectGitContext(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<GitContext> {
  const repoRoot = await requireGit(pi, ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd, signal: ctx.signal }, "detect git repo root");
  const branch = await currentBranch(pi, repoRoot, ctx.signal);
  const upstream = await defaultUpstream(pi, repoRoot, ctx.signal);
  const status = await execGit(pi, ["status", "--porcelain"], { cwd: repoRoot, signal: ctx.signal });
  if (status.code !== 0) throw new Error(status.stderr || status.stdout || "git status failed");
  const isDirty = Boolean(status.stdout.trim());

  if (!isDirty) await fetchUpstreamBestEffort(pi, ctx, repoRoot, upstream);

  const head = await revParse(pi, repoRoot, "HEAD", ctx.signal);
  const upstreamHead = await revParse(pi, repoRoot, upstream, ctx.signal);
  const defaultBranch = upstream.replace(/^.*\//, "");

  return {
    repoRoot,
    branch,
    upstream,
    isDefaultBranch: branch === defaultBranch,
    isDirty,
    headMatchesUpstream: Boolean(head && upstreamHead && head === upstreamHead),
  };
}

async function fetchUpstreamBestEffort(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  repoRoot: string,
  upstream: string,
): Promise<void> {
  const remote = upstream.includes("/") ? upstream.split("/")[0] : undefined;
  if (!remote) return;

  const result = await execGit(pi, ["fetch", remote], { cwd: repoRoot, signal: ctx.signal, timeout: 120_000 });
  if (result.code !== 0) {
    ctx.ui.notify(`Could not fetch ${remote}; using local ${upstream} ref for /do workspace choice.`, "warning");
  }
}

async function revParse(pi: ExtensionAPI, cwd: string, rev: string, signal?: AbortSignal): Promise<string | undefined> {
  const result = await execGit(pi, ["rev-parse", rev], { cwd, signal });
  return result.code === 0 ? result.stdout.trim() : undefined;
}

async function resolveTask(rawTask: string, ctx: ExtensionCommandContext, fallback?: string): Promise<string> {
  if (rawTask) return rawTask;
  if (!ctx.hasUI) {
    if (fallback) return fallback;
    throw new Error("Task description is required in non-interactive mode: /do add-short-description");
  }

  const task = await ctx.ui.input("Task description", fallback ? `describe work (default: ${fallback})` : "what should we work on?");
  const resolved = task?.trim() || fallback;
  if (!resolved) throw new Error("/do cancelled: missing task description");
  return resolved;
}

async function chooseWorkspace(ctx: ExtensionCommandContext, git: GitContext): Promise<WorkspaceChoice> {
  if (git.isDirty) {
    if (git.isDefaultBranch) {
      if (!ctx.hasUI) {
        throw new Error(
          `Current ${git.branch} has uncommitted changes. Commit or stash them, fetch latest ${git.upstream}, then run /do again.`,
        );
      }

      const createNew = await ctx.ui.confirm(
        "Dirty default branch",
        `Current ${git.branch} has uncommitted changes. Commit or stash them before updating it, and fetch latest ${git.upstream} before starting work. Create a new clean worktree from ${git.upstream} instead?`,
      );
      if (createNew) return "new";
      ctx.ui.notify("/do cancelled. Commit or stash changes and fetch latest updates before starting from the default branch.", "warning");
      return "cancel";
    }

    if (!ctx.hasUI) {
      throw new Error(`Current branch ${git.branch} has uncommitted changes. Re-run interactively to choose current branch or a new worktree.`);
    }

    const createNew = await ctx.ui.confirm(
      "Dirty worktree",
      `Current branch ${git.branch} has uncommitted changes. Create a new worktree from ${git.upstream} instead? Choose No to use the current dirty worktree.`,
    );
    return createNew ? "new" : "current";
  }

  if (git.isDefaultBranch) return "new";

  if (git.headMatchesUpstream) {
    if (!ctx.hasUI) return "current";
    const useCurrent = await ctx.ui.confirm(
      "Use current branch?",
      `Current branch ${git.branch} is clean and at the same commit as ${git.upstream}. Use it for this /do task? Choose No to create a new worktree from ${git.upstream}.`,
    );
    return useCurrent ? "current" : "new";
  }

  return "current";
}

async function resolveBranchName(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  repoRoot: string,
  task: string,
): Promise<string> {
  const suggested = await suggestBranchName(pi, repoRoot, task, ctx.signal);
  if (!ctx.hasUI) return suggested;

  const entered = await ctx.ui.input("Branch name", `${suggested} (press Enter to use)`);
  return normalizeBranchInput(entered?.trim() || suggested, suggested);
}

async function suggestBranchName(pi: ExtensionAPI, repoRoot: string, task: string, signal?: AbortSignal): Promise<string> {
  const prefixes = await repoBranchPrefixes(pi, repoRoot, signal);
  const kind = classifyTask(task);
  const prefix = preferredPrefix(kind, prefixes);
  return sanitizeBranchName(`${prefix}/${slugFromTask(task)}`);
}

async function repoBranchPrefixes(pi: ExtensionAPI, repoRoot: string, signal?: AbortSignal): Promise<Map<string, number>> {
  const result = await execGit(
    pi,
    ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"],
    { cwd: repoRoot, signal },
  );
  const counts = new Map<string, number>();
  if (result.code !== 0) return counts;

  for (const raw of result.stdout.split(/\r?\n/)) {
    const branch = raw.trim().replace(/^origin\//, "");
    const prefix = branch.split("/")[0];
    if (COMMON_PREFIXES.includes(prefix)) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  return counts;
}

function classifyTask(task: string): string {
  const text = task.toLowerCase();
  if (/\b(fix|bug|broken|crash|error|failing|regression)\b/.test(text)) return "fix";
  if (/\b(doc|docs|readme|documentation)\b/.test(text)) return "docs";
  if (/\b(test|tests|spec|coverage)\b/.test(text)) return "test";
  if (/\b(refactor|cleanup|clean up)\b/.test(text)) return "refactor";
  if (/\b(perf|performance|pprof|latency|memory|alloc|cpu)\b/.test(text)) return "perf";
  if (/\b(rename|repo|package|release|version|dependency|dependencies|config|tooling)\b/.test(text)) return "chore";
  return "feat";
}

function preferredPrefix(kind: string, prefixes: Map<string, number>): string {
  const aliases: Record<string, string[]> = {
    feat: ["feat", "feature"],
    fix: ["fix", "bugfix"],
    docs: ["docs", "doc"],
    test: ["test", "tests"],
    refactor: ["refactor"],
    perf: ["perf"],
    chore: ["chore"],
  };
  const candidates = aliases[kind] ?? [kind];
  return candidates.sort((a, b) => (prefixes.get(b) ?? 0) - (prefixes.get(a) ?? 0))[0] ?? kind;
}

function normalizeBranchInput(input: string, suggested: string): string {
  const cleaned = sanitizeBranchName(input);
  if (cleaned.includes("/")) return cleaned;
  const prefix = suggested.split("/")[0] || "feat";
  return sanitizeBranchName(`${prefix}/${cleaned}`);
}

function slugFromTask(task: string): string {
  const words = task
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word && !STOP_WORDS.has(word));

  return words.slice(0, 6).join("-") || "work";
}

function startPlanning(pi: ExtensionAPI, ctx: ExtensionCommandContext, workspace: PreparedWorkspace, task: string): void {
  pi.setSessionName(`do: ${workspace.branch}`);
  ctx.ui.setStatus("workspace", `workspace: ${workspace.branch}`);
  ctx.ui.notify(
    `${workspace.created ? "Created" : "Using"} workspace ${workspace.branch} at ${workspace.worktreePath}`,
    "info",
  );

  pi.sendUserMessage(buildPlanningPrompt(workspace, task));
}

function buildPlanningPrompt(workspace: PreparedWorkspace, task: string): string {
  const planPath = workspace.planRelPath ?? "docs/plans/plan.md";

  return `We are starting a new /do task.

Task:
${task}

Workspace:
- Path: ${workspace.worktreePath}
- Branch: ${workspace.branch}
- Upstream base: ${workspace.upstream}
- Plan file: ${planPath}

First, brainstorm and prepare a plan. Do not implement yet unless I explicitly ask.

Required flow:
1. Inspect the codebase from the active workspace as needed.
2. Restate the concrete goal and note any assumptions.
3. Identify constraints, risks, dependencies, and likely files to touch.
4. If the task is ambiguous or risky, ask concise clarifying questions before writing a final plan.
5. Create or update ${planPath} with a checkbox implementation plan.
6. Include validation/test steps as checkboxes.
7. Finish by summarizing the plan and asking whether to proceed.

Rules:
- Treat ${workspace.worktreePath} as the working directory.
- Use repository-relative paths in the plan.
- Do not stage ${planPath}.
- Do not commit ${planPath}.
- Do not commit anything during planning.
- Keep the plan concise but actionable.
- Use Markdown checkboxes: - [ ] ...
`;
}

const COMMON_PREFIXES = [
  "feat",
  "feature",
  "fix",
  "bugfix",
  "chore",
  "docs",
  "doc",
  "refactor",
  "test",
  "tests",
  "perf",
  "ci",
  "build",
];

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "ask",
  "be",
  "can",
  "could",
  "for",
  "from",
  "in",
  "into",
  "it",
  "like",
  "make",
  "need",
  "of",
  "on",
  "or",
  "please",
  "repo",
  "should",
  "that",
  "the",
  "then",
  "this",
  "to",
  "tool",
  "up",
  "use",
  "we",
  "with",
]);

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { isAbsolute, resolve } from "node:path";
import { commandExists, currentBranch, defaultUpstream, execGit, shellQuote, trailerBlock } from "../shared/git";
import { prepareWorkspace } from "../shared/workspace";
import { getActiveWorkspace, setActiveWorkspace } from "../shared/state";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("workspace", {
    description: "Create or activate a git worktree from the upstream branch",
    handler: async (args, ctx) => {
      const workspace = await prepareWorkspace(pi, ctx, {
        name: args.trim() || undefined,
        createPlan: false,
        setActive: true,
      });

      ctx.ui.setStatus("workspace", `workspace: ${workspace.branch}`);
      ctx.ui.notify(
        `${workspace.created ? "Created" : "Activated"} ${workspace.branch} at ${workspace.worktreePath}`,
        "info",
      );
    },
  });

  pi.registerCommand("workspace-current", {
    description: "Show the active git worktree used by extension-routed tools",
    handler: async (_args, ctx) => {
      const active = getActiveWorkspace();
      if (!active) {
        ctx.ui.notify("No active workspace. Run /workspace or /do first.", "warning");
        return;
      }
      ctx.ui.notify(`${active.branch}: ${active.worktreePath}`, "info");
    },
  });

  pi.registerCommand("commit", {
    description: "Create a git commit with optional structured trailers",
    handler: async (args, ctx) => {
      const cwd = activeCwd(ctx);
      const status = await execGit(pi, ["status", "--short"], { cwd, signal: ctx.signal });
      if (status.code !== 0) throw new Error(status.stderr || status.stdout || "git status failed");
      if (!status.stdout.trim()) {
        ctx.ui.notify("No changes to commit.", "warning");
        return;
      }

      const staged = await execGit(pi, ["diff", "--cached", "--name-only"], { cwd, signal: ctx.signal });
      if (staged.code !== 0) throw new Error(staged.stderr || staged.stdout || "git diff --cached failed");
      if (!staged.stdout.trim()) {
        const shouldStage = ctx.hasUI
          ? await ctx.ui.confirm("Stage changes?", "No staged changes. Stage all changes with git add -A?")
          : false;
        if (!shouldStage) return;
        const add = await execGit(pi, ["add", "-A"], { cwd, signal: ctx.signal });
        if (add.code !== 0) throw new Error(add.stderr || add.stdout || "git add failed");
      }

      const subject = args.trim() || (ctx.hasUI ? await ctx.ui.input("Commit subject", "short imperative subject") : undefined);
      if (!subject?.trim()) return;

      const reason = ctx.hasUI ? await ctx.ui.input("Reason trailer", "why this change is needed") : undefined;
      const ticket = ctx.hasUI ? await ctx.ui.input("Ticket trailer", "ABC-123 / #123 / URL") : undefined;
      const testPlan = ctx.hasUI ? await ctx.ui.input("Test-Plan trailer", "tests run or not run") : undefined;
      const trailers = trailerBlock({ Reason: reason, Ticket: ticket, "Test-Plan": testPlan });
      const body = trailers ? `${subject.trim()}\n\n${trailers}` : subject.trim();

      const commit = await execGit(pi, ["commit", "-m", body], { cwd, signal: ctx.signal, timeout: 120_000 });
      if (commit.code !== 0) throw new Error(commit.stderr || commit.stdout || "git commit failed");

      const gitmdApplied = await applyGitmdTrailers(pi, cwd, { reason, ticket, testPlan }, ctx.signal);
      ctx.ui.notify(trailers ? `Committed with requested trailers${gitmdApplied ? " via gitmd" : ""}.` : "Committed.", "info");
    },
  });

  pi.registerCommand("ship", {
    description: "Pre-flight current branch, push it, and create/update a draft PR when gh is available",
    handler: async (_args, ctx) => {
      const cwd = activeCwd(ctx);
      const branch = await currentBranch(pi, cwd, ctx.signal);
      if (["main", "master"].includes(branch)) {
        ctx.ui.notify(`Refusing to ship directly from ${branch}.`, "warning");
        return;
      }

      const upstream = await defaultUpstream(pi, cwd, ctx.signal);
      const commits = await execGit(pi, ["log", "--oneline", `${upstream}..HEAD`], { cwd, signal: ctx.signal });
      if (commits.code !== 0) throw new Error(commits.stderr || commits.stdout || "git log failed");
      if (!commits.stdout.trim()) {
        ctx.ui.notify(`No commits to ship relative to ${upstream}.`, "warning");
        return;
      }

      const status = await execGit(pi, ["status", "--porcelain"], { cwd, signal: ctx.signal });
      if (status.code !== 0) throw new Error(status.stderr || status.stdout || "git status failed");
      if (status.stdout.trim()) {
        const ok = ctx.hasUI
          ? await ctx.ui.confirm("Dirty tree", "There are uncommitted changes. Push current branch anyway?")
          : false;
        if (!ok) return;
      }

      const semtag = await commandExists(pi, "semtag", cwd, ctx.signal);
      const gh = await commandExists(pi, "gh", cwd, ctx.signal);
      const existingPr = gh
        ? await pi.exec("gh", ["pr", "view", "--json", "url", "--jq", ".url"], { cwd, signal: ctx.signal, timeout: 30_000 })
        : undefined;

      const push = await execGit(pi, ["push", "-u", "origin", branch], { cwd, signal: ctx.signal, timeout: 120_000 });
      if (push.code !== 0) throw new Error(push.stderr || push.stdout || "git push failed");

      if (!gh) {
        ctx.ui.notify(`Pushed ${branch}. gh is not available, so no PR was created.`, "info");
        return;
      }

      if (existingPr?.code === 0 && existingPr.stdout.trim()) {
        ctx.ui.notify(`Pushed ${branch}. Existing PR: ${existingPr.stdout.trim()}`, "info");
        return;
      }

      const createPr = ctx.hasUI ? await ctx.ui.confirm("Create draft PR?", `Create a draft PR for ${branch}?`) : false;
      if (!createPr) {
        ctx.ui.notify(`Pushed ${branch}.${semtag ? " semtag is available for release/tag flow." : ""}`, "info");
        return;
      }

      const latestSubject = commits.stdout.trim().split("\n")[0]?.replace(/^[a-f0-9]+\s+/, "") ?? branch;
      const title = (ctx.hasUI ? await ctx.ui.input("PR title", latestSubject) : undefined) || latestSubject;
      const body = ctx.hasUI
        ? await ctx.ui.editor("PR body", `## Summary\n- ${latestSubject}\n\n## Commits\n${commits.stdout
            .trim()
            .split("\n")
            .map((line) => `- ${line}`)
            .join("\n")}\n`)
        : undefined;

      const pr = await pi.exec(
        "gh",
        ["pr", "create", "--draft", "--title", title, "--body", body ?? ""],
        { cwd, signal: ctx.signal, timeout: 120_000 },
      );
      if (pr.code !== 0) throw new Error(pr.stderr || pr.stdout || "gh pr create failed");

      ctx.ui.notify(`Draft PR created for ${branch}.${semtag ? " semtag is available for release/tag flow." : ""}`, "info");
    },
  });

  pi.on("tool_call", (event) => {
    const active = getActiveWorkspace();
    if (!active) return;

    if (isToolCallEventType("bash", event)) {
      event.input.command = `cd ${shellQuote(active.worktreePath)} || exit $?\n${event.input.command}`;
      return;
    }

    const input = event.input as Record<string, unknown>;
    for (const key of ["path", "cwd"]) {
      if (typeof input[key] === "string") input[key] = routePath(active.worktreePath, input[key] as string);
    }
  });

  pi.on("session_start", (_event, ctx) => {
    const active = getActiveWorkspace();
    if (active) ctx.ui.setStatus("workspace", `workspace: ${active.branch}`);
  });

  pi.on("session_shutdown", () => {
    setActiveWorkspace(undefined);
  });
}

async function applyGitmdTrailers(
  pi: ExtensionAPI,
  cwd: string,
  trailers: { reason?: string; ticket?: string; testPlan?: string },
  signal?: AbortSignal,
): Promise<boolean> {
  if (!(await commandExists(pi, "gitmd", cwd, signal))) return false;

  const args = ["add", "HEAD"];
  if (trailers.reason?.trim()) args.push("--reason", trailers.reason.trim());
  if (trailers.ticket?.trim()) args.push("--ticket", trailers.ticket.trim());
  if (trailers.testPlan?.trim()) args.push("--trailer", `Test-Plan=${trailers.testPlan.trim()}`);
  if (args.length === 2) return false;

  const result = await pi.exec("gitmd", args, { cwd, signal, timeout: 120_000 });
  return result.code === 0;
}

function activeCwd(ctx: ExtensionCommandContext): string {
  return getActiveWorkspace()?.worktreePath ?? ctx.cwd;
}

function routePath(worktreePath: string, rawPath: string): string {
  const path = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  if (isAbsolute(path)) return path;
  return resolve(worktreePath, path);
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { prepareWorkspace } from "../shared/workspace";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("do", {
    description: "Create a worktree workspace and prepare a checkbox implementation plan",
    handler: async (args, ctx) => {
      const workspace = await prepareWorkspace(pi, ctx, {
        name: args.trim() || undefined,
        createPlan: true,
        setActive: true,
      });

      pi.setSessionName(`do: ${workspace.branch}`);
      ctx.ui.setStatus("workspace", `workspace: ${workspace.branch}`);
      ctx.ui.notify(
        `${workspace.created ? "Created" : "Activated"} workspace ${workspace.branch}`,
        "info",
      );

      pi.sendUserMessage(buildPlanningPrompt(workspace));
    },
  });
}

function buildPlanningPrompt(workspace: {
  worktreePath: string;
  branch: string;
  upstream: string;
  planPath?: string;
  planRelPath?: string;
}): string {
  const planPath = workspace.planRelPath ?? "docs/plans/plan.md";

  return `We are starting a new task workspace.

Workspace:
- Path: ${workspace.worktreePath}
- Branch: ${workspace.branch}
- Upstream base: ${workspace.upstream}
- Plan file: ${planPath}

First, brainstorm and prepare a plan. Do not implement yet unless I explicitly ask.

Required flow:
1. Inspect the codebase from the active workspace as needed.
2. Identify the goal, constraints, risks, and likely files to touch.
3. If the task is ambiguous, ask concise clarifying questions before writing a final plan.
4. Create or update ${planPath} with a checkbox implementation plan.
5. Include validation/test steps as checkboxes.

Rules:
- Treat ${workspace.worktreePath} as the working directory.
- Do not stage ${planPath}.
- Do not commit ${planPath}.
- Do not commit anything during planning.
- Keep the plan concise but actionable.
- Use Markdown checkboxes: - [ ] ...
`;
}

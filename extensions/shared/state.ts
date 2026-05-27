export interface ActiveWorkspace {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  upstream: string;
  planPath?: string;
}

let activeWorkspace: ActiveWorkspace | undefined;

export function setActiveWorkspace(workspace: ActiveWorkspace | undefined): void {
  activeWorkspace = workspace;
}

export function getActiveWorkspace(): ActiveWorkspace | undefined {
  return activeWorkspace;
}

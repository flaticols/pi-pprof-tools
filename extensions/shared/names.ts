export function sanitizeBranchName(input: string): string {
  const cleaned = input
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/\/+/g, "/")
    .replace(/^-+|-+$/g, "")
    .replace(/\/$/, "");

  return cleaned || "work";
}

export function worktreeDirName(branch: string): string {
  return branch.replace(/[/:]+/g, "-").replace(/^-+|-+$/g, "") || "work";
}

export function planFileName(branch: string): string {
  return `${worktreeDirName(branch)}.md`;
}

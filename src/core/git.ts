import simpleGit, { type SimpleGit } from 'simple-git';
import { join } from 'path';
import { existsSync, rmSync } from 'fs';
import { logger } from '../utils/logger.js';

export interface WorktreeInfo {
  path: string;
  branch: string;
  commitHash: string;
  issueId: string;
}

export function getGit(projectRoot: string): SimpleGit {
  return simpleGit(projectRoot);
}

export function branchName(issueId: string, slug: string): string {
  return `novatree/${issueId}-${slug}`;
}

export function worktreePath(projectRoot: string, issueId: string, slug: string): string {
  return join(projectRoot, '.novatree', 'worktrees', `${issueId}-${slug}`);
}

export async function createWorktree(
  projectRoot: string,
  issueId: string,
  slug: string,
): Promise<WorktreeInfo> {
  const git = getGit(projectRoot);
  const branch = branchName(issueId, slug);
  const wtPath = worktreePath(projectRoot, issueId, slug);

  logger.info('git', `Creating worktree: ${wtPath} on branch ${branch}`);

  await git.raw(['worktree', 'add', wtPath, '-b', branch]);

  const log = await simpleGit(wtPath).log({ maxCount: 1 });
  const commitHash = log.latest?.hash ?? 'unknown';

  return {
    path: wtPath,
    branch,
    commitHash,
    issueId,
  };
}

export async function removeWorktree(
  projectRoot: string,
  issueId: string,
  slug: string,
): Promise<void> {
  const git = getGit(projectRoot);
  const wtPath = worktreePath(projectRoot, issueId, slug);
  const branch = branchName(issueId, slug);

  logger.info('git', `Removing worktree: ${wtPath}`);

  if (existsSync(wtPath)) {
    await git.raw(['worktree', 'remove', wtPath, '--force']);
  }

  try {
    await git.deleteLocalBranch(branch, true);
  } catch {
    logger.warn('git', `Could not delete branch ${branch}`);
  }
}

export async function listWorktrees(projectRoot: string): Promise<WorktreeInfo[]> {
  const git = getGit(projectRoot);
  const result = await git.raw(['worktree', 'list', '--porcelain']);

  const worktrees: WorktreeInfo[] = [];
  const blocks = result.split('\n\n').filter(Boolean);

  for (const block of blocks) {
    const lines = block.split('\n');
    const pathLine = lines.find(l => l.startsWith('worktree '));
    const branchLine = lines.find(l => l.startsWith('branch '));
    const headLine = lines.find(l => l.startsWith('HEAD '));

    if (!pathLine || !branchLine) continue;

    const wtPath = pathLine.replace('worktree ', '');
    const branch = branchLine.replace('branch refs/heads/', '');
    const commitHash = headLine?.replace('HEAD ', '') ?? 'unknown';

    // Only include novatree worktrees
    if (!branch.startsWith('novatree/')) continue;

    const match = branch.match(/^novatree\/(\d+)-/);
    const issueId = match?.[1] ?? 'unknown';

    worktrees.push({ path: wtPath, branch, commitHash, issueId });
  }

  return worktrees;
}

export async function getWorktreeDiff(wtPath: string): Promise<string> {
  const git = simpleGit(wtPath);
  const diff = await git.diff(['HEAD~1..HEAD']);
  if (diff) return diff;
  // If no commits yet beyond the base, show staged + unstaged
  const diffAll = await git.diff();
  const diffStaged = await git.diff(['--staged']);
  return diffStaged + '\n' + diffAll;
}

export async function mergeWorktree(
  projectRoot: string,
  issueId: string,
  slug: string,
): Promise<{ success: boolean; message: string }> {
  const git = getGit(projectRoot);
  const branch = branchName(issueId, slug);

  try {
    await git.merge([branch, '--no-ff', '-m', `Merge ${branch}: issue #${issueId}`]);
    return { success: true, message: `Merged ${branch} to main` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, message };
  }
}

export async function getWorktreeCommits(wtPath: string, count = 10): Promise<string[]> {
  const git = simpleGit(wtPath);
  const log = await git.log({ maxCount: count });
  return log.all.map(c => `${c.hash.substring(0, 7)} ${c.message}`);
}

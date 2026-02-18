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
  return `myratree/${issueId}-${slug}`;
}

export function worktreePath(projectRoot: string, issueId: string, slug: string): string {
  return join(projectRoot, '.myratree', 'worktrees', `${issueId}-${slug}`);
}

export async function createWorktree(
  projectRoot: string,
  issueId: string,
  slug: string,
  baseBranch: string,
): Promise<WorktreeInfo> {
  const git = getGit(projectRoot);
  const branch = branchName(issueId, slug);
  const wtPath = worktreePath(projectRoot, issueId, slug);

  // If worktree already exists on disk, reuse it
  if (existsSync(wtPath)) {
    logger.info('git', `Reusing existing worktree: ${wtPath}`);
    const log = await simpleGit(wtPath).log({ maxCount: 1 });
    return {
      path: wtPath,
      branch,
      commitHash: log.latest?.hash ?? 'unknown',
      issueId,
    };
  }

  // If branch exists but worktree doesn't (stale from previous run), delete the branch first
  try {
    const branches = await git.branchLocal();
    if (branches.all.includes(branch)) {
      logger.info('git', `Deleting stale branch ${branch} before creating worktree`);
      await git.deleteLocalBranch(branch, true);
    }
  } catch {
    // Ignore — branch might not exist, which is fine
  }

  logger.info('git', `Creating worktree: ${wtPath} on branch ${branch} from ${baseBranch}`);

  await git.raw(['worktree', 'add', wtPath, '-b', branch, baseBranch]);

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

    // Only include myratree worktrees
    if (!branch.startsWith('myratree/')) continue;

    const match = branch.match(/^myratree\/(\d+)-/);
    const issueId = match?.[1] ?? 'unknown';

    worktrees.push({ path: wtPath, branch, commitHash, issueId });
  }

  return worktrees;
}

export async function getWorktreeDiff(wtPath: string, baseBranch: string): Promise<string> {
  const git = simpleGit(wtPath);

  // Diff all changes since branching from base branch
  try {
    const mergeBase = (await git.raw(['merge-base', 'HEAD', baseBranch])).trim();
    const diff = await git.diff([`${mergeBase}..HEAD`]);
    if (diff) return diff;
  } catch {
    // merge-base can fail if base branch doesn't exist or no common ancestor
  }

  // Fallback: show staged + unstaged changes
  const diffStaged = await git.diff(['--staged']);
  const diffAll = await git.diff();
  const combined = (diffStaged + '\n' + diffAll).trim();
  return combined || '';
}

export async function ensureCleanBranch(projectRoot: string, baseBranch: string): Promise<{ ok: boolean; error?: string }> {
  const git = getGit(projectRoot);

  const status = await git.status();
  const current = status.current;
  if (current !== baseBranch) {
    return { ok: false, error: `Project root is on branch "${current}", expected "${baseBranch}". Checkout the base branch first.` };
  }

  if (status.modified.length > 0 || status.staged.length > 0 || status.conflicted.length > 0) {
    const dirty = [...status.modified, ...status.staged, ...status.conflicted];
    return { ok: false, error: `Working directory has uncommitted changes: ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ` (+${dirty.length - 5} more)` : ''}. Commit or stash them first.` };
  }

  return { ok: true };
}

export async function mergeWorktree(
  projectRoot: string,
  issueId: string,
  slug: string,
  baseBranch: string,
): Promise<{ success: boolean; message: string }> {
  const git = getGit(projectRoot);
  const branch = branchName(issueId, slug);

  // Verify the branch actually exists
  try {
    const branches = await git.branchLocal();
    if (!branches.all.includes(branch)) {
      return { success: false, message: `Branch ${branch} does not exist. Was this issue already merged or cleaned up?` };
    }
  } catch (err) {
    return { success: false, message: `Failed to check branches: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Ensure base branch is clean before merging
  const check = await ensureCleanBranch(projectRoot, baseBranch);
  if (!check.ok) {
    return { success: false, message: check.error! };
  }

  try {
    await git.merge([branch, '--no-ff', '-m', `Merge #${issueId}: ${slug}`]);

    // Verify the merge commit references the correct branch
    const log = await git.log({ maxCount: 1 });
    const commitMsg = log.latest?.message ?? '';
    if (!commitMsg.includes(`#${issueId}`)) {
      logger.warn('git', `Merge commit message mismatch: expected #${issueId}, got: ${commitMsg}`);
    }

    return { success: true, message: `Merged ${branch} into ${baseBranch} (${log.latest?.hash?.substring(0, 7) ?? '?'})` };
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

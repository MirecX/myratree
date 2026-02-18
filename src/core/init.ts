import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { defaultConfig, saveConfig } from './config.js';

const DEFAULT_MANAGER_SYSTEM_PROMPT = `# Novatree Manager Agent

You are the Manager agent for Novatree. You are a PROJECT MANAGER, not a developer. You do NOT write code yourself.

## Your Role

1. **Chat** with the user about features, bugs, and decisions
2. **Create issues** when work needs to be done
3. **Spawn workers** to implement issues (workers are separate Claude Code instances in git worktrees)
4. **Review and merge** when workers finish

## Critical Rules

- You NEVER implement code yourself. You delegate ALL coding work to worker agents via spawn_worker.
- Do NOT call run_tests or review_diff unless a worker has already been spawned and finished working on that issue.
- Do NOT repeatedly call the same tool. If a tool returns an error, tell the user what went wrong instead of retrying.
- Keep responses concise. Don't ramble or repeat yourself.

## Workflow — ALWAYS follow this order

1. User describes a feature → **discuss it**, ask clarifying questions if needed
2. **Create a spec first** with create_spec — write a detailed specification
3. **Commit the spec** with git_commit so the worktree branch will have it
4. **Then create an issue** with create_issue, referencing the spec file(s)
5. **Then spawn a worker** with spawn_worker (or ask user to confirm first if not in yolo mode)
6. Worker finishes (writes ITHAVEBEENDONE) → call review_diff, then run_tests
7. Tests pass → call merge_issue
8. Tests fail → tell the user, discuss next steps

IMPORTANT: NEVER skip the spec step. NEVER skip committing specs before spawning a worker. The worktree is created from the current branch — if specs aren't committed, the worker won't have them.

## Available Tools

- create_spec(filename, content) - Create/update a spec file in specs/. ALWAYS do this BEFORE create_issue.
- list_specs() - List existing spec files
- git_commit(files, message) - Stage and commit files. MUST commit specs before spawning workers.
- create_issue(title, description, specs, priority) - Create an issue. The "specs" field MUST reference existing spec files.
- delete_issue(issue_id) - Delete an issue and clean up its worktree/branch
- list_issues(filter?) - List current issues
- spawn_worker(issue_id) - Spawn a Claude Code worker in a git worktree (issue must be "open"). Worker runs ASYNCHRONOUSLY — do NOT call review_diff/run_tests/merge right after this. Wait for the worker to finish.
- worker_status(issue_id) - Check worker status and see its output/errors. Use this if the user asks why a worker failed.
- review_diff(issue_id) - View diff (ONLY after worker status is "completed")
- run_tests(issue_id) - Run tests (only when worktree exists and issue is in_progress or review)
- merge_issue(issue_id) - Merge to main and clean up
- read_file(path) - Read a project file

## Behavior

- In yolo mode: act autonomously (create spec → commit → create issue → spawn worker)
- Otherwise: confirm with the user before spawning workers and merging
`;

const DEFAULT_MANAGER_MD = `# Project Knowledge

## Specifications Lookup
(No specs registered yet. Add spec files to the specs/ directory.)

## Architecture Notes
(Not yet documented. The manager will update this as the project develops.)

## Principles
(Not yet defined.)

## Recent Decisions
(None yet.)
`;

export interface InitResult {
  created: string[];
  alreadyExisted: boolean;
}

export function initNovatree(projectRoot: string): InitResult {
  const novatreeDir = join(projectRoot, '.novatree');
  const alreadyExisted = existsSync(novatreeDir);
  const created: string[] = [];

  const dirs = [
    novatreeDir,
    join(novatreeDir, 'issues'),
    join(novatreeDir, 'worktrees'),
    join(projectRoot, 'specs'),
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created.push(dir);
    }
  }

  const configFile = join(novatreeDir, 'config.json');
  if (!existsSync(configFile)) {
    saveConfig(projectRoot, defaultConfig());
    created.push(configFile);
  }

  const managerSystemFile = join(novatreeDir, 'manager-system.md');
  if (!existsSync(managerSystemFile)) {
    writeFileSync(managerSystemFile, DEFAULT_MANAGER_SYSTEM_PROMPT, 'utf-8');
    created.push(managerSystemFile);
  }

  const managerMdFile = join(novatreeDir, 'manager.md');
  if (!existsSync(managerMdFile)) {
    writeFileSync(managerMdFile, DEFAULT_MANAGER_MD, 'utf-8');
    created.push(managerMdFile);
  }

  const historyFile = join(novatreeDir, 'manager-history.jsonl');
  if (!existsSync(historyFile)) {
    writeFileSync(historyFile, '', 'utf-8');
    created.push(historyFile);
  }

  // Ensure .novatree/ is in .gitignore
  const gitignorePath = join(projectRoot, '.gitignore');
  if (existsSync(gitignorePath)) {
    const gitignore = readFileSync(gitignorePath, 'utf-8');
    if (!gitignore.includes('.novatree')) {
      writeFileSync(gitignorePath, gitignore.trimEnd() + '\n.novatree/\n', 'utf-8');
    }
  } else {
    writeFileSync(gitignorePath, '.novatree/\n', 'utf-8');
    created.push(gitignorePath);
  }

  return { created, alreadyExisted };
}

export function resetNovatree(projectRoot: string): string[] {
  const novatreeDir = join(projectRoot, '.novatree');
  const cleared: string[] = [];

  // Remove worktrees via git first
  const worktreesDir = join(novatreeDir, 'worktrees');
  if (existsSync(worktreesDir)) {
    const entries = readdirSync(worktreesDir);
    for (const entry of entries) {
      const wtPath = join(worktreesDir, entry);
      try {
        execSync(`git worktree remove "${wtPath}" --force`, { cwd: projectRoot, stdio: 'ignore' });
      } catch {
        // If git worktree remove fails, just rm the directory
        rmSync(wtPath, { recursive: true, force: true });
      }
      cleared.push(`Removed worktree: ${entry}`);
    }

    // Clean up novatree/* branches
    try {
      const branches = execSync('git branch --list "novatree/*"', { cwd: projectRoot, encoding: 'utf-8' });
      for (const branch of branches.split('\n').filter(Boolean)) {
        const branchName = branch.trim();
        try {
          execSync(`git branch -D "${branchName}"`, { cwd: projectRoot, stdio: 'ignore' });
          cleared.push(`Deleted branch: ${branchName}`);
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  // Clear issues
  const issuesDir = join(novatreeDir, 'issues');
  if (existsSync(issuesDir)) {
    const files = readdirSync(issuesDir);
    for (const f of files) {
      rmSync(join(issuesDir, f));
    }
    if (files.length > 0) cleared.push(`Cleared ${files.length} issue(s)`);
  }

  // Clear history
  const historyPath = join(novatreeDir, 'manager-history.jsonl');
  if (existsSync(historyPath)) {
    writeFileSync(historyPath, '', 'utf-8');
    cleared.push('Cleared manager history');
  }

  // Reset manager.md
  const managerMdPath = join(novatreeDir, 'manager.md');
  if (existsSync(managerMdPath)) {
    writeFileSync(managerMdPath, DEFAULT_MANAGER_MD, 'utf-8');
    cleared.push('Reset manager.md');
  }

  // Reset system prompt (force update to latest)
  const systemPromptPath = join(novatreeDir, 'manager-system.md');
  if (existsSync(systemPromptPath)) {
    rmSync(systemPromptPath);
    cleared.push('Cleared manager-system.md (will be recreated on init)');
  }

  return cleared;
}

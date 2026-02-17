import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { defaultConfig, saveConfig } from './config.js';

const DEFAULT_MANAGER_SYSTEM_PROMPT = `# Novatree Manager Agent

You are the Manager agent for the Novatree project management system. You help the user manage their software project by:

1. **Chatting naturally** about features, bugs, and project decisions
2. **Creating issues** with proper spec references when work needs to be done
3. **Generating effective prompts** for worker agents
4. **Reviewing diffs** critically - running tests, checking code quality
5. **Maintaining project knowledge** in manager.md as living documentation
6. **Managing the development workflow** - spawning workers, merging results

## Available Tools

You have access to the following tools:
- create_issue(title, description, specs, priority) - Create a new issue
- list_issues(filter?) - List current issues
- spawn_worker(issue_id) - Start a worker agent on an issue
- review_diff(issue_id) - Review the diff for a completed issue
- merge_issue(issue_id) - Merge a completed issue to main
- run_tests(worktree_path) - Run tests in a worktree
- update_specs(file, content) - Update a specification file
- read_file(path) - Read a file from the project

## Behavior

- When the user describes a feature, create an issue and offer to spawn a worker
- Reference relevant spec files when creating issues
- Be concise but thorough in reviews
- Update manager.md when significant decisions are made
- In yolo mode: act autonomously. Otherwise: confirm before spawning workers and merging.
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
    const gitignore = require('fs').readFileSync(gitignorePath, 'utf-8') as string;
    if (!gitignore.includes('.novatree')) {
      writeFileSync(gitignorePath, gitignore.trimEnd() + '\n.novatree/\n', 'utf-8');
    }
  } else {
    writeFileSync(gitignorePath, '.novatree/\n', 'utf-8');
    created.push(gitignorePath);
  }

  return { created, alreadyExisted };
}

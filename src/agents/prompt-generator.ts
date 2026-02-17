import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { Issue } from '../issues/parser.js';
import { writeMarkdown } from '../utils/markdown.js';

export function generateWorkerPrompt(
  projectRoot: string,
  issue: Issue,
  worktreePath: string,
  testCommand: string,
): string {
  const lines: string[] = [];
  lines.push(`# Task: ${issue.title}`);
  lines.push('');
  lines.push('## Issue');
  lines.push(`Issue #${issue.id}: ${issue.title}`);
  lines.push(`Status: ${issue.status}`);
  lines.push(`Priority: ${issue.priority}`);
  lines.push('');

  // Inline spec contents
  if (issue.specs.length > 0) {
    lines.push('## Relevant Specs');
    lines.push('');
    for (const spec of issue.specs) {
      const specPath = join(projectRoot, spec);
      if (existsSync(specPath)) {
        const content = readFileSync(specPath, 'utf-8');
        lines.push(`### ${spec}`);
        lines.push('```');
        lines.push(content);
        lines.push('```');
        lines.push('');
      } else {
        lines.push(`### ${spec} (not found)`);
        lines.push('');
      }
    }
  }

  lines.push('## Description');
  lines.push('');
  lines.push(issue.description);
  lines.push('');

  if (issue.acceptanceCriteria.length > 0) {
    lines.push('## Acceptance Criteria');
    lines.push('');
    for (const ac of issue.acceptanceCriteria) {
      lines.push(ac);
    }
    lines.push('');
  }

  lines.push('## Instructions');
  lines.push('');
  lines.push('1. Implement the changes described above.');
  lines.push(`2. Run \`${testCommand}\` to verify your changes.`);
  lines.push('3. Commit your changes with a descriptive message.');
  lines.push(`4. When finished, write the exact text ITHAVEBEENDONE to the end of the issue file at ${join(projectRoot, '.novatree', 'issues', `${issue.id}-${issue.slug}.md`)}`);
  lines.push('5. If you are blocked and cannot proceed, write STATUS: BLOCKED <reason> to the issue file instead.');
  lines.push('');
  lines.push('## Constraints');
  lines.push('');
  lines.push('- Make focused, minimal changes to accomplish the task');
  lines.push('- Follow existing code patterns and conventions');
  lines.push('- Ensure all tests pass before marking complete');
  lines.push('');

  const content = lines.join('\n');
  const promptPath = join(worktreePath, 'prompt.md');
  writeMarkdown(promptPath, content);

  return promptPath;
}

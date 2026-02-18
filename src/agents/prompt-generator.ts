import { existsSync } from 'fs';
import { join } from 'path';
import type { Issue } from '../issues/parser.js';
import { writeMarkdown } from '../utils/markdown.js';

export function generateWorkerPrompt(
  projectRoot: string,
  issue: Issue,
  worktreePath: string,
  _testCommand: string,
): string {
  const hasSpecs = issue.specs.length > 0;
  const lines: string[] = [];

  lines.push(`# ${issue.title}`);
  lines.push('');
  lines.push(`Issue #${issue.id} | Priority: ${issue.priority}`);
  lines.push('');

  if (hasSpecs) {
    // Specs contain the full requirements — just point to them
    lines.push('Specs:');
    for (const spec of issue.specs) {
      const exists = existsSync(join(projectRoot, spec));
      lines.push(`- ${spec}${exists ? '' : ' (NOT FOUND)'}`);
    }
  }

  // Only include description/AC when there are no specs to avoid duplication
  if (!hasSpecs) {
    lines.push(issue.description);
    lines.push('');
    if (issue.acceptanceCriteria.length > 0) {
      lines.push('## Acceptance Criteria');
      for (const ac of issue.acceptanceCriteria) {
        lines.push(ac);
      }
    }
  }

  const content = lines.join('\n');
  const promptPath = join(worktreePath, 'prompt.md');
  writeMarkdown(promptPath, content);

  return promptPath;
}

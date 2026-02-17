export type IssueStatus = 'open' | 'in_progress' | 'review' | 'done' | 'blocked';
export type IssuePriority = 'high' | 'medium' | 'low';

export interface Issue {
  id: string;
  title: string;
  slug: string;
  status: IssueStatus;
  created: string;
  branch: string;
  specs: string[];
  priority: IssuePriority;
  description: string;
  acceptanceCriteria: string[];
  agentLog: AgentLogEntry[];
}

export interface AgentLogEntry {
  timestamp: string;
  agent: string;
  content: string;
}

export function parseIssue(content: string, filename: string): Issue {
  const lines = content.split('\n');

  const title = lines.find(l => l.startsWith('# '))?.replace('# ', '').trim() ?? 'Untitled';

  const extractField = (field: string): string => {
    const line = lines.find(l => l.includes(`**${field}**:`));
    return line?.replace(new RegExp(`.*\\*\\*${field}\\*\\*:\\s*`), '').trim() ?? '';
  };

  const id = extractField('id') || filename.match(/^(\d+)/)?.[1] || '000';
  const status = (extractField('status') || 'open') as IssueStatus;
  const created = extractField('created') || new Date().toISOString();
  const branch = extractField('branch') || '';
  const specsRaw = extractField('specs');
  const specs = specsRaw ? specsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const priority = (extractField('priority') || 'medium') as IssuePriority;

  // Extract slug from filename
  const slug = filename.replace(/^\d+-/, '').replace(/\.md$/, '');

  // Extract description (between ## Description and next ##)
  const descStart = lines.findIndex(l => l.trim() === '## Description');
  const descEnd = lines.findIndex((l, i) => i > descStart && l.startsWith('## '));
  const description = descStart >= 0
    ? lines.slice(descStart + 1, descEnd >= 0 ? descEnd : undefined)
        .join('\n').trim()
    : '';

  // Extract acceptance criteria
  const acStart = lines.findIndex(l => l.trim() === '## Acceptance Criteria');
  const acEnd = lines.findIndex((l, i) => i > acStart && l.startsWith('## '));
  const acceptanceCriteria = acStart >= 0
    ? lines.slice(acStart + 1, acEnd >= 0 ? acEnd : undefined)
        .filter(l => l.trim().startsWith('- ['))
        .map(l => l.trim())
    : [];

  // Extract agent log
  const logStart = lines.findIndex(l => l.trim() === '## Agent Log');
  const agentLog: AgentLogEntry[] = [];
  if (logStart >= 0) {
    let currentEntry: AgentLogEntry | null = null;
    for (let i = logStart + 1; i < lines.length; i++) {
      const headerMatch = lines[i].match(/^### (.+) - (.+)$/);
      if (headerMatch) {
        if (currentEntry) agentLog.push(currentEntry);
        currentEntry = {
          timestamp: headerMatch[1],
          agent: headerMatch[2],
          content: '',
        };
      } else if (currentEntry && lines[i].startsWith('## ')) {
        break;
      } else if (currentEntry) {
        currentEntry.content += lines[i] + '\n';
      }
    }
    if (currentEntry) agentLog.push(currentEntry);
    for (const entry of agentLog) {
      entry.content = entry.content.trim();
    }
  }

  return {
    id, title, slug, status, created, branch, specs,
    priority, description, acceptanceCriteria, agentLog,
  };
}

export function serializeIssue(issue: Issue): string {
  const lines: string[] = [];
  lines.push(`# ${issue.title}`);
  lines.push('');
  lines.push(`- **id**: ${issue.id}`);
  lines.push(`- **status**: ${issue.status}`);
  lines.push(`- **created**: ${issue.created}`);
  lines.push(`- **branch**: ${issue.branch}`);
  lines.push(`- **specs**: ${issue.specs.join(', ')}`);
  lines.push(`- **priority**: ${issue.priority}`);
  lines.push('');
  lines.push('## Description');
  lines.push('');
  lines.push(issue.description);
  lines.push('');
  lines.push('## Acceptance Criteria');
  lines.push('');
  for (const ac of issue.acceptanceCriteria) {
    lines.push(ac.startsWith('- [') ? ac : `- [ ] ${ac}`);
  }
  lines.push('');
  lines.push('## Agent Log');
  lines.push('');
  for (const entry of issue.agentLog) {
    lines.push(`### ${entry.timestamp} - ${entry.agent}`);
    lines.push(entry.content);
    lines.push('');
  }

  return lines.join('\n');
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40);
}
